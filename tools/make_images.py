#!/usr/bin/env python3
"""Generate the Movie Times app icon + loading logo (run with the pebble-tool
python, which bundles Pillow):

    ~/.local/share/uv/tools/pebble-tool/bin/python tools/make_images.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..", "resources", "images")
os.makedirs(ROOT, exist_ok=True)

BLACK = (0, 0, 0, 255)
CLEAR = (0, 0, 0, 0)


def clapperboard(size, pad_frac=0.08, lines=(0.30, 0.55, 0.80),
                 stripe_frac=0.13, line_frac=0.13):
    """A bold film-clapperboard silhouette, black on transparent, drawn on a
    square canvas `size` px wide."""
    S = size * 8  # supersample for clean edges, then downscale
    img = Image.new("RGBA", (S, S), CLEAR)
    d = ImageDraw.Draw(img)

    pad = int(S * pad_frac)
    left, right = pad, S - pad
    w = right - left

    # --- slate (the board body) ---
    stick_h = int(w * 0.28)
    gap = int(S * 0.035)
    board_top = pad + stick_h + gap
    board_bottom = S - pad
    d.rectangle([left, board_top, right, board_bottom], fill=BLACK)

    # knock "info lines" out of the slate so it reads as a board
    lh = int((board_bottom - board_top) * line_frac)
    for i in lines:
        y = int(board_top + (board_bottom - board_top) * i)
        d.rectangle([left + int(w * 0.14), y, right - int(w * 0.14), y + lh], fill=CLEAR)

    # --- clapper stick (hinged bar with diagonal stripes) ---
    stick_top = pad
    stick_bot = pad + stick_h
    d.rectangle([left, stick_top, right, stick_bot], fill=BLACK)

    stripe_w = int(w * stripe_frac)
    step = stripe_w * 2
    x = left - stick_h
    while x < right + step:
        d.polygon(
            [
                (x, stick_bot),
                (x + stripe_w, stick_bot),
                (x + stripe_w + stick_h, stick_top),
                (x + stick_h, stick_top),
            ],
            fill=CLEAR,
        )
        x += step

    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    path = os.path.join(ROOT, name)
    img.save(path)
    print("wrote", os.path.relpath(path))


# Launcher menu icon: small + 1-bit, so keep it chunky - 2 fat lines, wide stripes.
save(clapperboard(25, pad_frac=0.06, lines=(0.34, 0.68),
                 stripe_frac=0.17, line_frac=0.17), "menu_icon.png")

# Loading-screen logo: larger mark, more detail.
save(clapperboard(72, lines=(0.28, 0.52, 0.76)), "logo.png")
