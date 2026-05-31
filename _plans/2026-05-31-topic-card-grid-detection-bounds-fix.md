# Topic Card Grid — fix composite alignment bugs from narrow detection window

**Date:** 2026-05-31
**Status:** Approved, implementing
**Owner:** Yoav

## Symptom

After the font-tofu fix (commit `bee02f9`), the labels render correctly but
THREE composite-alignment bugs are visible and previously hidden by the
unreadable text:

1. **Row-1 cells have no visible top border.** Illustration content runs
   straight to the canvas top edge with no clean black line above.
2. **Label band's left/right edges don't align with the illustration
   above.** Illustration is wider than the band, OR band sticks out past
   the illustration — both seen in production renders.
3. **Black border lines painted INSIDE illustrations.** Row-2 cells get a
   thin black horizontal line cutting off the top portion of their
   illustration (visible as: ice cube clipped at the top, rocket tip
   pulled off-screen by a phantom border).

## Root cause — single bug, three symptoms

`detectAiCellRect` scans for the AI's actual cell borders within a tiny
window of `±max(8, gutter/2)` pixels around the expected position computed
from `makeDefaultLayout` (`outerMargin = gutter = round(canvasW * 0.011) ≈
22-45 px`). The transition-based scan looks for a light→dark transition
within that window; if not found, it falls back to the expected position.

In production renders, GPT Image 2 (and the other supported i2i models)
consistently picks tighter geometry than the prompt asks for:

- Cells rendered FLUSH against the canvas edge (no outer margin at all).
- Cells in the same row sharing borders (no inter-cell gutter).

Both cases mean the AI's actual cell border is FAR outside the ±22-45 px
search window:

- For a row-0 cell with AI drawn at `y = 0` and expected at `y = 23`, the
  scan from `[12, 34]` never sees any light-to-dark transition (it starts
  in dark territory immediately because the AI's illustration begins at
  `y = 0`). Falls back to `expected.y = 23`.
- Composite then paints the top border + side wipes + band overlay
  **assuming aiRect.y = 23**, while the AI actually drew everything
  starting at `y = 0`. Result: the 23-pixel sliver of AI illustration
  ABOVE our composite's overlay stays visible (no top border), and our
  overlay's wipes/borders land 23 px lower than they should.

For row-2 cells the offset accumulates: expected `y = 23 + 530 + 23 =
576`, AI drew at `y ≈ 535`. The 41-px offset puts our composite's top
border well inside the AI's illustration → the "border bleeding into
image" symptom.

The band's x misalignment has the same cause on the horizontal axis: AI
draws cells edge-to-edge horizontally, our band overlay lands at the
expected x with a ~22 px offset.

## Goals

1. Detection finds the AI's actual cell rectangle even when AI ignored
   the outer margin or inter-cell gutter.
2. Composite overlays land on the AI's geometry, not on stale expected
   coords.
3. Every cell has a clean visible top/bottom/left/right border, regardless
   of whether the AI drew one in that position.
4. No regression to the existing test suite.

## Approach

**Replace the global `searchRange` with per-cell scan bounds.**

Instead of one symmetric window around each expected edge, compute a
custom `{leftMin, leftMax, rightMin, rightMax, topMin, topMax, bottomMin,
bottomMax}` envelope per cell:

- **Outer edges** (row-0 top, last-row bottom, col-0 left, last-col
  right): scan from the canvas edge to a small buffer inside the expected
  position. Lets detection find the AI's border at the canvas edge.
- **Interior edges**: scan to half the cell extent in the inward
  direction. Catches no-gutter AI renders where the actual border is
  ~half a cell away from expected.
- **Fallback**: for outer edges that find no transition, snap to the
  canvas edge (the AI drew at the edge). For interior edges, snap to
  expected (the AI's geometry matches our layout closely enough).

A `computeScanBounds(layout, cardIndex, canvasW, canvasH)` helper derives
these from the grid layout. Detection becomes parameterised; the legacy
`searchRange` number stays accepted for backward compatibility with the
existing unit tests.

The scan algorithm is also strengthened: when the entire scan range is
already dark (no transition because AI drew through the edge), return
the bounds' lower end (canvas edge or expected) — currently the scan
returns expected even when it's clearly wrong.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Bounds-per-cell detection (this plan) | Surgical fix; backward-compat preserved | More API surface in detection helper | **Chosen** |
| Force layout: drop detection, paint at `cellRect` | Predictable, simpler | AI illustrations get clipped at expected bounds; design assumes outer margin exists | Rejected |
| Set `outerMargin = 0` / `gutter = 0` in layout | No more drift between expected and AI | Changes the visual design; reference image expects margins | Rejected |
| Re-extract AI illustrations and re-composite into clean cells | Pixel-perfect output | Loses fidelity at AI's illustration edges; large refactor | Deferred — revisit if bounds fix isn't enough |

## Plan of work

### Step 1 — Add `CellScanBounds` + `computeScanBounds` helper

In `src/lib/thumbnail-formats/topic-card-grid-composite.ts`. Pure
function: takes layout + card index + canvas dimensions, returns
bounds. Tested independently.

### Step 2 — Extend `detectAiCellRect` to accept bounds

Keep the old `searchRange: number` parameter working (legacy callers
+ tests). Add an overload where the last parameter is a
`CellScanBounds` object. Inside, route to one of two algorithms:

- Bounds-based: scan within `[edgeMin, edgeMax]`. Find first
  light→dark transition. If none, and the scan was entirely dark,
  return the lower end of the bound. If entirely light, return
  fallback.
- Range-based (legacy): existing logic.

### Step 3 — Wire `applyCellUploads` to compute bounds and use them

When `useBorderDetection` runs, build bounds per card and pass them
to detection.

### Step 4 — Force-paint all four borders on every cell

The current code force-repaints only the top border. Now also paint
left, right, bottom at the detected positions. This guarantees a
clean frame regardless of which borders the AI drew.

### Step 5 — Tests

Add two new test groups:

- `computeScanBounds`: verifies outer cells get canvas-edge bounds,
  interior cells get half-extent bounds, and the fallback positions
  match the cell's grid position.
- `detectAiCellRect` with bounds: synthetic "AI drew at canvas edge,
  no margin" and "AI drew with no gutter between rows" cases. The
  detected rect should snap to the canvas edge / mid-cell.

The existing tests (using the `searchRange` parameter) stay green via
backward-compat.

### Step 6 — Manual verification

After tests pass, re-render the same Topic Card Grid the user pulled
the screenshots from. Verify:

- Row-1 cells have a visible top border (clean black line at canvas
  top or near it).
- Label bands align horizontally with the illustration above them.
- Row-2 cells have no horizontal cut INSIDE their illustration.

## Observability

The existing `[topic-card-grid composite divider-scan]` log emits the
detected band-top and source. Add a parallel
`[topic-card-grid composite cell-rect]` log per cell: detected
`{x, y, w, h}` plus the four `bounds` and `fallback` values, so future
debugging can read off where each detection landed and whether it used
the canvas-edge fallback or found a real transition.

## Security

No new attack surface. Detection runs on already-decoded pixel data; the
new helper is a pure math function.

## Settings

No new user-facing settings. Detection happens server-side; the result
is the same composite image, just correctly aligned.

## Testing

- Unit tests in `tests/topic-card-grid-composite.test.ts` cover the
  new helper + the bounds-based detection path.
- The existing 38 composite tests must continue to pass — they pin
  the legacy `searchRange` path.
- Manual visual verification per Step 6.

## Rollback

Revert the commit. Detection falls back to its narrow-window behaviour;
the visible bugs return, but the font fix stays in place.
