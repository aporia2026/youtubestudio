"""
Paint Explainer v1 viability test — render the scribble draw-on MP4.

Builds a 5-second MP4 where the stick-figure base image is progressively
revealed left-to-right over the first 3 seconds, then held for 2 seconds.

This is a low-fidelity stand-in for true stroke-by-stroke SVG draw-on
(which would require Remotion). It answers the test's narrow question:
does progressive reveal read as "drawing in progress" or as a wipe?

Encodes 150 frames @ 30fps via ffmpeg image2 demuxer.
"""
from __future__ import annotations
import os
import shutil
import subprocess
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
VIA = os.path.join(PROJECT_ROOT, "hiccup-analysis", "paint-explainer-viability")
BASE = os.path.join(
    PROJECT_ROOT,
    "public",
    "style-refs",
    "Doodle-explainer-2",
    "03-lone-stick-figure-frowning.jpg",
)
FRAMES_DIR = os.path.join(VIA, "drawon-frames")
OUT_MP4 = os.path.join(VIA, "drawon.mp4")

CANVAS_W, CANVAS_H = 1536, 1024
WHITE = (252, 252, 250, 255)  # style-guide bg white

REVEAL_SECONDS = 3.0
HOLD_SECONDS = 2.0
FPS = 30

REVEAL_FRAMES = int(REVEAL_SECONDS * FPS)
HOLD_FRAMES = int(HOLD_SECONDS * FPS)
TOTAL_FRAMES = REVEAL_FRAMES + HOLD_FRAMES


def main() -> None:
    print(f"[paint-explainer viability drawon start] base={BASE} total_frames={TOTAL_FRAMES}")

    if os.path.isdir(FRAMES_DIR):
        shutil.rmtree(FRAMES_DIR)
    os.makedirs(FRAMES_DIR, exist_ok=True)

    figure = Image.open(BASE).convert("RGBA").resize((CANVAS_W, CANVAS_H), Image.LANCZOS)

    for idx in range(TOTAL_FRAMES):
        canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), WHITE)

        if idx < REVEAL_FRAMES:
            progress = (idx + 1) / REVEAL_FRAMES
            reveal_w = max(2, int(progress * CANVAS_W))
        else:
            reveal_w = CANVAS_W

        revealed = figure.crop((0, 0, reveal_w, CANVAS_H))
        canvas.alpha_composite(revealed, dest=(0, 0))
        canvas.convert("RGB").save(os.path.join(FRAMES_DIR, f"frame_{idx:04d}.png"))

        if idx == 0 or (idx + 1) % 30 == 0 or idx == TOTAL_FRAMES - 1:
            print(f"[paint-explainer viability drawon frame] idx={idx} reveal_w={reveal_w}")

    print(f"[paint-explainer viability drawon encode start] fps={FPS} frames_dir={FRAMES_DIR}")
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", str(FPS),
            "-i", os.path.join(FRAMES_DIR, "frame_%04d.png"),
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            OUT_MP4,
        ],
        check=True,
    )
    print(f"[paint-explainer viability drawon encode done] out={OUT_MP4} bytes={os.path.getsize(OUT_MP4)}")

    shutil.rmtree(FRAMES_DIR)
    print("[paint-explainer viability drawon done]")


if __name__ == "__main__":
    main()
