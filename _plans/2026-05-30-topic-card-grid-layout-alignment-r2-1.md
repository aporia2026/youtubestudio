# Topic Card Grid — r2.1 layout alignment fixes

Date: 2026-05-30 (same day, follow-up to r2)
Status: approved, in progress

## Why

After the r2 fixes ([plan](./2026-05-30-topic-card-grid-quality-fixes.md)) shipped, the next real run produced excellent icons (single bold symbols, correct color semantics) and clean short labels, but exposed a second-order layout bug that the prior failure modes had hidden:

- GPT Image 2 renders each card as **two separate bordered rectangles** — a wide illustration panel on top and a narrower centered "label tag" below — rather than as **one unified rectangle with an internal label strip**.
- The AI also picks a tighter column gutter than the `defaultGutter(width)` formula at [topic-card-grid.ts:105-107](../src/lib/thumbnail-formats/topic-card-grid.ts#L105-L107) predicts (`~1.1%` of canvas width). The AI's effective cellW is therefore wider than our computed `cellRect`.
- Our pure-prompt label-band overlay paints white + a black border at our (narrower) `cellW`. The AI's wider illustration panel and its outer border survive past our overlay edges, so the user sees thin black lines flanking the label strip and the strip itself reads as visibly narrower than the panel above.

User directive (unchanged from r2): don't touch the format, just make it work.

## Goals

- Cards render as ONE bordered rectangle with an internal full-width label strip, not as a stacked illustration-panel + tag-box pair.
- The composite label band visually aligns with the illustration's width, even when the AI's cell-width math drifts from ours by a handful of pixels.

## Non-goals

- No vision pass to detect AI cell boundaries (rejected at the bottom of this file).
- No layout/format changes — same square cards, same 80/20 split, same composite step ordering.

## Approach

### 1. Image prompt: enforce unified cell rendering

Replace the soft "split into two stacked regions" language with hard rules + a concrete forbidden-pattern list. Pattern mirrors r2's icon_concept FORBIDDEN PATTERNS approach — exact prose the AI tends to ship gets called out by name.

Key sentences to add inside the LAYOUT block (square mode only):
- ONE rectangle per card. ONE outer black border wraps the illustration AND the label strip TOGETHER.
- The label strip is the FULL WIDTH of the card — it shares the same left and right edges as the illustration above it. The bottom edge of the illustration meets the top edge of the label strip on a 1px hairline.
- Forbidden renderings: separate label box, label badge, label callout, label tag, smaller centered box beneath the illustration with its own border, any gap between illustration and label.

### 2. Composite: horizontal wipe in pure-prompt mode

Extend the existing pure-prompt branch so the label-band region gets wiped white **wider than the cell** before the band overlay paints. Specifically wipe from `rect.x - gutterPad` to `rect.x + rect.w + gutterPad` across the band height. The existing band overlay then paints on top at its current cellW position.

Trade-off accepted: this erases AI's own cell-border lines in the column gutter slack. We then redraw our band's border at our cellW position. If the AI's cellW was wider than ours, the visible cell width shrinks to ours — but the band + illustration now share the same apparent width, which is the user's complaint.

Pair with the row-gutter wipe that r2 already added. Together they form a `(cellW + 2·gutterPad) × (labelH + gutterPad)` wipe rectangle that catches AI drift on three sides of the band.

### 3. Tests

- Image prompt: assert the FORBIDDEN PATTERNS for label-rendering appear in square mode, do NOT appear in circle mode (label-below-disc on white canvas has no analogous failure).
- Composite: assert in pure-prompt mode that the column-gutter slack just to the left/right of cell 1 (within `gutterPad`) is wiped white, not left at the base color. Combined with the existing row-gutter test, this covers the three wiped strips around each band.

## Observability

No new logs needed — both fixes flow through existing namespaces (`[thumb-format-grid cards] validation failed` for prompt-driven retries, the composite step has no per-overlay log).

## Security

No surface change.

## Rejected alternatives

- **Vision pass to detect actual AI cell rectangles.** Most accurate but doubles the per-render cost and slows the route by a full LLM round-trip. Save for the next regression if the prompt-based fix doesn't hold.
- **Tell AI a specific pixel gutter width.** GPT Image 2 historically ignores exact pixel measurements; structural rules ("ONE rectangle", "FULL WIDTH") are more effective.
- **Drop the band overlay border entirely.** Would leave a borderless gap between the illustration and the canvas edge below the band — broken open-ended cell look.

## Open questions

If the AI still ships the two-rectangle layout after this round, the next move is the vision pass — flag it explicitly before paying for it.
