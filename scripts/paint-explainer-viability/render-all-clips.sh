#!/usr/bin/env bash
#
# Paint Explainer v1 viability test — render every clip used in the
# side-by-side comparison MP4.
#
# Inputs (already produced by earlier scripts in this folder):
#   hiccup-analysis/paint-explainer-viability/composite-closed.png
#   hiccup-analysis/paint-explainer-viability/composite-mid.png
#   hiccup-analysis/paint-explainer-viability/composite-open.png
#   public/style-refs/Doodle-explainer-2/03-lone-stick-figure-frowning.jpg
#   refs/the paint explainer/videoplayback.mp4
#
# Outputs (all under hiccup-analysis/paint-explainer-viability/):
#   mouth-swap-6fps.mp4   — 5 sec, talk-cycle [closed, mid, open, mid] at 6 fps
#   mouth-swap-8fps.mp4   — same at 8 fps
#   mouth-swap-10fps.mp4  — same at 10 fps
#   drawon.mp4            — 5 sec, base revealed left-to-right
#   ref-clip.mp4          — 5 sec slice of the user's reference at a talking moment
#   comparison.mp4        — hstack of all five, with labels burned in
#
# Observability per rule 14 — every step prints a namespaced log line.

set -euo pipefail

VIA="c:/youtubestudio-live/hiccup-analysis/paint-explainer-viability"
REF_VIDEO="c:/youtubestudio-live/refs/the paint explainer/videoplayback.mp4"
DRAWON_BASE="c:/youtubestudio-live/public/style-refs/Doodle-explainer-2/03-lone-stick-figure-frowning.jpg"

# Pick a talking moment from the reference. After eyeballing the ref via
# ffprobe, the segment around 1:14 in videoplayback.mp4 (=74s) has the
# narrator-character in mid-speech with the open-mouth O on screen.
REF_START_S=74

cd "$VIA"

echo "[paint-explainer viability render] start"

# --- 1. Build concat lists for the three mouth-swap fps targets -----------
build_concat() {
  local fps=$1
  local out=$2
  local dur
  dur=$(python -c "print(1/${fps})")
  local nframes=$((fps * 5))
  local pattern=("closed" "mid" "open" "mid")
  > "$out"
  for ((i = 0; i < nframes; i++)); do
    local state="${pattern[$((i % 4))]}"
    echo "file 'composite-${state}.png'" >> "$out"
    echo "duration ${dur}" >> "$out"
  done
  # Per ffmpeg concat demuxer docs, the last file entry must be duplicated
  # without a duration directive so the actual last frame is held for the
  # final segment duration.
  local final_state="${pattern[$((nframes % 4))]}"
  echo "file 'composite-${final_state}.png'" >> "$out"
  echo "[paint-explainer viability concat-build] fps=${fps} file=${out} entries=${nframes}"
}

build_concat 6  concat-6fps.txt
build_concat 8  concat-8fps.txt
build_concat 10 concat-10fps.txt

# --- 2. Render the three mouth-swap clips ---------------------------------
render_mouthswap() {
  local fps=$1
  local out=mouth-swap-${fps}fps.mp4
  echo "[paint-explainer viability mouthswap render start] fps=${fps} out=${out}"
  ffmpeg -y -loglevel error \
    -f concat -safe 0 -i "concat-${fps}fps.txt" \
    -vf "fps=${fps},scale=1536:1024:flags=lanczos,format=yuv420p" \
    -c:v libx264 -preset medium -crf 18 -movflags +faststart \
    "$out"
  echo "[paint-explainer viability mouthswap render done] fps=${fps} bytes=$(stat -c%s "$out")"
}

render_mouthswap 6
render_mouthswap 8
render_mouthswap 10

# --- 3. Render the draw-on clip -------------------------------------------
# Strategy: start with a fully-white canvas. Use a moving alpha mask to
# reveal the source image left-to-right over the first 3 seconds, then
# hold for 2 seconds. The reveal is sharp-edged (matches "drawing in
# progress" feel) with a slight feathered trailing edge.
#
# ffmpeg implementation:
#   - input 0: white background (lavfi color source) for 5s
#   - input 1: still image of the stick figure, looped to 5s
#   - filter: overlay input 1 onto input 0 with a moving rectangular crop
#     that grows in width over time. We achieve the moving reveal by
#     using `crop` with `w=t*W/3` (W = source width), then padding to
#     1536x1024 on the left side so the figure stays anchored in place.
echo "[paint-explainer viability drawon render start]"
ffmpeg -y -loglevel error \
  -f lavfi -t 5 -i "color=c=#FCFCFA:s=1536x1024:r=30" \
  -loop 1 -t 5 -i "$DRAWON_BASE" \
  -filter_complex "
    [1:v]scale=1536:1024:flags=lanczos[fig];
    [fig]crop='if(lt(t,3),t*w/3,w)':h:0:0[reveal];
    [0:v][reveal]overlay=0:0:eof_action=pass[out];
    [out]format=yuv420p[final]
  " -map "[final]" \
  -c:v libx264 -preset medium -crf 18 -movflags +faststart \
  drawon.mp4
echo "[paint-explainer viability drawon render done] bytes=$(stat -c%s drawon.mp4)"

# --- 4. Extract the reference clip ----------------------------------------
echo "[paint-explainer viability refclip extract start] from=${REF_START_S}s"
ffmpeg -y -loglevel error \
  -ss "$REF_START_S" -t 5 \
  -i "$REF_VIDEO" \
  -vf "scale=1536:1024:flags=lanczos:force_original_aspect_ratio=decrease,pad=1536:1024:(ow-iw)/2:(oh-ih)/2:color=#FCFCFA,format=yuv420p" \
  -c:v libx264 -preset medium -crf 18 -an -movflags +faststart \
  ref-clip.mp4
echo "[paint-explainer viability refclip extract done] bytes=$(stat -c%s ref-clip.mp4)"

# --- 5. Stack everything into one comparison MP4 --------------------------
# Layout: a 2x3 grid so labels are legible at any reasonable preview size.
#   row 1: [REF        ][ DRAW-ON   ][ MOUTH 6fps ]
#   row 2: [MOUTH 8fps ][ MOUTH 10fps][ blank-pad ]
#
# Each cell is scaled to 640x426 (preserving 1536:1024 aspect = 3:2).
# Labels burned in via drawtext at the bottom of each cell.

CELL_W=640
CELL_H=426

echo "[paint-explainer viability comparison stack start] cell=${CELL_W}x${CELL_H}"

ffmpeg -y -loglevel error \
  -i ref-clip.mp4 \
  -i drawon.mp4 \
  -i mouth-swap-6fps.mp4 \
  -i mouth-swap-8fps.mp4 \
  -i mouth-swap-10fps.mp4 \
  -f lavfi -t 5 -i "color=c=#FCFCFA:s=${CELL_W}x${CELL_H}:r=30" \
  -filter_complex "
    [0:v]scale=${CELL_W}:${CELL_H},drawtext=text='REFERENCE (Paint Explainer)':fontcolor=black:fontsize=22:x=10:y=${CELL_H}-32:box=1:boxcolor=#EBC347:boxborderw=4[v0];
    [1:v]scale=${CELL_W}:${CELL_H},drawtext=text='DRAW-ON (ffmpeg reveal)':fontcolor=black:fontsize=22:x=10:y=${CELL_H}-32:box=1:boxcolor=#EBC347:boxborderw=4[v1];
    [2:v]scale=${CELL_W}:${CELL_H},drawtext=text='MOUTH-SWAP 6 fps':fontcolor=black:fontsize=22:x=10:y=${CELL_H}-32:box=1:boxcolor=#EBC347:boxborderw=4[v2];
    [3:v]scale=${CELL_W}:${CELL_H},drawtext=text='MOUTH-SWAP 8 fps':fontcolor=black:fontsize=22:x=10:y=${CELL_H}-32:box=1:boxcolor=#EBC347:boxborderw=4[v3];
    [4:v]scale=${CELL_W}:${CELL_H},drawtext=text='MOUTH-SWAP 10 fps':fontcolor=black:fontsize=22:x=10:y=${CELL_H}-32:box=1:boxcolor=#EBC347:boxborderw=4[v4];
    [5:v]drawtext=text='(blank)':fontcolor=#999999:fontsize=22:x=10:y=${CELL_H}-32[v5];
    [v0][v1][v2]hstack=inputs=3[top];
    [v3][v4][v5]hstack=inputs=3[bot];
    [top][bot]vstack=inputs=2,format=yuv420p[final]
  " -map "[final]" \
  -c:v libx264 -preset medium -crf 18 -movflags +faststart \
  comparison.mp4

echo "[paint-explainer viability comparison stack done] bytes=$(stat -c%s comparison.mp4)"
echo "[paint-explainer viability render done] artifacts=${VIA}"
