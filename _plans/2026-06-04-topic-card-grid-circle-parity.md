---
date: 2026-06-04
status: approved
owner: yoavm7-code
---

# Topic Card Grid — Circle Parity & Variation Axes

## Goals

1. **Fix the flat-bottom-circle bug** in the editor preview. Circles must be perfectly round in both the browser SVG preview and the final server-side export.
2. **Black border is a hard invariant** on every circle. No opt-out — every competitor sample uses it.
3. **Reach feature parity with the seven competitor styles** the user collected: photo-fill, cutout-on-color, flat-icon, below labels, overlapping labels with stroke, title case, ALL CAPS, thin border, thick cartoon border.
4. **All variation axes exposed as user controls**, per user decision (not preset-only).

## Non-goals

- Per-card style overrides inside one grid (e.g. screenshot #5 mixes styles per card). Single-style-per-grid for now; revisit if users ask.
- Background-removal model fine-tuning. We accept whatever the provider returns; swap provider if quality is poor.
- Remotion involvement. The grid is browser SVG + server Sharp composite. No Remotion bundle changes needed (no `deploy:remotion` required).

## Root cause of the flat-bottom bug

`ThumbnailRenderer.tsx` `renderCell` (browser preview, [ThumbnailRenderer.tsx:935-1143](src/components/thumbnails/ThumbnailRenderer.tsx#L935-L1143)) renders the image with `preserveAspectRatio='xMidYMid slice'` but **never applies a `clipPath`** to mask it to the circle. The border circle is drawn on top separately, so wherever the image overflows the disc bounds it stays visible — typically the bottom edge because the illustration area is `0.8 * cellH` tall while the disc diameter is `min(cellW, illustrationH)`.

The server-side composite ([topic-card-grid-composite.ts:1505 `buildCircleCellOverlay`](src/lib/thumbnail-formats/topic-card-grid-composite.ts#L1505), [`circularMaskSvg` at line 167](src/lib/thumbnail-formats/topic-card-grid-composite.ts#L167)) gets this right via Sharp `composite({ blend: 'dest-in' })` with a circular alpha mask. **Preview and export disagree.**

## The six variation axes

| Axis | Values | Default | Notes |
| --- | --- | --- | --- |
| Border weight | `thin` \| `thick` | `thin` | Thin ≈ 0.4% of cell width; thick ≈ 1.6%. |
| Label position | `below` \| `overlap` | `below` | Overlap puts the label so its top crosses the bottom edge of the disc by ~12% of disc diameter. |
| Label case | `title` \| `upper` | `title` | Pure CSS-level `text-transform`; the source string is untouched. |
| Fill style | `photo` \| `cutout` \| `icon` | `photo` | `photo` = image fills disc; `cutout` = subject-only on solid color; `icon` = AI-generated flat icon on solid color (existing `icon_concept` path). |
| Overlap stroke | `white-on-black` \| `black-on-white` | `white-on-black` | Only relevant when `labelPosition === 'overlap'`. Hidden control otherwise. |
| Grid preset | 2×3, 2×4, 2×5, 3×4, 3×5, custom | existing | Already supported; verify all five are in the preset list. |

## Data model

[src/lib/thumbnail-formats/topic-card-grid.ts:71-88 `GridLayout`](src/lib/thumbnail-formats/topic-card-grid.ts#L71-L88) gains:

```ts
borderWeight?: 'thin' | 'thick';        // default 'thin'
labelPosition?: 'below' | 'overlap';    // default 'below'
labelCase?: 'title' | 'upper';          // default 'title'
fillStyle?: 'photo' | 'cutout' | 'icon';// default 'photo'
overlapLabelStroke?: 'white-on-black' | 'black-on-white'; // default 'white-on-black'
```

[`TopicCard` at lines 30-41](src/lib/thumbnail-formats/topic-card-grid.ts#L30-L41) gains:

```ts
cutoutImageUrl?: string;       // bg-removed PNG, baked once per upload
sourceImageUrl?: string;       // original upload, kept for re-cutout if user toggles fillStyle
```

All new fields optional so existing thumbnails keep rendering unchanged.

## Renderer changes (must stay in lockstep)

**Browser preview** — [ThumbnailRenderer.tsx `renderCell`](src/components/thumbnails/ThumbnailRenderer.tsx#L935-L1143):

1. Emit `<defs><clipPath id={\`circ-${i}\`}><circle …/></clipPath></defs>` per cell.
2. Image: wrap in `<g clipPath={\`url(#circ-${i})\`}>`. **Fixes the flat-bottom bug.**
3. Border: `strokeWidth = borderWeight === 'thick' ? cellW * 0.016 : cellW * 0.004`. Color always `#000`.
4. Label: branch on `labelPosition`. For `overlap`, baseline crosses the disc bottom by `discDiameter * 0.12`; render with `paint-order='stroke fill'`, `stroke` = inverse of fill, `stroke-width` = ~6% of font size.
5. Label case: `text-transform='uppercase'` on the `<text>` element when `labelCase === 'upper'`.
6. Fill style:
   - `photo` — existing image branch.
   - `cutout` — disc filled with `accent_color`; render `cutoutImageUrl` at ~80% disc height, centered.
   - `icon` — disc filled with `accent_color`; existing icon-rendering path at ~50% disc height.

**Server composite** — [topic-card-grid-composite.ts `buildCircleCellOverlay`](src/lib/thumbnail-formats/topic-card-grid-composite.ts#L1505):

Mirror every branch above. The contract: preview pixels and export pixels match within 1% diff across the snapshot test fixtures (see Testing section).

## Background removal

**Provider decision: Replicate `851-labs/background-remover` at $0.00044/image, ~2 s on T4 GPU.**
130× cheaper than the existing Bria RMBG-2.0 wrapper ($0.058/image) used by the production-doc rmbg route. For 200–300px avatar-sized images viewed at YouTube grid size, the quality delta vs Bria is not visible to the end user; the cost delta is real ($0.50/month vs $70/month at 100 grids).

**Files:**

- New [src/lib/grid-bg-removal.ts](src/lib/grid-bg-removal.ts) — sibling to [src/lib/overlay-rmbg.ts](src/lib/overlay-rmbg.ts), same shape (`removeBackground` → `Buffer`), but POSTs to `https://api.replicate.com/v1/models/851-labs/background-remover/predictions` instead of `bria/remove-background`. Reuses `assertSafePublicUrl` from [src/lib/url-safety.ts](src/lib/url-safety.ts) and `Prefer: wait=30` for sync response.
- New [src/app/api/thumbnails/grid-rmbg/route.ts](src/app/api/thumbnails/grid-rmbg/route.ts) — mirrors the structure of [src/app/api/generate/production-doc/image/rmbg/route.ts](src/app/api/generate/production-doc/image/rmbg/route.ts): auth, rate-limit (20/min/IP), SSRF guard, `recordIntent` / `markDelivered` / `markFailed` for cost audit, R2 mirror of the cutout PNG. Provider model field on the audit row: `851-labs/background-remover`.

**Trigger**: when the user picks `fillStyle === 'cutout'` on a card whose `sourceImageUrl` does not already have alpha, call the route once and store the returned `cutoutImageUrl` on the card. If the upload already has alpha (sniff PNG `tRNS` chunk or 4-channel RGBA in JPEG/WebP via a tiny `image-metadata` helper), reuse the source URL as-is and skip the call. Toggling `fillStyle` back to `photo` does **not** delete the cached cutout — re-applying is free.

**Cost flag (rule 8)**: 15-card cutout grid = 15 × $0.00044 = **$0.0066 per grid**. 100 grids/month = **~$0.50/month**. Effectively free.

## UI controls

[TopicCardGridPanel.tsx near line 2242](src/components/thumbnails/TopicCardGridPanel.tsx#L2242-L2266) — add a new **"Card Style"** section directly below the existing Shape toggle. Same segmented-button visual pattern as the Shape control.

**Section 1 — Preset row** (above the per-axis controls). Six one-click presets, each sets all six axes at once:

| Preset | Border | Label pos | Label case | Fill | Overlap stroke | Inspired by |
| --- | --- | --- | --- | --- | --- | --- |
| Photo Tile | thin | below | title | photo | — | #1, #6 |
| Cutout Pop | thick | below | title | cutout | — | #3 |
| Icon Grid | thick | below | title | icon | — | #4 |
| Caps Overlay | thin | overlap | upper | photo | white-on-black | #2 |
| Mystery Doc | thin | overlap | upper | photo | white-on-black | #7 (B&W filter on top of this) |
| Cartoon Bold | thick | below | title | photo | — | (your own genre) |

Clicking a preset updates all six axes; per-axis controls remain editable below so the user can tweak. No "active preset" state is tracked — the source of truth is the six axis values.

**Section 2 — Per-axis controls**:

1. Border weight: `[Thin]` `[Thick]`
2. Label position: `[Below]` `[Overlap]`
3. Label case: `[Title]` `[UPPER]`
4. Fill style: `[Photo]` `[Cutout]` `[Icon]`
5. Overlap stroke (rendered only when label position = Overlap): `[White on black]` `[Black on white]`

All persist to localStorage with the same pattern as [`cardShape` at line 1248](src/components/thumbnails/TopicCardGridPanel.tsx#L1248).

## Observability (rule 14)

Log namespaces, all under `[topic-grid …]`:

- `[topic-grid render]` — once per render, logs `{ rows, cols, borderWeight, labelPosition, labelCase, fillStyle, overlapStroke, cardShape }`.
- `[topic-grid clip-path applied]` — first cell, dev-only, confirms the SVG `clipPath` is wired (bug-regression trail).
- `[topic-grid bg-removal]` — per cutout call: `{ cardIndex, source: 'auto' | 'user-upload-transparent', provider, durationMs, cost }`.
- `[topic-grid bg-removal cache]` — when `cutoutImageUrl` already exists and the call is skipped.
- `[topic-grid label-overlap]` — first cell only when `labelPosition === 'overlap'`, logs `{ baselineY, discBottomY, overshootPct }` so we can debug overlap positioning across cell sizes.

## Security (rule 13)

- Bg-removal API token reads from existing env (per memory, Replicate token is provisioned). Token never leaves server.
- Uploaded image content-type / size validation — confirm the existing upload path covers it; flag if it doesn't.
- No user-supplied text reaches the bg-removal request (no prompt input on those endpoints).
- Cutout PNG URLs are public CDN URLs from the provider; treated the same as existing uploads. No new attack surface.

## Settings audit (rule 15)

- All 6 axes persist per-thumbnail via localStorage (matches existing pattern).
- Defaults listed in the table above.
- **Not exposed in global app settings** for v1 — per-thumbnail is enough and avoids a global default that's wrong for half the use cases. Revisit only if users explicitly ask.

## Testing (rule 18)

New test files under `tests/`:

- `tests/topic-card-grid-clip-path.test.tsx` — regression: render the panel with `cardShape='circle'`, assert the SVG output contains a `<clipPath>` element and the image is wrapped in a `<g clipPath="…">`. **This test fails on the old code and passes on the new** — exactly what the rule prescribes.
- `tests/topic-card-grid-label-overlap.test.ts` — pure helper test for the baseline-overlap math. Inputs: disc diameter + font size. Expected: baseline Y crosses disc bottom by 12% of diameter, ±0.5px.
- `tests/topic-card-grid-snapshot.test.ts` — render one thumbnail per (`fillStyle` × `labelPosition`) combo = 6 snapshots, Sharp pixel diff vs. checked-in fixtures with 1% tolerance.
- `tests/bg-removal.test.ts` — mock the provider; assert: (a) skips call when input has alpha, (b) caches the result on the card, (c) error path returns a clear error and does not block render.

Run order before any of this is "done": full `npm test` plus the new snapshots, all green.

## Rollout & risk

- All new fields optional → existing grids untouched.
- Behind the `cardShape === 'circle'` branch in the renderer → square-mode users unaffected.
- One-shot deploy, no Remotion bundle rebuild needed.
- Visible side-effects:
  - First time a user opens an existing circle thumbnail, the flat-bottom goes away (positive surprise, not a regression).
  - **Black border is now an invariant on all circles** — user decision. Old border-less circle thumbnails (if any exist in the DB) will gain a border on next render. No legacy flag, no opt-out. Per user: all seven competitor examples use a black border; matching that is more likely correct than honoring a (possibly accidental) no-border state. If a user complains we add the opt-out then.

## Alternatives considered

1. **Fix the bug only; defer parity.** Cheapest, lands today. Rejected: user explicitly asked to cover competitor parity in the same plan.
2. **Preset-driven UI (5 named styles, no per-axis controls).** Lower UI surface. Rejected: user picked "All axes exposed" — explicit decision.
3. **Use a single client-side bg-removal library (e.g. `@imgly/background-removal`).** Runs in the browser, zero per-image cost. Considered seriously. Drawbacks: 30–80 MB WASM payload, 2–8 s per image on mid-range hardware, quality below cloud models. Rejected for default path; could be a future fallback for cost-sensitive users.

## Resolved decisions

1. **Bg-removal provider**: Replicate `851-labs/background-remover` ($0.00044/image). New `grid-bg-removal.ts` wrapper sibling to existing `overlay-rmbg.ts`.
2. **Preset row**: yes, six presets above the per-axis controls (Photo Tile, Cutout Pop, Icon Grid, Caps Overlay, Mystery Doc, Cartoon Bold).
3. **Border-less legacy circles**: ignored. Black border is forced on every circle.

## Out of scope (deliberately deferred)

- Per-card style mixing inside one grid.
- Animated thumbnail variants.
- Bg-removal quality controls (edge feathering, alpha threshold).
- A11y audit of the editor — the editor itself is internal-tool surface; main thumbnail output isn't keyboard-navigable by nature.
