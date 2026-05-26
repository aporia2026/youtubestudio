# Topic Card Grid — circles variant + per-cell image upload

**Date:** 2026-05-19
**Status:** Approved (r1)
**Owner:** Yoav
**Prereq:** `_plans/2026-05-19-thumbnail-format-topic-card-grid.md` (shipped — the square grid this extends)

---

## Goal

Two additive capabilities on top of the existing Topic Card Grid format:

1. **Circle variant** — a new card-shape mode where each card is a circle (illustration only, no rectangular frame) with its label rendered below the circle in the gutter. Selected via a `Card shape` toggle alongside the existing grid-size controls.
2. **Per-cell image upload** — the user can attach an image to any specific cell. The AI is told to leave that cell blank; after generation, the server deterministically composites the user's image into the cell region (cropped to fit, masked to a circle in circle mode). The user-supplied label is rendered identically to AI-generated cells.

Both capabilities are **extensions of the existing format**, not a new format card. Same panel, same API routes, additive params.

---

## Why this matters

The square grid is working but is a single visual language. Circles are a recognisable second pattern (BuzzFeed-style listicle grids, "Top N" educational thumbnails) and let the same content read more playfully. Per-cell upload unlocks the case where the user already has a perfect image for one or two cells (a logo, a screenshot, a stock photo) — today they have to describe it and pray the model renders it close enough. Letting them attach the bitmap directly converts a probabilistic outcome into a deterministic one.

---

## Decisions locked

(From the alignment pass before this plan was written.)

| Question | Answer |
|---|---|
| What does "circled borders" mean? | Each card is a circle. Label sits below the circle in the gutter. No rectangular frame around the circle. |
| How does an uploaded image appear? | Deterministic post-composite — server pastes the user's exact bytes into the cell region. AI is told to leave that cell blank. |
| Where does this live in the UI? | Same Topic Card Grid panel. New `Card shape` toggle + per-card upload button on each row of the review table. |
| Where does the label go for circles? | Below the circle, in the white gutter area between rows. |
| When a cell is uploaded, what about the label? | Same as other cells — user types a label; composite renders it identically. |
| When a cell is uploaded, does the AI render it? | No — the prompt explicitly tells the AI to leave that cell as a clean pure-colored background, no icon. Composite paints over it regardless, so AI compliance is belt-and-braces. |

---

## Anatomy — circles variant

What changes vs. the rectangular layout in `topic-card-grid.ts`:

1. **Canvas + outer margin + gutter** — unchanged. The outer margin and gutter math (`defaultGutter`) carries over.
2. **Cell layout** — instead of one rectangle per cell split top/bottom, the cell becomes:
   - **Illustration disc:** a circle inscribed in the upper portion of the cell rectangle (~75% of cell height as the disc diameter), centred horizontally.
   - **Label band:** a wider-than-the-disc horizontal strip beneath the disc, white background, label text in hand-drawn humanist font (same font as rectangular variant).
   - **No black border, no rectangular outline, no hairline divider.** The disc sits on the canvas's white background; the label sits in the same white background. The grid reads as discs floating on white with text beneath them.
3. **Disc sizing math.** Given a cell rectangle of width `cardW` × height `cardH`:
   - `discDiameter = min(cardW * 0.9, cardH * 0.7)` — capped so labels never get crowded sideways and so labels always have room below the disc. The 0.9/0.7 ratio leaves a small breathing margin around the disc and a 20-25% strip for the label.
   - Disc centre: horizontally centred at `cellX + cardW / 2`, vertically positioned so the disc sits in the top portion of the cell with the label centred below.
   - Label band: centred under the disc, `cardW * 0.95` wide, `cardH - discDiameter - (vertical padding)` tall.
4. **Region rectangles for production-doc** — still rectangles. The disc's *bounding box* is the region. Production-doc consumes rect regions; it doesn't need to know the visual is circular. The region label = the card label, same as today.

---

## Anatomy — per-cell upload

What changes for any cell that has an uploaded image:

1. **Cell shape rendered:** matches the active card-shape mode. Square mode → rectangular illustration area, just like AI cells. Circle mode → circular disc, just like AI cells. The composite respects the active mode.
2. **AI prompt for that cell:** the cell's line in the `CARDS:` enumeration becomes `Label: "<label>" — Illustration: BLANK — render this cell as a clean pure-white background with no illustration, no icon, no text. The label band below is rendered normally.` This is a hard, narrow instruction. If GPT Image 2 ignores it and renders something anyway, the composite step overpaints it — so we get correct output even on AI non-compliance.
3. **Composite step:** server-side, runs after the AI image lands and before the result is uploaded to R2. Pipeline:
   - Decode the AI image bytes.
   - For each uploaded cell:
     - Compute cell bounding box from the existing layout math.
     - Fetch uploaded image bytes from its R2 URL (already uploaded client-side via the same upload helper used for reference images).
     - Resize + cover-crop the uploaded image to the illustration region's exact pixel dims (preserving aspect ratio via centre-crop — matches what users expect when they drop an image into a square or circle slot).
     - Square mode: paste the cropped bytes into the cell's illustration region. Redraw the white label band + label text on top via SVG.
     - Circle mode: apply a circular alpha mask to the cropped bytes (so the corners are transparent), paste into the disc bounding box. Redraw the label below identically to AI cells.
   - Re-encode and upload to R2.
4. **Label rendering for uploaded cells:** sharp doesn't natively do text rendering, but it can rasterise SVG. We generate an SVG with the label text positioned and sized for the label band (matching the AI render's typography conventions — `font-family: 'Caveat', cursive` via a server-side bundled WOFF2 + `<style>` block in the SVG), then composite the SVG layer on top. This is the standard sharp pattern.

---

## API surface changes

### `POST /api/thumbnails/format/topic-card-grid/cards`

Request gains:
- `cardShape: 'square' | 'circle'` (default `'square'`).
- `uploadedCellIndexes: number[]` (1-based, the cells the user has already uploaded an image for). Optional.

Both fields flow into the LLM prompt: the prompt mentions the cardShape (for stylistic guidance — circles tend to suit simpler icons), and the LLM is told which cells are "uploaded — produce a label only, leave icon_concept as the literal string `USER_UPLOADED_IMAGE` so the downstream image step knows to skip its rendering."

### `POST /api/thumbnails/format/topic-card-grid/image`

Request gains:
- `cardShape: 'square' | 'circle'` (default `'square'`).
- `uploads: Array<{ cardIndex: number; imageUrl: string }>` (1-based card index, R2 URL of the uploaded bytes). Optional. The R2 URL must pass the same `assertSafePublicUrl` SSRF guard the reference URL passes.

Response: unchanged shape (`imageUrl`, `regions`, `layout`). The regions array's `x/y/w/h` is the disc's bounding box in circle mode (so production-doc can keep consuming it as a rect).

### New: `POST /api/thumbnails/format/topic-card-grid/upload`

Tenant-scoped upload route for per-cell images. Returns `{ url }`. Mirrors the existing `/api/thumbnails/upload-reference` (or whatever the project's reference uploader is — we'll wire the helper rather than duplicate it). 8 MB cap, PNG/JPEG/WebP only. Uploaded bytes land in `thumbnails/format-grid-cell-upload/<uuid>.<ext>` in R2.

---

## File-by-file changes

### Library

- `src/lib/thumbnail-formats/topic-card-grid.ts`
  - Extend `GridLayout` with `cardShape: 'square' | 'circle'`.
  - New `computeCircleRegions(layout, labels, mkId)` that returns the disc-bounding-box rects for circle mode. Keep `computeRegions` as the square-mode entry. Add a top-level dispatcher `computeRegionsFor(layout, labels, mkId, shape)`.
  - Extend `LlmPromptInput` with `cardShape` + `uploadedCellIndexes`. The system prompt gets a small additional block describing the shape and listing the cells the LLM should mark `USER_UPLOADED_IMAGE`.
  - Extend `ImagePromptInput` with `cardShape` + `uploadedCellIndexes`. Image prompt gets:
    - Circle-mode block when `cardShape === 'circle'`: `Each card is a circle on a white background, label centred beneath the circle in the same hand-drawn humanist font as the reference. No rectangular border. No hairline divider. No label strip — labels float on the white canvas under each circle.`
    - For each `uploadedCellIndexes` index, the cardLines entry's `Illustration:` clause is replaced with `BLANK — render this cell as a clean pure-white background, no illustration, no icon.`

- `src/lib/thumbnail-formats/topic-card-grid-composite.ts` (new)
  - Pure-ish module (uses `sharp`, but no Next.js or React).
  - Exports:
    - `applyCellUploads({ baseImage: Buffer, layout, uploads, cardShape, cards }): Promise<Buffer>`
    - `buildLabelSvg(text, widthPx, heightPx, mode): string` — produces a label SVG sized to the label band/area, with the project's existing humanist font (will need a bundled WOFF2 in `public/fonts/` or `src/lib/fonts/` so sharp can rasterise it deterministically).
    - `circularMaskSvg(diameter): Buffer` — produces an SVG with a centred filled white circle, used as an alpha mask via `.composite({ blend: 'dest-in' })` in sharp.
  - Logs at `[topic-card-grid composite]` namespace per rule 14.

- Tests:
  - `tests/topic-card-grid.test.ts` extends to cover circle region math + the new prompt branches.
  - `tests/topic-card-grid-composite.test.ts` new file — assertion-by-pixel-checksum tests on small synthetic inputs (no external deps, sharp can run in vitest's node env).

### Routes

- `src/app/api/thumbnails/format/topic-card-grid/cards/route.ts`
  - Accept `cardShape` + `uploadedCellIndexes`, pass through to `topicCardGridLlmPrompt`.
  - Validate: `cardShape` is one of the two values; each `uploadedCellIndexes` entry is an integer in `[1, gridRows * gridCols]`.
  - Log at `[thumb-format-grid cards]` (existing namespace) with the two new fields.

- `src/app/api/thumbnails/format/topic-card-grid/image/route.ts`
  - Accept `cardShape` + `uploads`. Validate same as above; validate each `uploads[i].imageUrl` with `assertSafePublicUrl`.
  - Pass to `topicCardGridImagePrompt`.
  - Generate the AI image as today.
  - When `uploads.length > 0`, decode the AI image, run `applyCellUploads`, upload the composited buffer to R2 instead of the raw AI output.
  - When `cardShape === 'circle'`, the regions returned use the disc bounding boxes (call `computeRegionsFor` with the shape).
  - Log at `[thumb-format-grid image]` with `card_shape`, `uploads_count`, `compositor_ms`.

- `src/app/api/thumbnails/format/topic-card-grid/upload/route.ts` (new)
  - `apiRoute.authed`. Multipart upload, 8 MB cap, PNG/JPEG/WebP MIME allowlist, magic-bytes verification (not just trust the MIME header), uploads via the existing R2 helper. Returns `{ url, sizeBytes, contentType }`.
  - Logs at `[thumb-format-grid upload]` with `bytes`, `content_type`.

### UI

- `src/components/thumbnails/TopicCardGridPanel.tsx`
  - Extend `TopicCardGridDraftState` with `cardShape` + `uploads: Record<number, string>` (1-based cell index → R2 URL).
  - Extend `FormatGenerationResult` with `cardShape` + `uploads`.
  - New `Card shape` segmented control next to `Grid size`:
    - `Square` (default) | `Circle`
  - Per-card upload UI in `CardTableState`: each card row gets an upload affordance. Three states:
    - **No upload** → a small `+ Image` button with a paperclip icon.
    - **Upload in progress** → a spinner replaces the button.
    - **Uploaded** → a 32px thumbnail preview, a `Replace` button, and a `×` to clear. When uploaded, the `Icon concept` text input is replaced with a small read-only "Using uploaded image" pill — the icon_concept field is irrelevant for this cell.
  - File picker accepts PNG/JPEG/WebP, max 8 MB. On select, immediately POSTs to `/api/thumbnails/format/topic-card-grid/upload` and stores the returned URL in the panel's `uploads` map.
  - Both new state fields flow into `runStep1`'s body (`cardShape`, `uploadedCellIndexes` derived from `Object.keys(uploads)`) and `runStep2`'s body (`cardShape`, `uploads` as the array).
  - Result state (`ResultState`) honours `cardShape` for the region overlay shape: in circle mode, the overlay draws ellipses (circles within the disc bounding box) instead of dashed rectangles, so the visual feedback matches what was rendered.
  - Hydration: `restoredResult` + `restoredDraftState` both pick up the two new fields.
  - Logs at `[topic-card-grid panel]` for: shape toggle, upload start/done/error, upload clear, hydration.

- `src/app/(app)/thumbnails/page.tsx`
  - Wire the two new draft fields into the workflow-draft writeback.
  - No new top-level UI elements — the panel owns everything.

---

## Sequencing

Ship in three sub-PRs so reviews stay small and each step is independently testable.

**Phase A — Pure module + prompts (no UI, no routes)**
1. Extend `topic-card-grid.ts` with `cardShape` field, circle region math, prompt branches for circles, prompt branches for `USER_UPLOADED_IMAGE` cells.
2. Add `topic-card-grid-composite.ts` with `applyCellUploads`, the SVG label builder, the circular mask builder.
3. Bundle the humanist label font (Caveat or whichever the existing reference uses — verify by inspecting `public/thumbnail-formats/topic-card-grid-default.png` and matching) as a WOFF2 file in `public/fonts/` so the SVG composite has a deterministic font.
4. Unit tests for the new region math, the new prompt branches, and the composite (small synthetic inputs).

**Phase B — API routes**
1. Wire `cardShape` + `uploadedCellIndexes` + `uploads` into the existing `cards` and `image` routes.
2. New `upload` route with the SSRF-safe MIME/magic-bytes-verified handler.
3. Integration test: post `cards` → post `image` with one uploaded cell → assert the composite ran and the uploaded image bytes appear in the result at the expected offset.

**Phase C — UI**
1. Add `Card shape` toggle + per-card upload affordances to the panel.
2. Wire hydration + draft writeback for the new fields.
3. Update the region-overlay shape for circle mode.
4. Manual QA on a real grid generation, both shapes, both upload-and-no-upload paths.

---

## Cost (rule 8)

- **No new paid services.** GPT Image 2 / Kie / OpenAI generation costs are unchanged — the AI still generates the same N×M grid; we just composite over some cells locally.
- **Library:** `sharp` is MIT-licensed, free. Native bindings work on Vercel Fluid Compute. Adds ~30 MB to the server bundle (does not affect the client). Already used by countless Next.js apps on Vercel — well-trodden path.
- **R2:** per-cell uploads consume R2 storage (~50 KB to a few MB per upload). Pricing is the same as the existing reference image uploads. No new pricing concern.
- **Net per-thumbnail cost:** unchanged. Still $0.05–$0.11 per generation.

---

## Security (rule 13)

- **SSRF on uploaded URL.** The `image` route must pass each `uploads[i].imageUrl` through `assertSafePublicUrl` (the same guard the reference URL passes) before fetching the bytes server-side. The R2-hosted URL is trusted, but the contract should not assume the URL came from us — a tampered client could supply any URL.
- **MIME/magic-bytes verification on upload.** The new upload route must not trust the `Content-Type` header alone. Verify the magic bytes match the claimed MIME (PNG `89 50 4E 47`, JPEG `FF D8 FF`, WebP `52 49 46 46 ... 57 45 42 50`) and reject mismatches. Otherwise a user can upload an HTML/SVG file pretending to be a PNG, and sharp's downstream behaviour gets surprising (SVG can embed scripts; even though sharp doesn't execute them, downstream consumers in production-doc might).
- **Upload size cap.** 8 MB per upload. Enforce both at the route (`Content-Length` check + read-cap during streaming) and at sharp (`sharp.limitInputPixels` set sanely; oversized pixel-bombs are a known sharp DoS vector).
- **Path traversal in R2 keys.** Use `randomUUID()` for the key. Never let user input flow into the R2 key path.
- **No PII in logs.** Log byte counts, R2 keys, content types, cell indexes. Don't log image bytes or URLs in error paths — URLs can be quasi-secret (signed-URL access tokens).
- **Auth.** Upload route is `apiRoute.authed` (workspace-scoped). The cards + image routes inherit their existing rate-limit behaviour; no change needed.

---

## Observability (rule 14)

Per-step logs, all bracketed for grep:

- `[topic-card-grid panel] shape toggle` `{ from, to }`
- `[topic-card-grid panel] upload start` `{ cardIndex, sizeBytes, contentType }`
- `[topic-card-grid panel] upload done` `{ cardIndex, r2Url, durationMs }`
- `[topic-card-grid panel] upload error` `{ cardIndex, reason }`
- `[topic-card-grid panel] upload clear` `{ cardIndex }`
- `[thumb-format-grid cards] request` adds `{ card_shape, uploaded_indexes }`
- `[thumb-format-grid image] request` adds `{ card_shape, uploads_count }`
- `[thumb-format-grid image] composite start` `{ cell_count }`
- `[thumb-format-grid image] composite done` `{ duration_ms, output_bytes }`
- `[thumb-format-grid upload] received` `{ bytes, content_type, magic_ok }`
- `[thumb-format-grid upload] done` `{ r2_key, bytes }`

When the composite fails, log the cell index + the specific sharp error verbatim so we can tell whether it's a malformed upload, an oversized pixel-bomb, or a font-loading issue. The user-facing toast stays generic ("Composite failed — try a different image").

---

## Settings (rule 15)

What new knobs does this introduce, and which deserve a settings surface?

- **`Card shape` default (per-workspace).** Some users will only ever want circles; some only squares. Add a workspace setting `thumbnails.topicCardGrid.defaultShape: 'square' | 'circle'` (default `square`). Surfaces in the existing settings layer under the existing `Thumbnails` group if there is one — if not, this becomes a per-user localStorage preference like the existing `topic_card_grid_default_image_model` already is. **Decision: localStorage, mirroring the image-model pref**. The reason: the existing format already uses localStorage for "remember my last pick" on the image model, and a workspace-level setting for shape would be the first new server-side settings entry for this feature — the simpler pattern wins for consistency, and a user can change shape per-generation anyway.
- **Upload size cap.** Hardcoded at 8 MB. Not a user-visible setting — exposing it would invite abuse.
- **Crop strategy.** Hardcoded: centre-cover. We could later expose `crop: 'cover' | 'contain' | 'fit'` per cell, but it's overkill for v1; let users pre-crop in any image editor first if they want a non-centre crop.

The new `Card shape` segmented control sits inline in the panel, next to `Grid size`. No new settings page entry. Defaults: shape = `square`; remembered per-user via the same localStorage pattern as the image-model picker.

---

## UI/UX considerations (rule 16)

- **Card shape control:** segmented (Square | Circle) instead of a dropdown — two options, instant visual scan.
- **Per-card upload affordance:** small thumbnail-preview in the card row when an image is attached; a paperclip + `Image` text when not. The text label `Icon concept` becomes greyed out + reads `Using uploaded image — icon concept ignored` when an image is attached, so the user understands the field is dormant.
- **Loading states:** upload-in-progress spinner is inline, doesn't block other interaction. Generation already has its own loading state which carries over.
- **Empty states:** no change to the "Generate thumbnail" empty state — the new toggles appear only when the user starts working on a grid.
- **Error states:** upload error → toast with the specific reason (file too big / wrong type / network). Composite error in render path → toast saying "Composite failed for cell N" + which cell.
- **Region overlay shape:** must match the visual. Square mode → dashed rectangles. Circle mode → dashed circles. If they don't match, the overlay confuses the user about which area is the "region" for production-doc.
- **Mobile:** the panel is already desktop-only (the thumbnails page is desktop-centric). No new mobile considerations.

---

## Out of scope

These are tempting but explicitly not part of this PR. Bring them back as follow-ups if they prove valuable:

- **Mixed-shape grids** (some cells circles, some squares). Single mode per grid.
- **Per-cell crop UI** with handles. Centre-cover is enough for v1.
- **Drag-to-reorder uploaded cells.** The existing move-up/down arrows already work; uploads travel with their card.
- **Bulk upload** (drop 6 images, auto-assign to cells in order). Could be a clean follow-up but adds confusion for the v1 flow.
- **AI-suggested cropping** ("crop to focus on the logo"). Pre-crop locally if you want that.
- **A separate "Topic Circle Grid" format card.** Same panel, more knobs, less code.

---

## Open questions

None — all decisions locked above. Ship Phase A first; flag any drift before moving to Phase B.
