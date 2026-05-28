"""
Paint Explainer v1 viability test — procedural mouth state PNGs.

Draws three mouth states matching the hand-drawn doodle style of
doodle_explainer_2:
  - closed.png  : flat black line with subtle upward curve (~smile)
  - mid.png     : narrow black ellipse outline (slightly open)
  - open.png    : red-filled oval with thick black outline (talking)

Each is 200x100 px on a transparent background so ffmpeg overlay
positions cleanly via its `x:y` filter.

Also draws a 3x2 contact sheet for visual sanity-check at:
  hiccup-analysis/paint-explainer-viability/mouth-states-sheet.png

Observability per rule 14.
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "hiccup-analysis",
    "paint-explainer-viability",
)
os.makedirs(OUT_DIR, exist_ok=True)

# Mouth-state canvas. Generous so we can place at any size in ffmpeg.
W, H = 200, 100
BLACK = (26, 26, 26, 255)  # outline_black from STYLE_GUIDE
RED = (229, 62, 62, 255)   # mouth_red from STYLE_GUIDE


def make_closed() -> Image.Image:
    """Thin upward-curving black arc — a closed/smug mouth."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Curved line via thick arc — draw two arcs offset for line weight.
    cx, cy = W // 2, H // 2 + 10
    rw, rh = 60, 30
    bbox = (cx - rw, cy - rh, cx + rw, cy + rh)
    # arc from 200 to 340 degrees draws the top half (smile shape)
    d.arc(bbox, start=200, end=340, fill=BLACK, width=6)
    print(f"[paint-explainer viability mouth closed] bbox={bbox} stroke=6")
    return img


def make_mid() -> Image.Image:
    """Narrow horizontal ellipse outline — mouth slightly open."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = W // 2, H // 2
    rw, rh = 50, 12
    bbox = (cx - rw, cy - rh, cx + rw, cy + rh)
    d.ellipse(bbox, outline=BLACK, width=6)
    print(f"[paint-explainer viability mouth mid] bbox={bbox} stroke=6")
    return img


def make_open() -> Image.Image:
    """Red-filled oval with thick black outline — talking O."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = W // 2, H // 2
    rw, rh = 48, 28
    bbox = (cx - rw, cy - rh, cx + rw, cy + rh)
    # Fill first, then outline on top for the doodle look.
    d.ellipse(bbox, fill=RED, outline=BLACK, width=6)
    print(f"[paint-explainer viability mouth open] bbox={bbox} stroke=6 fill=red")
    return img


def main() -> None:
    states = {"closed": make_closed(), "mid": make_mid(), "open": make_open()}
    for name, img in states.items():
        out_path = os.path.join(OUT_DIR, f"mouth-{name}.png")
        img.save(out_path)
        print(f"[paint-explainer viability mouth save] {name} -> {out_path} bytes={os.path.getsize(out_path)}")

    # Contact sheet for sanity check.
    sheet = Image.new("RGBA", (W * 3 + 40, H + 40), (252, 252, 250, 255))
    for i, name in enumerate(["closed", "mid", "open"]):
        sheet.paste(states[name], (10 + i * (W + 10), 20), states[name])
    sheet_path = os.path.join(OUT_DIR, "mouth-states-sheet.png")
    sheet.save(sheet_path)
    print(f"[paint-explainer viability mouth sheet] {sheet_path}")


if __name__ == "__main__":
    main()
