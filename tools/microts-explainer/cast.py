"""Hand-drawn cast and props for the MicroTS explainer.

Every draw call takes logical center coordinates, a scale where 1.0 is the
reference size noted per character, and the scene clock for idle motion. Shapes
go through the canvas, so they inherit its per-frame ink wobble.
"""
from __future__ import annotations

import math

from stagecraft import (
    AMBER, BG, BG2, CYAN, GREEN, INK, INK2, JS_YELLOW, MUTED, ORANGE, PANEL,
    PANEL2, PINK, PURPLE, RED, RUST, TS_BLUE, YELLOW, Canvas, badge, clamp,
    ease_out_back, ease_out_cubic, lerp, mix, shade, smoothstep, sparkle,
)

SHADOW = mix(BG, INK, 0.16)


def blink_open(t: float, seed: float = 0.0) -> float:
    """1 = open, 0 = shut. Blinks every ~3.1 s, closed for 0.12 s."""
    phase = (t + seed * 1.7) % 3.1
    if phase > 3.0:
        return 0.08
    if phase > 2.94:
        return 0.45
    return 1.0


def _eye(c: Canvas, xy, r: float, open_amount: float, look=(0.0, 0.0), ink=INK, sclera=PANEL):
    x, y = xy
    if open_amount < 0.2:
        c.line([(x - r, y), (x + r, y)], ink, r * 0.42)
        return
    c.ellipse((x - r, y - r * open_amount, x + r, y + r * open_amount), fill=sclera, outline=ink, width=r * 0.2)
    pr = r * 0.5
    c.circle((x + look[0] * r * 0.4, y + look[1] * r * 0.3), pr * open_amount + pr * 0.2, fill=ink)


def _smile(c: Canvas, xy, w: float, h: float, color=INK, width: float = 5, open_mouth: float = 0.0):
    x, y = xy
    if open_mouth > 0.3:
        c.ellipse((x - w * 0.45, y - h * 0.1, x + w * 0.45, y + h * 1.25 * open_mouth), fill=color)
        return
    pts = [(x - w / 2 + w * i / 12, y + math.sin(i / 12 * math.pi) * h) for i in range(13)]
    c.line(pts, color, width)


def ts_buddy(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, mood: str = "happy", look=(0.0, 0.0), arm=0.0):
    """TypeScript mascot. Reference body is 150x150 logical pixels."""
    s = scale
    bob = math.sin(t * 2.1 * math.tau / 3) * 5 * s
    x, y = xy[0], xy[1] + bob
    w = h = 150 * s
    for side in (-1, 1):
        lx = x + side * w * 0.22
        c.line([(lx, y + h * 0.42), (lx, y + h * 0.60)], INK, 9 * s)
        c.ellipse((lx - 20 * s, y + h * 0.56, lx + 20 * s, y + h * 0.70), fill=YELLOW, outline=INK, width=3.4 * s)
    swing = math.sin(t * 2.6) * 0.5
    for side in (-1, 1):
        ax, ay = x + side * w * 0.5, y + h * 0.08
        raised = arm if side > 0 else -arm * 0.35
        ex = ax + side * (36 + 22 * abs(raised)) * s
        ey = ay - (52 * raised + swing * 8) * s
        c.line([(ax, ay), (ex, ey)], INK, 9 * s)
        c.circle((ex, ey), 14 * s, fill=YELLOW, outline=INK, width=3.4 * s)
    c.rrect((x - w / 2 + 7 * s, y - h / 2 + 11 * s, x + w / 2 + 7 * s, y + h / 2 + 11 * s), 34 * s, fill=SHADOW)
    c.rrect((x - w / 2, y - h / 2, x + w / 2, y + h / 2), 34 * s, fill=TS_BLUE, outline=INK, width=5 * s)
    c.rrect((x - w / 2 + 12 * s, y - h / 2 + 12 * s, x + w / 2 - 12 * s, y - h / 2 + 32 * s), 12 * s, fill=mix(TS_BLUE, PANEL, 0.22))
    eye_y = y - h * 0.13
    er = 17 * s
    open_amount = blink_open(t, 0.3) if mood != "surprised" else 1.15
    _eye(c, (x - w * 0.19, eye_y), er, open_amount, look)
    _eye(c, (x + w * 0.19, eye_y), er, open_amount, look)
    if mood == "surprised":
        _smile(c, (x, y + h * 0.06), 30 * s, 14 * s, open_mouth=1.0)
    elif mood == "flat":
        c.line([(x - 16 * s, y + h * 0.10), (x + 16 * s, y + h * 0.10)], INK, 4.5 * s)
    else:
        _smile(c, (x, y + h * 0.04), 46 * s, 15 * s, width=5 * s)
    c.text((x, y + h * 0.31), "TS", 34 * s, PANEL, "hand", anchor="mm")
    if mood == "cheer":
        for i in range(3):
            a = -0.9 + i * 0.9
            sparkle(c, (x + math.cos(a) * w * 0.8, y - h * 0.6 + math.sin(a) * 18 * s), (8 + 3 * math.sin(t * 8 + i)) * s, AMBER, t * 3)


def ferris(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, mood: str = "happy", claw: float = 0.0, look=(0.0, 0.0), bg=BG):
    """Rust crab. Reference shell is 190x120 logical pixels."""
    s = scale
    bob = math.sin(t * 2.6) * 4 * s
    x, y = xy[0], xy[1] + bob
    w, h = 190 * s, 120 * s
    for side in (-1, 1):
        for i in range(3):
            lx = x + side * (w * 0.20 + i * 26 * s)
            step = math.sin(t * 7 + i * 1.5 + (0 if side > 0 else math.pi)) * 7 * s
            c.line([(lx, y + h * 0.28), (lx + side * 14 * s, y + h * 0.56 + step)], RUST, 7 * s)
    for side in (-1, 1):
        cx = x + side * (w * 0.60)
        cy = y - h * 0.10 - claw * 70 * s
        c.line([(x + side * w * 0.42, y + h * 0.02), (cx, cy)], RUST, 10 * s)
        gap = (0.5 + 0.5 * math.sin(t * 5 + side)) * 0.5
        c.ellipse((cx - 30 * s, cy - 26 * s, cx + 30 * s, cy + 26 * s), fill=ORANGE, outline=INK, width=4 * s)
        c.poly(
            [(cx + side * 8 * s, cy - 4 * s),
             (cx + side * 38 * s, cy - (10 + 16 * gap) * s),
             (cx + side * 38 * s, cy + (10 + 16 * gap) * s)],
            fill=bg,
        )
    c.ellipse((x - w / 2 + 6 * s, y - h / 2 + 11 * s, x + w / 2 + 6 * s, y + h / 2 + 11 * s), fill=SHADOW)
    c.ellipse((x - w / 2, y - h / 2, x + w / 2, y + h / 2), fill=ORANGE, outline=INK, width=5 * s)
    c.ellipse((x - w * 0.40, y - h * 0.38, x + w * 0.40, y + h * 0.02), fill=mix(ORANGE, PANEL, 0.22))
    for side in (-1, 1):
        ex = x + side * w * 0.17
        c.line([(ex, y - h * 0.18), (ex, y - h * 0.34)], RUST, 8 * s)
        _eye(c, (ex, y - h * 0.40), 21 * s, blink_open(t, 1.2), look)
    _smile(c, (x, y + h * 0.05), 60 * s, 17 * s, width=5 * s, open_mouth=1.0 if mood == "surprised" else 0.0)
    if mood == "work":
        c.line([(x + w * 0.45, y + h * 0.1), (x + w * 0.78, y - h * 0.25)], MUTED, 9 * s)
        c.circle((x + w * 0.80, y - h * 0.30), 13 * s, fill=PANEL2, outline=INK, width=3.4 * s)


def js_engine(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, strain: float = 0.0, smoke: bool = True):
    """The script engine as heavy machinery. Reference body is 230x190."""
    s = scale
    shiver = strain * math.sin(t * 22) * 3 * s
    x, y = xy[0] + shiver, xy[1] + math.sin(t * 1.6) * 2 * s
    w, h = 230 * s, 190 * s
    body = mix("#9aa3b0", RED, strain * 0.3)
    c.rrect((x + w * 0.16, y - h * 0.72, x + w * 0.34, y - h * 0.44), 8 * s, fill=shade(body, -0.18), outline=INK, width=4 * s)
    if smoke:
        for i in range(4):
            k = (t * 0.7 + i * 0.25) % 1.0
            puff = 14 * s + k * 34 * s
            c.circle(
                (x + w * 0.25 + math.sin(k * 5 + i) * 26 * s, y - h * 0.78 - k * 130 * s),
                puff,
                fill=mix(BG, MUTED, lerp(0.42, 0.04, k)),
            )
    for side in (-1, 1):
        c.rrect((x + side * w * 0.38 - 26 * s, y + h * 0.44, x + side * w * 0.38 + 26 * s, y + h * 0.58), 7 * s, fill=shade(body, -0.3), outline=INK, width=3.4 * s)
    c.rrect((x - w / 2 + 7 * s, y - h / 2 + 11 * s, x + w / 2 + 7 * s, y + h / 2 + 11 * s), 22 * s, fill=SHADOW)
    c.rrect((x - w / 2, y - h / 2, x + w / 2, y + h / 2), 22 * s, fill=body, outline=INK, width=5 * s)
    for sx in (-1, 1):
        for sy in (-1, 1):
            c.circle((x + sx * w * 0.40, y + sy * h * 0.36), 6 * s, fill=shade(body, -0.34))
    pw, ph = w * 0.46, h * 0.30
    c.rrect((x - w * 0.40, y - h * 0.30, x - w * 0.40 + pw, y - h * 0.30 + ph), 6 * s, fill=JS_YELLOW, outline=INK, width=3.6 * s)
    c.text((x - w * 0.40 + pw * 0.5, y - h * 0.30 + ph * 0.56), "JS", 40 * s, INK, "hand", anchor="mm")
    gx, gy, gr = x + w * 0.22, y - h * 0.12, 34 * s
    c.circle((gx, gy), gr, fill=PANEL, outline=INK, width=4 * s)
    needle = lerp(-2.4, -0.6, clamp(strain * 0.8 + 0.2 + 0.08 * math.sin(t * 9)))
    c.line([(gx, gy), (gx + math.cos(needle) * gr * 0.78, gy + math.sin(needle) * gr * 0.78)], RED if strain > 0.4 else CYAN, 5 * s)
    for i in range(4):
        yy = y + h * 0.12 + i * 12 * s
        c.line([(x - w * 0.38, yy), (x + w * 0.10, yy)], shade(body, -0.3), 4 * s)
    for side in (-1, 1):
        _eye(c, (x + side * 26 * s, y + h * 0.30), 13 * s, blink_open(t, 2.1))
    if strain > 0.3:
        for i, side in enumerate((-1, 1)):
            k = (t * 1.6 + i * 0.5) % 1.0
            dx = x + side * w * 0.52
            dy = y - h * 0.34 + k * 90 * s
            c.ellipse((dx - 9 * s, dy - 13 * s, dx + 9 * s, dy + 11 * s), fill=CYAN, outline=INK, width=2.4 * s)


def counter_screen(c: Canvas, box, count: int, focus: bool = True, flash: float = 0.0, pressed: bool = False):
    """The docs counter: one text binding and one focusable button, fitted to `box`."""
    x0, y0, x1, y1 = box
    u = (x1 - x0) / 200.0
    c.rrect(box, 8 * u, fill="#f7f4ff")
    if flash > 0:
        c.rrect((x0 + 10 * u, y0 + 12 * u, x0 + 130 * u, y0 + 44 * u), 5 * u, fill=mix("#f7f4ff", CYAN, flash))
    c.text((x0 + 16 * u, y0 + 28 * u), f"Count: {count}", 21 * u, "#221d3a", "mono", anchor="lm", jitter=0.2)
    bx0, by0 = x0 + 16 * u, y0 + 56 * u
    bx1, by1 = x0 + 128 * u, y0 + 92 * u
    fill = "#1f4fc4" if pressed else ("#3b82f6" if focus else "#7ba7f0")
    c.rrect((bx0, by0, bx1, by1), 8 * u, fill=fill, outline=INK, width=2 * u)
    c.text(((bx0 + bx1) / 2, (by0 + by1) / 2 + u), "ADD ONE", 17 * u, PANEL, "mono", anchor="mm", jitter=0.2)
    if focus:
        c.rrect((bx0 - 5 * u, by0 - 5 * u, bx1 + 5 * u, by1 + 5 * u), 12 * u, outline=PINK, width=3 * u)


def handheld(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, face: bool = False, screen=None, mood: str = "happy"):
    """The PocketJS mark as a little device. Reference shell is 420x290."""
    s = scale
    x, y = xy[0], xy[1] + math.sin(t * 1.9) * 4 * s
    w, h = 420 * s, 290 * s
    if face:
        for side in (-1, 1):
            fx = x + side * w * 0.22
            c.line([(fx, y + h * 0.48), (fx, y + h * 0.60)], INK, 9 * s)
            c.ellipse((fx - 22 * s, y + h * 0.56, fx + 22 * s, y + h * 0.70), fill=YELLOW, outline=INK, width=3.4 * s)
        for side in (-1, 1):
            ax = x + side * w * 0.52
            swing = math.sin(t * 2.4 + side) * 10 * s
            c.line([(x + side * w * 0.48, y - h * 0.06), (ax + side * 30 * s, y + h * 0.02 + swing)], INK, 9 * s)
            c.circle((ax + side * 30 * s, y + h * 0.02 + swing), 13 * s, fill=YELLOW, outline=INK, width=3.4 * s)
    c.rrect((x - w / 2 + 8 * s, y - h / 2 + 12 * s, x + w / 2 + 8 * s, y + h / 2 + 12 * s), 58 * s, fill=SHADOW)
    c.rrect((x - w / 2, y - h / 2, x + w / 2, y + h / 2), 58 * s, fill="#241d3a", outline=YELLOW, width=11 * s)
    c.rrect((x - w / 2 - 6 * s, y - h / 2 - 6 * s, x + w / 2 + 6 * s, y + h / 2 + 6 * s), 62 * s, outline=INK, width=3.4 * s)
    screen_box = (x - w * 0.42, y - h * 0.28, x + w * 0.08, y + h * 0.28)
    c.rrect(screen_box, 12 * s, fill="#171226", outline=mix(INK, CYAN, 0.4), width=3 * s)
    inner = (screen_box[0] + 8 * s, screen_box[1] + 8 * s, screen_box[2] - 8 * s, screen_box[3] - 8 * s)
    if screen:
        screen(c, inner)
    else:
        c.rrect(inner, 9 * s, fill="#120c22")
        fx, fy = (inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2
        if face:
            for side in (-1, 1):
                _eye(c, (fx + side * 38 * s, fy - 12 * s), 19 * s, blink_open(t, 0.8), sclera=CYAN, ink="#0b1a22")
            if mood == "strain":
                c.line([(fx - 30 * s, fy + 32 * s), (fx + 30 * s, fy + 32 * s)], CYAN, 5 * s)
                for i, side in enumerate((-1, 1)):
                    k = (t * 1.4 + i * 0.5) % 1.0
                    sx, sy = fx + side * 70 * s, fy - 28 * s + k * 66 * s
                    c.ellipse((sx - 7 * s, sy - 11 * s, sx + 7 * s, sy + 9 * s), fill=CYAN)
            else:
                _smile(c, (fx, fy + 22 * s), 60 * s, 15 * s, color=CYAN, width=5 * s)
        else:
            c.circle((fx, fy), 22 * s, fill=PINK)
    c.circle((x + w * 0.28, y - h * 0.16), 24 * s, fill=PINK, outline=INK, width=3 * s)
    c.rrect((x + w * 0.16, y + h * 0.02, x + w * 0.40, y + h * 0.10), 9 * s, fill=CYAN, outline=INK, width=3 * s)
    c.rrect((x + w * 0.16, y + h * 0.16, x + w * 0.31, y + h * 0.24), 9 * s, fill=PINK, outline=INK, width=3 * s)


def _gba_body_path(x: float, y: float, w: float, h: float):
    """AGB-001 silhouette: a long shell, very round on the left, squarer right."""
    left_r = h * 0.44
    right_r = h * 0.22
    x0, y0, x1, y1 = x - w / 2, y - h / 2, x + w / 2, y + h / 2
    points = []
    for step in range(13):  # right-bottom corner to bottom edge
        a = math.radians(step * 7.5)
        points.append((x1 - right_r + math.cos(a) * right_r, y1 - right_r + math.sin(a) * right_r))
    for step in range(13):  # left-bottom, a deep round
        a = math.radians(90 + step * 7.5)
        points.append((x0 + left_r + math.cos(a) * left_r, y1 - left_r + math.sin(a) * left_r))
    for step in range(13):  # left-top
        a = math.radians(180 + step * 7.5)
        points.append((x0 + left_r + math.cos(a) * left_r, y0 + left_r + math.sin(a) * left_r))
    for step in range(13):  # right-top
        a = math.radians(270 + step * 7.5)
        points.append((x1 - right_r + math.cos(a) * right_r, y0 + right_r + math.sin(a) * right_r))
    return points


def gba(c: Canvas, xy, scale: float = 1.0, t: float = 0.0, cart: float = 1.0, screen=None, boot: float = 1.0, shell="#7e6fc9"):
    """A Game Boy Advance, drawn to the AGB-001 layout. Reference body is 560x318."""
    s = scale
    x, y = xy
    w, h = 560 * s, 318 * s
    x0, y0, x1, y1 = x - w / 2, y - h / 2, x + w / 2, y + h / 2

    # cartridge in the top slot, sticking up behind the shell
    if cart > 0:
        cw, ch = w * 0.38, h * 0.52
        cy = y0 - ch * 0.42 - (1.0 - cart) * ch * 1.7
        c.rrect((x - cw / 2, cy - ch / 2, x + cw / 2, cy + ch / 2), 12 * s, fill="#3a3358", outline=INK, width=4 * s)
        c.rrect((x - cw * 0.40, cy - ch * 0.34, x + cw * 0.40, cy + ch * 0.10), 7 * s, fill=YELLOW, outline=INK, width=3 * s)
        c.text((x, cy - ch * 0.12), "gba-hero", 24 * s, INK, "mono", anchor="mm", jitter=0.3)
        for i in range(5):
            gx = x - cw * 0.30 + i * cw * 0.15
            c.line([(gx, cy + ch * 0.22), (gx, cy + ch * 0.36)], mix(YELLOW, INK, 0.35), 4 * s)

    # L and R wrap the top corners
    for side in (-1, 1):
        outer = x + side * w * (0.47 if side < 0 else 0.45)
        inner = x + side * w * 0.26
        c.rrect((min(outer, inner), y0 - 14 * s, max(outer, inner), y0 + 26 * s), 15 * s, fill=shade(shell, -0.14), outline=INK, width=4 * s)
        c.text((x + side * w * 0.345, y0 + 2 * s), "L" if side < 0 else "R", 16 * s, mix(shell, INK, 0.5), "hand", anchor="mm", jitter=0.2)

    c.poly([(px + 8 * s, py + 12 * s) for px, py in _gba_body_path(x, y, w, h)], fill=SHADOW)
    c.poly(_gba_body_path(x, y, w, h), fill=shell, outline=INK, width=5 * s)
    # top ridge highlight
    c.line([(x - w * 0.30, y0 + 16 * s), (x + w * 0.30, y0 + 16 * s)], shade(shell, 0.22), 7 * s)

    # screen bezel with the LCD inset to its upper left
    bezel = (x - w * 0.215, y - h * 0.33, x + w * 0.215, y + h * 0.30)
    c.rrect(bezel, 16 * s, fill="#241f33", outline=INK, width=4 * s)
    glass = (bezel[0] + 22 * s, bezel[1] + 18 * s, bezel[2] - 22 * s, bezel[1] + 18 * s + (bezel[2] - bezel[0] - 44 * s) * 2 / 3)
    if screen and boot > 0.05:
        screen(c, glass)
    else:
        c.rrect(glass, 5 * s, fill="#101a14")
    if boot < 1.0:
        band = lerp(glass[1], glass[3], boot)
        c.rect((glass[0], band, glass[2], glass[3]), fill="#101a14")
        c.line([(glass[0], band), (glass[2], band)], GREEN, 5 * s)
    c.circle((bezel[0] + 13 * s, (bezel[1] + bezel[3]) / 2), 6 * s, fill=GREEN if boot > 0.2 else mix(GREEN, INK, 0.6))
    c.text((glass[0], (glass[3] + bezel[3]) / 2), "MICROTS ADVANCE", 14 * s, mix("#241f33", PANEL, 0.55), "hand", anchor="lm", jitter=0.2)

    # d-pad on the left
    dx, dy = x - w * 0.335, y + h * 0.06
    arm, thick = 47 * s, 31 * s
    c.circle((dx, dy), arm * 1.15, fill=shade(shell, -0.1))
    c.poly(
        [(dx - thick / 2, dy - arm), (dx + thick / 2, dy - arm), (dx + thick / 2, dy - thick / 2),
         (dx + arm, dy - thick / 2), (dx + arm, dy + thick / 2), (dx + thick / 2, dy + thick / 2),
         (dx + thick / 2, dy + arm), (dx - thick / 2, dy + arm), (dx - thick / 2, dy + thick / 2),
         (dx - arm, dy + thick / 2), (dx - arm, dy - thick / 2), (dx - thick / 2, dy - thick / 2)],
        fill="#2f2a3d", outline=INK, width=3.4 * s,
    )

    # A and B on a diagonal, as on the real unit
    for bx, by, label in ((x + w * 0.375, y - h * 0.04, "A"), (x + w * 0.285, y + h * 0.12, "B")):
        c.circle((bx, by), 30 * s, fill=shade(shell, -0.12))
        c.circle((bx, by), 26 * s, fill="#4a3a63", outline=INK, width=3.4 * s)
        c.text((bx, by + 1 * s), label, 22 * s, mix("#4a3a63", PANEL, 0.75), "hand", anchor="mm", jitter=0.2)

    # start and select, angled, under the bezel
    for i, label in enumerate(("SELECT", "START")):
        px = x - w * 0.02 + i * w * 0.105
        py = y + h * 0.37 - i * h * 0.03
        c.rrect((px - 26 * s, py - 9 * s, px + 26 * s, py + 9 * s), 9 * s, fill="#2f2a3d", outline=INK, width=2.6 * s)
        c.text((px, py + 22 * s), label, 12 * s, mix(shell, INK, 0.55), "hand", anchor="mm", jitter=0.2)

    # speaker grille, bottom right
    for i in range(6):
        gx = x + w * 0.27 + i * 11 * s
        c.line([(gx, y + h * 0.26), (gx - 13 * s, y + h * 0.40)], shade(shell, -0.3), 4 * s)


def hero_screen(c: Canvas, box, count: int = 0, phase: int = 0, underline: float = 1.0, t: float = 0.0):
    """apps/gba-hero at 240x160, redrawn to the TSX layout."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    u = w / 240.0
    c.rrect(box, 5 * u, fill="#f8fafc")
    c.rect((x0, y0 + h * 0.5, x1, y1), fill="#f1f5f9")
    c.rrect((x0 + 8 * u, y0 + 8 * u, x0 + 32 * u, y0 + 32 * u), 5 * u, fill=YELLOW, outline="#cbd5e1", width=1.5 * u)
    c.circle((x0 + 20 * u, y0 + 20 * u), 5 * u, fill=PINK)
    c.text((x0 + 40 * u, y0 + 14 * u), "PocketJS", 11 * u, "#020617", "hand", anchor="lm", jitter=0.2)
    c.text((x0 + 40 * u, y0 + 26 * u), "MICROTS + GBA", 8 * u, "#64748b", "hand", anchor="lm", jitter=0.2)
    c.text((x1 - 8 * u, y0 + 13 * u), "30", 15 * u, "#059669", "hand", anchor="rm", jitter=0.2)
    c.text((x1 - 8 * u, y0 + 27 * u), "FPS target", 8 * u, "#64748b", "hand", anchor="rm", jitter=0.2)
    c.text((x0 + 8 * u, y0 + 48 * u), "ONE RUST CORE / ONE TSX APP", 8 * u, "#2563eb", "hand", anchor="lm", jitter=0.2)
    c.text((x0 + 8 * u, y0 + 68 * u), "JSX on GBA.", 17 * u, "#020617", "hand", anchor="lm", jitter=0.2)
    sx, sy = x0 + 216 * u, y0 + 74 * u
    for i in range(8):
        a = phase * math.tau / 8 + i * math.tau / 8
        fade = 1.0 - (i / 8) * 0.8
        c.line(
            [(sx + math.cos(a) * 6 * u, sy + math.sin(a) * 6 * u), (sx + math.cos(a) * 12 * u, sy + math.sin(a) * 12 * u)],
            mix("#f8fafc", "#2563eb", fade),
            2.6 * u,
        )
    bar_w = 144 * u * clamp(underline)
    if bar_w > 1:
        c.rect((x0 + 8 * u + count * 2 * u, y0 + 87 * u, x0 + 8 * u + bar_w + count * 2 * u, y0 + 90 * u), fill="#2f86e8")
    c.text((x0 + 8 * u, y0 + 103 * u), "TSX + flexbox, 2001 hardware.", 8 * u, "#475569", "hand", anchor="lm", jitter=0.2)
    c.rrect((x0 + 8 * u, y0 + 118 * u, x0 + 88 * u, y0 + 142 * u), 5 * u, fill="#2563eb", outline="#1d4ed8", width=1.5 * u)
    c.text((x0 + 48 * u, y0 + 130 * u), "Press A", 9 * u, "#ffffff", "hand", anchor="mm", jitter=0.2)
    c.text((x0 + 100 * u, y0 + 128 * u), f"Count: {count}", 8 * u, "#475569", "mono", anchor="lm", jitter=0.2)
    c.text((x0 + 185 * u, y0 + 128 * u), "B: Reset", 8 * u, "#64748b", "hand", anchor="lm", jitter=0.2)
    if count > 3:
        c.text((x0 + 8 * u, y0 + 150 * u), "Reactive on GBA.", 8 * u, "#059669", "hand", anchor="lm", jitter=0.2)


def cartridge(c: Canvas, xy, scale: float = 1.0, label: str = "app", glow: float = 0.0, t: float = 0.0):
    """Build output as a cartridge card."""
    s = scale
    x, y = xy
    w, h = 190 * s, 210 * s
    if glow > 0:
        for i in range(3):
            a = t * 2 + i * math.tau / 3
            sparkle(c, (x + math.cos(a) * w * 0.7, y + math.sin(a) * h * 0.55), (10 + 4 * math.sin(t * 6 + i)) * s, AMBER, a)
    c.rrect((x - w / 2 + 7 * s, y - h / 2 + 11 * s, x + w / 2 + 7 * s, y + h / 2 + 11 * s), 16 * s, fill=SHADOW)
    c.rrect((x - w / 2, y - h / 2, x + w / 2, y + h / 2), 16 * s, fill=PANEL2, outline=INK, width=4.5 * s)
    c.rrect((x - w * 0.38, y - h * 0.40, x + w * 0.38, y + h * 0.04), 9 * s, fill=YELLOW, outline=INK, width=3 * s)
    c.text((x, y - h * 0.18), label, 24 * s, INK, "hand", anchor="mm")
    for i in range(6):
        gx = x - w * 0.30 + i * w * 0.12
        c.line([(gx, y + h * 0.18), (gx, y + h * 0.38)], mix(YELLOW, INK, 0.3), 5 * s)
