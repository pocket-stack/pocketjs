#!/usr/bin/env bash
# make-outro.sh — append a PocketJS-branded, animated end card to a local video.
#
# Renders a dark brand card (logo glyph + wordmark + tagline + url) with headless
# Chrome, then composites it onto the input with a crossfade and a staggered
# text entrance (logo -> tagline -> url, each fades in and eases up). The input's
# primary audio track is preserved and gently faded out under the card; the card
# itself is silent (no voiceover).
#
# Usage:
#   make-outro.sh -i input.mov [-o output.mp4] [--tagline STR] [--brand STR]
#                 [--url STR] [--outro SECS] [--xfade SECS] [--crf N] [--preset P]
#
# Defaults: brand "PocketJS", tagline "Bare Metal Modern Web", url "pocketjs.dev",
# outro 5.5s, xfade 0.8s, crf 18, preset medium. Pass --url "" to hide the url.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML="$SCRIPT_DIR/../assets/outro.html"

IN="" OUT="" BRAND="PocketJS" TAGLINE="Bare Metal Modern Web" URL="pocketjs.dev"
OUTRO=5.5 XFADE=0.8 CRF=18 PRESET=medium
URL_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    -i|--input)   IN="$2"; shift 2;;
    -o|--output)  OUT="$2"; shift 2;;
    --brand)      BRAND="$2"; shift 2;;
    --tagline)    TAGLINE="$2"; shift 2;;
    --url)        URL="$2"; URL_SET=1; shift 2;;
    --outro)      OUTRO="$2"; shift 2;;
    --xfade)      XFADE="$2"; shift 2;;
    --crf)        CRF="$2"; shift 2;;
    --preset)     PRESET="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[ -n "$IN" ] || { echo "error: -i <input> is required" >&2; exit 2; }
[ -f "$IN" ] || { echo "error: input not found: $IN" >&2; exit 2; }
[ -f "$HTML" ] || { echo "error: template missing: $HTML" >&2; exit 2; }
command -v ffmpeg  >/dev/null || { echo "error: ffmpeg not found"  >&2; exit 2; }
command -v ffprobe >/dev/null || { echo "error: ffprobe not found" >&2; exit 2; }

if [ -z "$OUT" ]; then
  dir="$(cd "$(dirname "$IN")" && pwd)"; base="$(basename "$IN")"
  OUT="$dir/${base%.*}_outro.mp4"
fi

# --- locate a Chromium-family browser for headless screenshots ---
CHROME=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  "$(command -v google-chrome 2>/dev/null || true)" \
  "$(command -v chromium 2>/dev/null || true)" \
  "$(command -v chromium-browser 2>/dev/null || true)"; do
  [ -n "$c" ] && [ -x "$c" ] && { CHROME="$c"; break; }
done
[ -n "$CHROME" ] || { echo "error: no Chromium-family browser found for rendering" >&2; exit 2; }

# --- probe the input ---
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of csv=p=0 "$IN" | head -1)
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$IN" | head -1)
RFR=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$IN" | head -1)
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN" | head -1)
NA=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$IN" | wc -l | tr -d ' ')

FPS=$(awk -v r="$RFR" 'BEGIN{n=split(r,a,"/"); if(n==2 && a[2]>0) printf "%.5f", a[1]/a[2]; else printf "%s", r}')
[ -n "$W" ] && [ -n "$H" ] && [ -n "$DUR" ] || { echo "error: could not probe input dimensions/duration" >&2; exit 2; }

# scale = min(W,H)/1080 so type tracks resolution across landscape & portrait
read -r SCALE SLIDE_L SLIDE_T SLIDE_U OFFSET AFADE_ST AFADE_D <<EOF
$(awk -v w="$W" -v h="$H" -v dur="$DUR" -v xf="$XFADE" 'BEGIN{
  m=(w<h?w:h); s=m/1080.0;
  off=dur-xf; if(off<0) off=0;
  # gentle audio fade fully completing at the original end
  afd=xf+0.6; ast=dur-afd; if(ast<0){ast=0; afd=dur}
  printf "%.4f %d %d %d %.3f %.3f %.3f", s, int(24*s+0.5), int(30*s+0.5), int(18*s+0.5), off, ast, afd
}')
EOF

echo "input : ${W}x${H} @ ${FPS}fps  dur=${DUR}s  audio-streams=${NA}"
echo "card  : scale=${SCALE}  outro=${OUTRO}s  xfade=${XFADE}s (offset=${OFFSET}s)"
echo "output: $OUT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/outro.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# --- render the four card layers (bg opaque; text layers transparent) ---
urlenc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$1"; }
QS="scale=${SCALE}&brand=$(urlenc "$BRAND")&tagline=$(urlenc "$TAGLINE")&url=$(urlenc "$URL")"

shot() { # $1=layer
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="${W},${H}" \
    --screenshot="$TMP/l_$1.png" "file://$HTML?layer=$1&$QS" 2>/dev/null
}
for L in bg logo tag url; do shot "$L"; done
echo "rendered card layers (${W}x${H})"

# --- entrance timing: text arrives just as the crossfade settles ---
L0=$(awk -v x="$XFADE" 'BEGIN{v=x-0.1; if(v<0)v=0; printf "%.2f", v}')  # logo
T0=$(awk -v l="$L0" 'BEGIN{printf "%.2f", l+0.35}')                     # tagline
U0=$(awk -v t="$T0" 'BEGIN{printf "%.2f", t+0.60}')                     # url

GRAPH="$TMP/graph.txt"
cat > "$GRAPH" <<EOF
[1:v]scale=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS[bg];
[2:v]fps=${FPS},format=yuva420p,fade=t=in:st=${L0}:d=0.60:alpha=1,setpts=PTS-STARTPTS[lg];
[3:v]fps=${FPS},format=yuva420p,fade=t=in:st=${T0}:d=0.60:alpha=1,setpts=PTS-STARTPTS[tg];
[4:v]fps=${FPS},format=yuva420p,fade=t=in:st=${U0}:d=0.50:alpha=1,setpts=PTS-STARTPTS[ur];
[bg][lg]overlay=x=0:y='${SLIDE_L}*pow(1-clip((t-${L0})/0.60,0,1),3)'[o1];
[o1][tg]overlay=x=0:y='${SLIDE_T}*pow(1-clip((t-${T0})/0.60,0,1),3)'[o2];
[o2][ur]overlay=x=0:y='${SLIDE_U}*pow(1-clip((t-${U0})/0.50,0,1),3)',format=yuv420p,setpts=PTS-STARTPTS[outro];
[0:v]fps=${FPS},scale=${W}:${H},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[main];
[main][outro]xfade=transition=fade:duration=${XFADE}:offset=${OFFSET},format=yuv420p[v];
EOF

MAPS=(-map "[v]")
if [ "$NA" -ge 1 ]; then
  printf '[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=out:st=%s:d=%s,apad,asetpts=PTS-STARTPTS[a]\n' "$AFADE_ST" "$AFADE_D" >> "$GRAPH"
  MAPS+=(-map "[a]" -c:a aac -b:a 192k)
  AUDIO_NOTE="primary audio preserved + faded"
else
  MAPS+=(-an)
  AUDIO_NOTE="no audio track in source (video-only output)"
fi

ffmpeg -y -hide_banner -loglevel error \
  -i "$IN" \
  -loop 1 -t "$OUTRO" -i "$TMP/l_bg.png" \
  -loop 1 -t "$OUTRO" -i "$TMP/l_logo.png" \
  -loop 1 -t "$OUTRO" -i "$TMP/l_tag.png" \
  -loop 1 -t "$OUTRO" -i "$TMP/l_url.png" \
  -filter_complex_script "$GRAPH" \
  "${MAPS[@]}" \
  -c:v libx264 -profile:v high -crf "$CRF" -preset "$PRESET" -pix_fmt yuv420p \
  -movflags +faststart -shortest \
  "$OUT"

OUTDUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | head -1)
echo "done  : $OUT  (${OUTDUR}s, ${AUDIO_NOTE})"
