#!/usr/bin/env python3
"""Narrate lines with Kokoro-82M (Apache-2.0) through MLX, one WAV per line.

The renderer runs on the system Python; this script runs inside the TTS
virtual environment described in the tool README:

    .pocket-build/tts/venv/bin/python tools/microts-explainer/tts_kokoro.py \
        --manifest lines.json --voice af_heart --speed 1.0

The manifest is `[{"text": "...", "out": "path.wav"}]`. Existing outputs are
kept, so a re-run only speaks the lines whose text changed.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ESPEAK_LIBRARY = "/opt/homebrew/lib/libespeak-ng.dylib"
ESPEAK_DATA = "/opt/homebrew/share"


def use_system_espeak() -> None:
    """misaki points phonemizer at a wheel whose data path is broken; repoint it."""
    import misaki.espeak  # noqa: F401  (its import sets the wheel paths)
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    if not Path(ESPEAK_LIBRARY).exists():
        raise SystemExit(f"espeak-ng not found at {ESPEAK_LIBRARY}; run `brew install espeak-ng`")
    EspeakWrapper.set_library(ESPEAK_LIBRARY)
    EspeakWrapper.set_data_path(ESPEAK_DATA)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--model", default="prince-canuma/Kokoro-82M")
    args = parser.parse_args()

    jobs = json.loads(Path(args.manifest).read_text())
    pending = [job for job in jobs if not Path(job["out"]).exists()]
    if not pending:
        print("narration cache is complete", file=sys.stderr)
        return

    use_system_espeak()
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    model = load_model(args.model)
    started = time.time()
    for index, job in enumerate(pending, 1):
        segments = list(
            model.generate(text=job["text"], voice=args.voice, speed=args.speed, lang_code="a", verbose=False)
        )
        audio = np.concatenate([segment.audio for segment in segments])
        rate = segments[0].sample_rate
        out = Path(job["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out), audio, rate)
        print(f"{index}/{len(pending)}  {len(audio) / rate:5.2f}s  {job['text'][:58]}", file=sys.stderr)
    print(f"spoke {len(pending)} lines in {time.time() - started:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
