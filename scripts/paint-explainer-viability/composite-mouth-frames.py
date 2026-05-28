"""
Paint Explainer v1 viability test — composite mouth states onto the
mouth-removed base.

Produces 3 full-resolution 1536x1024 composite frames matching the
positions of the mouth in the original 14-close-up-character-face.jpg.
These are the source frames the ffmpeg concat demuxer cycles through to
animate "talking" at 6/8/10 fps.

Outputs:
  hiccup-analysis/paint-explainer-viability/composite-closed.png
  hiccup-analysis/paint-explainer-viability/composite-mid.png
  hiccup-analysis/paint-explainer-viability/composite-open.png

Position of the mouth on the 1536x1024 base — calibrated from the
original close-up character face. Tunable in MOUTH_CENTER below.
"""
from __future__ import annotations
import os
from PIL import Image

OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "hiccup-analysis",
    "paint-explainer-viability",
)

BASE_PATH = os.path.join(OUT_DIR, "14-mouth-removed.png")
MOUTH_CLOSED = os.path.join(OUT_DIR, "mouth-closed.png")
MOUTH_MID = os.path.join(OUT_DIR, "mouth-mid.png")
MOUTH_OPEN = os.path.join(OUT_DIR, "mouth-open.png")

# Calibrated from the original 14-close-up-character-face.jpg. The mouth
# sat at roughly the lower third of the head circle, slightly left of
# horizontal center because the head is slightly left-of-center in the
# frame. These are pixel coords on the 1536x1024 canvas.
MOUTH_CENTER = (640, 535)

MOUTH_W, MOUTH_H = 200, 100  # matches build-mouth-states.py


def composite(state_name: str, mouth_path: str) -> None:
    base = Image.open(BASE_PATH).convert("RGBA")
    mouth = Image.open(mouth_path).convert("RGBA")
    cx, cy = MOUTH_CENTER
    top_left = (cx - MOUTH_W // 2, cy - MOUTH_H // 2)
    base.alpha_composite(mouth, dest=top_left)
    out_path = os.path.join(OUT_DIR, f"composite-{state_name}.png")
    # Drop alpha for ffmpeg consistency; the base has no transparency.
    base.convert("RGB").save(out_path)
    print(f"[paint-explainer viability composite] {state_name} -> {out_path} pos={top_left}")


def main() -> None:
    print(f"[paint-explainer viability composite start] base={BASE_PATH} mouth_center={MOUTH_CENTER}")
    composite("closed", MOUTH_CLOSED)
    composite("mid", MOUTH_MID)
    composite("open", MOUTH_OPEN)
    print("[paint-explainer viability composite done]")


if __name__ == "__main__":
    main()
