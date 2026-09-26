"""Hand-drawn drawing toolkit for the MicroTS explainer video.

Scene code works in 1920x1080 logical pixels. The canvas draws at SS times that
size and downsamples with Lanczos on export, which is where the antialiasing
comes from.

**Every outline is a wobbled path redrawn from a per-frame seed**, so the ink
boils the way hand-inked animation does, and fills sit a pixel or two off their
outline the way marker sits off a pen line. Text uses Marker Felt with the same
per-frame nudge.
"""
from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont  # noqa: F401  (Image re-exported)

ROOT = Path(__file__).resolve().parents[2]
WIDTH, HEIGHT = 1920, 1080
SS = 2

# Paper and marker palette. The accents are the site's brand hues pulled down
# for ink on cream (site/assets/tokens.css).
BG = "#f4ecdd"
BG2 = "#eadfcb"
PANEL = "#fffaf0"
PANEL2 = "#f2e7d5"
TERM = "#fffdf6"
INK = "#2b2622"
INK2 = "#5d5348"
MUTED = "#988b7b"
OUTLINE = "#2b2622"
YELLOW = "#f5c344"
AMBER = "#e39a2c"
PINK = "#ec5b8d"
PINK2 = "#f386ac"
CYAN = "#2fa9cc"
PURPLE = "#8064cc"
GREEN = "#4da065"
RED = "#dc4b38"
ORANGE = "#f0772b"
RUST = "#cf4a17"
TS_BLUE = "#2f74c0"
JS_YELLOW = "#e7c52c"

FONT_DIR = ROOT / "assets" / "fonts"
MONO = FONT_DIR / "JetBrainsMono-Regular.ttf"
HAND_CANDIDATES = [
    ("/System/Library/Fonts/Supplemental/MarkerFelt.ttc", 1),
    ("/System/Library/Fonts/Supplemental/Noteworthy.ttc", 1),
    ("/System/Library/Fonts/Supplemental/Comic Sans MS Bold.ttf", 0),
]
HAND_LIGHT_CANDIDATES = [
    ("/System/Library/Fonts/Supplemental/Noteworthy.ttc", 0),
    ("/System/Library/Fonts/Supplemental/MarkerFelt.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Comic Sans MS.ttf", 0),
]
CJK_CANDIDATES = [
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 2),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
]

_font_cache: dict = {}


def _pick(candidates):
    for path, index in candidates:
        if Path(path).exists():
            return path, index
    raise SystemExit("No hand-lettering font found; expected " + candidates[0][0])


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    """kind: hand, hand-light, mono, cjk. Size is in device pixels."""
    key = (kind, size)
    hit = _font_cache.get(key)
    if hit is not None:
        return hit
    if kind == "mono":
        made = ImageFont.truetype(str(MONO), size)
    elif kind == "cjk":
        path, index = _pick(CJK_CANDIDATES)
        made = ImageFont.truetype(path, size, index=index)
    else:
        path, index = _pick(HAND_LIGHT_CANDIDATES if kind == "hand-light" else HAND_CANDIDATES)
        made = ImageFont.truetype(path, size, index=index)
    _font_cache[key] = made
    return made


def _run_font(kind: str, is_cjk: bool) -> str:
    return "cjk" if is_cjk else kind


# ---------------------------------------------------------------- color helpers

def rgb(color) -> tuple:
    if isinstance(color, tuple):
        return color[:3]
    text = color.lstrip("#")
    return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t: float) -> tuple:
    ca, cb = rgb(a), rgb(b)
    t = clamp(t, 0.0, 1.0)
    return tuple(round(ca[i] + (cb[i] - ca[i]) * t) for i in range(3))


def shade(color, amount: float) -> tuple:
    return mix(color, "#ffffff" if amount > 0 else "#000000", abs(amount))


# --------------------------------------------------------------- math and easing

def norm(box):
    x0, y0, x1, y1 = box
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if v < lo else hi if v > hi else v


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge1 == edge0:
        return 0.0 if x < edge0 else 1.0
    t = clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3 - 2 * t)


def ease_out_cubic(t: float) -> float:
    t = clamp(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t: float) -> float:
    t = clamp(t)
    return 3 * t * t - 2 * t * t * t


def ease_out_back(t: float, overshoot: float = 1.9) -> float:
    t = clamp(t)
    return 1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2


def ease_out_elastic(t: float) -> float:
    t = clamp(t)
    if t in (0.0, 1.0):
        return t
    return 1 + 2 ** (-9 * t) * math.sin((t * 6.0 - 0.75) * math.pi)


def bounce_in(t: float) -> float:
    return ease_out_back(t, 2.4)


def pulse(t: float, hz: float = 1.0, phase: float = 0.0) -> float:
    return math.sin((t * hz + phase) * math.tau)


def wobble(seed: int, frame: int, amount: float, hold: int = 3) -> tuple:
    r = random.Random((seed * 7919) ^ (frame // hold))
    return (r.uniform(-amount, amount), r.uniform(-amount, amount))


FALLBACK_CHARS = set("\u2192\u2190\u2191\u2193\u2194\u2260\u2248\u2264\u2265\u2713\u2717\u221a\u00d7\u25a0\u25a1\u25cf\u25cb\u2605\u2606")


def cjk_runs(text: str):
    """Split into runs the marker font can draw and runs that need the fallback face."""
    runs = []
    for ch in text:
        is_cjk = (
            "\u2e80" <= ch <= "\u9fff"
            or "\uff00" <= ch <= "\uffef"
            or ch in FALLBACK_CHARS
        )
        if runs and runs[-1][0] == is_cjk:
            runs[-1][1].append(ch)
        else:
            runs.append((is_cjk, [ch]))
    return [(is_cjk, "".join(chunk)) for is_cjk, chunk in runs]


# ------------------------------------------------------------------ paper stock

_paper_cache: dict = {}


def paper(size) -> Image.Image:
    """Cream stock with fibre speckle, drawn once and reused by every frame."""
    hit = _paper_cache.get(size)
    if hit is not None:
        return hit
    sheet = Image.new("RGB", size, rgb(BG))
    d = ImageDraw.Draw(sheet)
    r = random.Random(20260927)
    for _ in range(int(size[0] * size[1] / 5200)):
        x = r.uniform(0, size[0])
        y = r.uniform(0, size[1])
        tone = r.choice([BG2, "#e2d6c0", "#fbf5e9", "#d9ccb4"])
        radius = r.uniform(0.8, 3.4)
        d.ellipse([x - radius, y - radius, x + radius, y + radius], fill=mix(BG, tone, r.uniform(0.35, 0.9)))
    # a soft edge shadow, as if the sheet curls away from the camera
    edge = Image.new("L", size, 0)
    ed = ImageDraw.Draw(edge)
    band = int(min(size) * 0.16)
    for i in range(band):
        value = int(26 * (1 - i / band) ** 2)
        ed.rectangle([i, i, size[0] - i, size[1] - i], outline=value)
    sheet = Image.composite(Image.new("RGB", size, rgb(mix(BG, INK, 0.5))), sheet, edge)
    _paper_cache[size] = sheet
    return sheet


# ------------------------------------------------------------------------ canvas

class Canvas:
    """Logical-pixel surface whose strokes are redrawn by hand every frame."""

    def __init__(self, bg=None, width: int = WIDTH, height: int = HEIGHT, ss: int = SS):
        self.ss = ss
        self.width = width
        self.height = height
        self.img = paper((width * ss, height * ss)).copy() if bg is None else Image.new("RGB", (width * ss, height * ss), rgb(bg))
        self.d = ImageDraw.Draw(self.img)
        self.frame = 0
        self.boil = 3
        self.seq = 0
        self.ox = 0.0
        self.oy = 0.0

    # -- coordinate plumbing
    def shift(self, dx: float, dy: float) -> None:
        self.ox += dx
        self.oy += dy

    def _p(self, x: float, y: float):
        return ((x + self.ox) * self.ss, (y + self.oy) * self.ss)

    def _pts(self, points):
        return [self._p(x, y) for x, y in points]

    def _w(self, width: float) -> int:
        return max(1, round(width * self.ss))

    def rng(self) -> random.Random:
        """A generator that is stable for one shape within one boil step."""
        self.seq += 1
        return random.Random((self.seq * 2654435761) ^ ((self.frame // self.boil) * 40503))

    # -- hand-drawn geometry
    def wiggle(self, points, amp: float, r: random.Random, closed: bool = False, wavelength: float = 120.0):
        """Resample a path and push each sample along its normal by smooth noise."""
        if amp <= 0:
            return list(points)
        path = list(points)
        if closed and path[0] != path[-1]:
            path.append(path[0])
        dense = []
        for i in range(len(path) - 1):
            (x0, y0), (x1, y1) = path[i], path[i + 1]
            span = math.hypot(x1 - x0, y1 - y0)
            steps = max(1, int(span / 13))
            for s in range(steps):
                t = s / steps
                dense.append((lerp(x0, x1, t), lerp(y0, y1, t)))
        dense.append(path[-1])
        total = 0.0
        lengths = [0.0]
        for i in range(len(dense) - 1):
            total += math.hypot(dense[i + 1][0] - dense[i][0], dense[i + 1][1] - dense[i][1])
            lengths.append(total)
        knots = max(2, int(total / wavelength) + 1)
        control = [r.uniform(-1.0, 1.0) for _ in range(knots + 1)]
        if closed:
            control[-1] = control[0]
        out = []
        for i, (x, y) in enumerate(dense):
            k = (lengths[i] / total * knots) if total else 0.0
            base = int(k)
            frac = k - base
            a = control[min(base, knots)]
            b = control[min(base + 1, knots)]
            offset = lerp(a, b, frac * frac * (3 - 2 * frac)) * amp
            nx, ny = 0.0, 0.0
            if i < len(dense) - 1:
                dx, dy = dense[i + 1][0] - x, dense[i + 1][1] - y
            else:
                dx, dy = x - dense[i - 1][0], y - dense[i - 1][1]
            length = math.hypot(dx, dy) or 1.0
            nx, ny = -dy / length, dx / length
            out.append((x + nx * offset, y + ny * offset))
        return out

    def stroke(self, points, color, width: float = 4, closed: bool = False, amp: float = 2.2, passes: int = 2, overshoot: float = 0.0):
        """Ink a path with one or two hand passes."""
        r = self.rng()
        for index in range(max(1, passes)):
            path = self.wiggle(points, amp * (1.0 + 0.5 * index), r, closed)
            if overshoot and not closed and len(path) > 2:
                (x0, y0), (x1, y1) = path[1], path[0]
                d0 = math.hypot(x1 - x0, y1 - y0) or 1
                path[0] = (x1 + (x1 - x0) / d0 * overshoot, y1 + (y1 - y0) / d0 * overshoot)
                (x0, y0), (x1, y1) = path[-2], path[-1]
                d1 = math.hypot(x1 - x0, y1 - y0) or 1
                path[-1] = (x1 + (x1 - x0) / d1 * overshoot, y1 + (y1 - y0) / d1 * overshoot)
            ink = color if index == 0 else mix(color, BG, 0.45)
            line_width = self._w(width if index == 0 else width * 0.55)
            self.d.line(self._pts(path), fill=rgb(ink), width=line_width, joint="curve")
            if index == 0:
                cap = line_width / 2
                for px, py in (self._pts(path)[0], self._pts(path)[-1]):
                    self.d.ellipse([px - cap, py - cap, px + cap, py + cap], fill=rgb(ink))

    def fill_path(self, points, color, slip: float = 3.0, amp: float = 2.6):
        """Marker fill: the same shape, nudged off its outline."""
        r = self.rng()
        dx, dy = r.uniform(-slip, slip), r.uniform(-slip, slip)
        path = [(x + dx, y + dy) for x, y in self.wiggle(points, amp, r, closed=True)]
        self.d.polygon(self._pts(path), fill=rgb(color))

    def shape(self, points, fill=None, outline=None, width: float = 4, amp: float = 2.2, slip: float = 2.5, passes: int = 2):
        if fill is not None:
            self.fill_path(points, fill, slip, amp)
        if outline is not None and width:
            self.stroke(points, outline, width, closed=True, amp=amp, passes=passes)

    # -- primitives, all hand drawn
    def rect(self, box, fill=None, outline=None, width: float = 0):
        self.rrect(box, 0, fill, outline, width)

    def rrect(self, box, radius: float, fill=None, outline=None, width: float = 0, amp: float = 2.2):
        x0, y0, x1, y1 = norm(box)
        radius = max(0.0, min(radius, (x1 - x0) / 2, (y1 - y0) / 2))
        points = []
        corners = (
            (x1 - radius, y1 - radius, 0),
            (x0 + radius, y1 - radius, 90),
            (x0 + radius, y0 + radius, 180),
            (x1 - radius, y0 + radius, 270),
        )
        for cx, cy, start in corners:
            if radius <= 0.5:
                points.append((cx, cy))
                continue
            for step in range(5):
                a = math.radians(start + step * 22.5)
                points.append((cx + math.cos(a) * radius, cy + math.sin(a) * radius))
        self.shape(points, fill, outline, width, amp)

    def ellipse(self, box, fill=None, outline=None, width: float = 0, amp: float = 2.2):
        x0, y0, x1, y1 = norm(box)
        rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
        cx, cy = x0 + rx, y0 + ry
        steps = max(12, int((rx + ry) / 6))
        points = [
            (cx + math.cos(i / steps * math.tau) * rx, cy + math.sin(i / steps * math.tau) * ry)
            for i in range(steps)
        ]
        self.shape(points, fill, outline, width, amp)

    def circle(self, xy, r: float, fill=None, outline=None, width: float = 0, amp: float = 2.0):
        x, y = xy
        self.ellipse((x - r, y - r, x + r, y + r), fill, outline, width, amp)

    def poly(self, points, fill=None, outline=None, width: float = 0, amp: float = 2.2):
        self.shape(list(points), fill, outline, width, amp)

    def line(self, points, color, width: float = 3, caps: bool = True, amp: float = 1.8, passes: int = 1):
        self.stroke(list(points), color, width, closed=False, amp=amp, passes=passes)

    def arc(self, box, start: float, end: float, color, width: float = 3):
        x0, y0, x1, y1 = norm(box)
        rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
        cx, cy = x0 + rx, y0 + ry
        steps = max(6, int(abs(end - start) / 8))
        points = [
            (cx + math.cos(math.radians(lerp(start, end, i / steps))) * rx,
             cy + math.sin(math.radians(lerp(start, end, i / steps))) * ry)
            for i in range(steps + 1)
        ]
        self.stroke(points, color, width, amp=1.6, passes=1)

    def curve(self, p0, p1, p2, color, width: float = 3, steps: int = 18):
        points = []
        for i in range(steps + 1):
            t = i / steps
            points.append((
                (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
                (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
            ))
        self.stroke(points, color, width, amp=1.6, passes=1)

    def hatch(self, box, color, spacing: float = 16, angle: float = -38, width: float = 2.4):
        """Pencil shading inside a box."""
        x0, y0, x1, y1 = norm(box)
        step = spacing
        slope = math.tan(math.radians(angle))
        start = x0 - abs(slope) * (y1 - y0)
        i = 0
        while start + i * step < x1 + abs(slope) * (y1 - y0):
            sx = start + i * step
            i += 1
            points = [(sx, y0), (sx + slope * (y1 - y0), y1)]
            clipped = []
            for px, py in points:
                clipped.append((clamp(px, x0, x1), py))
            if clipped[0][0] in (x0, x1) and clipped[1][0] == clipped[0][0]:
                continue
            self.stroke(clipped, color, width, amp=1.2, passes=1)

    def blend(self, color, alpha: float) -> None:
        if alpha <= 0:
            return
        top = Image.new("RGB", self.img.size, rgb(color))
        self.img = Image.blend(self.img, top, clamp(alpha))
        self.d = ImageDraw.Draw(self.img)

    # -- text
    def measure(self, text: str, size: float, kind: str = "hand") -> float:
        px = round(size * self.ss)
        total = 0.0
        for is_cjk, chunk in cjk_runs(text):
            total += font(_run_font(kind, is_cjk), px).getlength(chunk)
        return total / self.ss

    def text(
        self,
        xy,
        text: str,
        size: float,
        color=INK,
        kind: str = "hand",
        anchor: str = "lm",
        stroke: float = 0,
        stroke_fill=PANEL,
        shadow=None,
        shadow_offset=(0, 0),
        jitter: float = 0.8,
    ):
        px = round(size * self.ss)
        width = self.measure(text, size, kind)
        x, y = xy
        if anchor[0] == "m":
            x -= width / 2
        elif anchor[0] == "r":
            x -= width
        vertical = anchor[1] if len(anchor) > 1 else "m"
        pil_anchor = "l" + {"m": "m", "t": "a", "b": "d", "s": "s"}[vertical]
        r = self.rng()
        x += r.uniform(-jitter, jitter)
        y += r.uniform(-jitter, jitter)
        if shadow is not None:
            self._text_runs((x + shadow_offset[0], y + shadow_offset[1]), text, px, shadow, kind, pil_anchor, 0, stroke_fill)
        self._text_runs((x, y), text, px, color, kind, pil_anchor, stroke, stroke_fill)
        return width

    def _text_runs(self, xy, text, px, color, kind, pil_anchor, stroke, stroke_fill):
        x, y = self._p(*xy)
        cursor = x
        for is_cjk, chunk in cjk_runs(text):
            use = font(_run_font(kind, is_cjk), px)
            self.d.text(
                (cursor, y),
                chunk,
                font=use,
                fill=rgb(color),
                anchor=pil_anchor,
                stroke_width=self._w(stroke) if stroke else 0,
                stroke_fill=rgb(stroke_fill),
            )
            cursor += use.getlength(chunk)

    def wrap(self, text: str, size: float, max_width: float, kind: str = "hand"):
        lines: list = []
        current = ""
        tokens: list = []
        for is_cjk, chunk in cjk_runs(text):
            if is_cjk:
                tokens.extend(list(chunk))
            else:
                for i, word in enumerate(chunk.split(" ")):
                    tokens.append((" " if i else "") + word)
        for token in tokens:
            if token in "，。、：；！？)）》」":
                current += token
                continue
            if current and self.measure(current + token, size, kind) > max_width:
                lines.append(current)
                current = token.lstrip(" ")
            else:
                current += token
        if current:
            lines.append(current)
        return lines

    def export(self) -> Image.Image:
        return self.img.resize((self.width, self.height), Image.LANCZOS)


# --------------------------------------------------------------- composite parts

def backdrop(c: Canvas, t: float, tint=BG, grid=True) -> None:
    """Notebook grid and a few drifting pencil dots over the paper stock."""
    if grid:
        step = 96
        color = mix(BG, CYAN, 0.16)
        for i in range(c.width // step + 2):
            x = i * step + 24
            c.d.line([(x * c.ss, 0), (x * c.ss, c.height * c.ss)], fill=rgb(color), width=max(1, c.ss))
        for i in range(c.height // step + 2):
            y = i * step + 20
            c.d.line([(0, y * c.ss), (c.width * c.ss, y * c.ss)], fill=rgb(color), width=max(1, c.ss))
    r = random.Random(4242)
    for i in range(16):
        bx = r.uniform(0, c.width)
        by = r.uniform(0, c.height)
        speed = r.uniform(5, 16)
        size = r.uniform(2.2, 5.0)
        hue = r.choice([YELLOW, PINK, CYAN, PURPLE])
        y = (by - t * speed) % (c.height + 40) - 20
        x = bx + math.sin(t * 0.6 + i) * 10
        c.d.ellipse(
            [(x - size) * c.ss, (y - size) * c.ss, (x + size) * c.ss, (y + size) * c.ss],
            fill=mix(BG, hue, 0.4),
        )


def sparkle(c: Canvas, xy, r: float, color=YELLOW, spin: float = 0.0) -> None:
    x, y = xy
    for i in range(2):
        a = spin + i * math.pi / 2
        c.stroke(
            [(x - math.cos(a) * r, y - math.sin(a) * r), (x + math.cos(a) * r, y + math.sin(a) * r)],
            color,
            max(1.6, r * 0.28),
            amp=0.8,
            passes=1,
        )


def burst(c: Canvas, xy, t: float, dur: float = 0.55, count: int = 10, color=YELLOW, spread: float = 150) -> None:
    if t < 0 or t > dur:
        return
    k = clamp(t / dur)
    r = random.Random(hash(xy) & 0xFFFF)
    for i in range(count):
        a = i / count * math.tau + r.uniform(-0.2, 0.2)
        near = spread * ease_out_cubic(k) * r.uniform(0.45, 0.8)
        far = spread * ease_out_cubic(k) * r.uniform(0.9, 1.25)
        if far - near < 4:
            continue
        width = lerp(5.5, 1.2, k)
        c.stroke(
            [(xy[0] + math.cos(a) * near, xy[1] + math.sin(a) * near),
             (xy[0] + math.cos(a) * far, xy[1] + math.sin(a) * far)],
            color if i % 3 else mix(color, INK, 0.3),
            width,
            amp=1.0,
            passes=1,
        )


def plate(
    c: Canvas,
    box,
    radius: float = 26,
    fill=PANEL,
    outline=None,
    width: float = 4,
    shadow: float = 10,
    accent=None,
) -> None:
    """Card on the page: a soft offset shadow, an inked edge, an accent stripe."""
    x0, y0, x1, y1 = norm(box)
    if shadow:
        c.rrect((x0 + shadow * 0.5, y0 + shadow, x1 + shadow * 0.5, y1 + shadow), radius, fill=mix(BG, INK, 0.16))
    c.rrect(box, radius, fill=fill, outline=outline or INK, width=width)
    if accent:
        c.rrect((x0 + 12, y0 + 14, x0 + 22, y1 - 14), 5, fill=accent)


def badge(c: Canvas, xy, text: str, size: float = 30, fill=YELLOW, ink=INK, pad: float = 18, kind="hand", radius=None):
    """Marker pill. Returns its box."""
    w = c.measure(text, size, kind) + pad * 2
    h = size * 1.78
    x, y = xy
    box = (x - w / 2, y - h / 2, x + w / 2, y + h / 2)
    c.rrect(box, radius if radius is not None else h / 2, fill=fill, outline=INK, width=3.2)
    c.text((x, y + size * 0.04), text, size, ink, kind, anchor="mm")
    return box


def stamp(c: Canvas, xy, text: str, t: float, size: float = 46, fill=PINK, ink=PANEL, angle: float = -8):
    """Marker stamp that thumps down onto the page."""
    if t < 0:
        return
    k = clamp(t / 0.28)
    scale = lerp(2.3, 1.0, ease_out_cubic(k)) if k < 1 else 1.0
    if t > 0.28:
        scale = 1 + 0.04 * math.exp(-(t - 0.28) * 8) * math.sin((t - 0.28) * 40)
    w = c.measure(text, size, "hand") + 52
    h = size * 1.95
    layer = Image.new("RGBA", (round(w * c.ss * 2.6), round(h * c.ss * 2.6)), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    cx, cy = layer.size[0] / 2, layer.size[1] / 2
    bw, bh = w * c.ss, h * c.ss
    r = random.Random(7 ^ (c.frame // c.boil))
    pts = []
    for i, (px, py) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        pts.append((cx + px * bw / 2 + r.uniform(-6, 6) * c.ss, cy + py * bh / 2 + r.uniform(-5, 5) * c.ss))
    ld.polygon(pts, fill=rgb(fill) + (255,))
    ld.line(pts + [pts[0]], fill=rgb(INK) + (255,), width=max(1, round(3.4 * c.ss)), joint="curve")
    px_size = round(size * c.ss)
    cursor = cx - c.measure(text, size, "hand") * c.ss / 2
    for is_cjk, chunk in cjk_runs(text):
        use = font(_run_font("hand", is_cjk), px_size)
        ld.text((cursor, cy), chunk, font=use, fill=rgb(ink) + (255,), anchor="lm")
        cursor += use.getlength(chunk)
    layer = layer.rotate(angle, resample=Image.BICUBIC, expand=False)
    if scale != 1.0:
        size_px = (max(1, round(layer.size[0] * scale)), max(1, round(layer.size[1] * scale)))
        layer = layer.resize(size_px, Image.BICUBIC)
    px0 = round((xy[0] + c.ox) * c.ss - layer.size[0] / 2)
    py0 = round((xy[1] + c.oy) * c.ss - layer.size[1] / 2)
    c.img.paste(layer, (px0, py0), layer)
    c.d = ImageDraw.Draw(c.img)


def arrow(c: Canvas, p0, p1, color=INK, width: float = 6, head: float = 24, bend: float = 0.0):
    """Sketched arrow: a bent shaft and an open V head."""
    mx = (p0[0] + p1[0]) / 2
    my = (p0[1] + p1[1]) / 2
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy) or 1
    nx, ny = -dy / length, dx / length
    ctrl = (mx + nx * bend, my + ny * bend)
    tip_back = 0.9
    tx = (1 - tip_back) ** 2 * p0[0] + 2 * (1 - tip_back) * tip_back * ctrl[0] + tip_back**2 * p1[0]
    ty = (1 - tip_back) ** 2 * p0[1] + 2 * (1 - tip_back) * tip_back * ctrl[1] + tip_back**2 * p1[1]
    c.curve(p0, ctrl, p1, color, width)
    ang = math.atan2(p1[1] - ty, p1[0] - tx)
    for side in (1, -1):
        a = ang + side * 2.5
        c.stroke([p1, (p1[0] + math.cos(a) * head, p1[1] + math.sin(a) * head)], color, width, amp=0.9, passes=1)


def bubble(c: Canvas, box, text: str, size: float = 34, fill=PANEL, ink=INK, tail=None, radius: float = 28, kind="hand"):
    x0, y0, x1, y1 = norm(box)
    c.rrect((x0 + 7, y0 + 10, x1 + 7, y1 + 10), radius, fill=mix(BG, INK, 0.14))
    if tail:
        ax, ay = tail
        base = ((x0 + x1) / 2, y1 if ay > y1 else y0)
        c.poly([(base[0] - 26, base[1] - 6), (base[0] + 26, base[1] - 6), (ax, ay)], fill=fill, outline=INK, width=3)
    c.rrect(box, radius, fill=fill, outline=INK, width=3.6)
    lines = c.wrap(text, size, (x1 - x0) - 44, kind)
    line_h = size * 1.42
    start = (y0 + y1) / 2 - (len(lines) - 1) * line_h / 2
    for i, line in enumerate(lines):
        c.text(((x0 + x1) / 2, start + i * line_h), line, size, ink, kind, anchor="mm")


# ------------------------------------------------------------------- code cards

KEYWORDS = {
    "import", "from", "export", "const", "let", "function", "return", "async",
    "await", "for", "if", "else", "pub", "trait", "fn", "impl", "self", "mut",
    "struct", "type", "default", "new", "true", "false", "as",
}
TYPES = {
    "i32", "u8", "f64", "bool", "str", "String", "Vec", "number", "string",
    "boolean", "void", "Accessor", "Setter", "Ref", "Cap", "Map", "any",
    "Promise", "i32;", "Option",
}


def token_color(word: str) -> str:
    bare = word.strip("(),;:.<>{}[]=&")
    if word.startswith("//"):
        return MUTED
    if bare in KEYWORDS:
        return PINK
    if bare in TYPES:
        return CYAN
    if word.startswith('"') or word.startswith("'"):
        return GREEN
    if bare.isdigit() or (bare and bare.rstrip("iuf0123456789") == "" and any(ch.isdigit() for ch in bare)):
        return AMBER
    if bare and bare[0].isupper():
        return PURPLE
    return INK2


def code_card(
    c: Canvas,
    box,
    title: str,
    lines,
    size: float = 27,
    reveal: float = 1.0,
    highlight=(),
    accent=YELLOW,
    title_kind="mono",
):
    """A printout taped to the page: ruled card, marker tab, typed code."""
    x0, y0, x1, y1 = norm(box)
    plate(c, box, 20, fill=TERM, outline=INK, width=4, shadow=11)
    tab_w = c.measure(title, size * 0.92, title_kind) + 40
    c.rrect((x0 + 18, y0 - size * 0.8, x0 + 18 + tab_w, y0 + size * 0.72), 12, fill=accent, outline=INK, width=3)
    c.text((x0 + 38, y0 - size * 0.04), title, size * 0.92, INK, title_kind, anchor="lm")
    line_h = size * 1.62
    top = y0 + size * 1.8
    total = sum(len(line) for line in lines) or 1
    budget = total * clamp(reveal)
    for row, line in enumerate(lines):
        y = top + row * line_h
        if y > y1 - line_h * 0.2:
            break
        shown = line
        if budget < len(line):
            shown = line[: max(0, int(budget))]
        budget -= len(line)
        if row in highlight:
            c.rrect((x0 + 20, y - line_h * 0.54, x1 - 20, y + line_h * 0.54), 10, fill=mix(TERM, accent, 0.45))
        indent = len(shown) - len(shown.lstrip(" "))
        cursor = x0 + 40 + indent * size * 0.6
        comment = False
        for word in shown.strip(" ").split(" "):
            if word.startswith("//"):
                comment = True
            color = MUTED if comment else token_color(word)
            cursor += c.text((cursor, y), word + " ", size, color, "mono", anchor="lm", jitter=0.35)
        if budget < 0:
            if (c.frame // 8) % 2 == 0:
                c.rrect((cursor, y - size * 0.6, cursor + size * 0.5, y + size * 0.6), 2, fill=mix(INK, accent, 0.4))
            break


def conveyor(c: Canvas, box, t: float, speed: float = 120, tread: float = 46) -> None:
    x0, y0, x1, y1 = norm(box)
    c.rrect((x0, y0, x1, y1), (y1 - y0) / 2, fill=mix(BG, PURPLE, 0.12), outline=INK, width=3.6)
    offset = (t * speed) % tread
    for i in range(int((x1 - x0) / tread) + 2):
        x = x0 + i * tread - offset
        if x0 + 12 < x < x1 - 12:
            c.stroke([(x, y0 + 9), (x - 12, y1 - 9)], mix(INK, BG, 0.45), 3.4, amp=1.0, passes=1)
    for cx in (x0 + (y1 - y0) / 2, x1 - (y1 - y0) / 2):
        c.circle((cx, (y0 + y1) / 2), (y1 - y0) / 2 - 8, outline=mix(INK, BG, 0.35), width=3)


def chapter_chip(c: Canvas, index: int, title: str) -> None:
    x, y = 62, 66
    w = c.measure(title, 31, "hand") + 118
    c.rrect((x, y - 31, x + w, y + 31), 28, fill=PANEL, outline=INK, width=3.4)
    c.circle((x + 34, y), 21, fill=YELLOW, outline=INK, width=3)
    c.text((x + 34, y + 1), f"{index}", 25, INK, "hand", anchor="mm")
    c.text((x + 66, y + 1), title, 31, INK2, "hand", anchor="lm")


def progress_bar(c: Canvas, done: float) -> None:
    y = c.height - 16
    c.stroke([(40, y), (c.width - 40, y)], mix(BG, INK, 0.22), 4, amp=1.2, passes=1)
    end = 40 + (c.width - 80) * clamp(done)
    if end > 44:
        c.stroke([(40, y), (end, y)], PINK, 7, amp=1.4, passes=1)
        c.circle((end, y), 9, fill=YELLOW, outline=INK, width=3)


def caption(c: Canvas, text: str, appear: float) -> None:
    """Lower-third narration line, lettered by hand on a card."""
    if not text:
        return
    size = 40
    lines = c.wrap(text, size, 1430)
    line_h = size * 1.46
    h = line_h * len(lines) + 44
    w = max(c.measure(line, size) for line in lines) + 96
    k = ease_out_back(clamp(appear / 0.22), 1.5)
    cx = c.width / 2
    cy = c.height - 100 - (h - 92) / 2
    dy = lerp(24, 0, k)
    box = (cx - w / 2, cy - h / 2 + dy, cx + w / 2, cy + h / 2 + dy)
    plate(c, box, 20, fill=PANEL, outline=INK, width=4, shadow=9, accent=YELLOW)
    start = (box[1] + box[3]) / 2 - (len(lines) - 1) * line_h / 2
    for i, line in enumerate(lines):
        c.text((cx + 14, start + i * line_h), line, size, INK, anchor="mm", jitter=0.5)
