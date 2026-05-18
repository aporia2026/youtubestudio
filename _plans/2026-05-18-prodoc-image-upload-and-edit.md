# Production-doc image cell: upload + smart edit + brush mask

**Date**: 2026-05-18
**Branch**: phase-1-foundation
**Status**: approved by user, ready to implement

## Problem

The production-doc table's Image column currently exposes one action per
row: a `+ Generate` button that runs text-to-image via Kie.ai
(`/api/generate/production-doc/image`, see
[src/app/api/generate/production-doc/image/route.ts:87](src/app/api/generate/production-doc/image/route.ts#L87)).
The cell has two real gaps the user hit:

1. **No way to attach an image the user already has.** If a creator has a
   reference photo, a screenshot, or an existing asset, they can't put it
   on the row. They have to upload it manually somewhere else and hope
   the renderer picks it up — it won't, because the renderer reads
   `rowImages[i].imageUrl` only.

2. **No way to edit a generated image.** Once an image is on the row, the
   only action is `↻ regenerate from scratch`. There's no path to "keep
   this image but change the kid's shirt to red" or "redo only the top
   third". Re-rolling burns money and the next roll is rarely "almost
   right" again — losing the parts that worked is the main cost.

## User-confirmed decisions

| Question | Answer |
|---|---|
| Scope | **Production-doc table only** for v1. Don't fan out to thumbnails / shorts / generator yet. |
| Edit flavours | **Both** — smart prompt edit AND brush mask. One ✎ button, two tiers behind it. |
| UX shape | **Option A — inline buttons.** `Generate / Upload / From URL` side-by-side in the idle cell; ✎ overlay on the ready image. |
| Saliency on uploads | **Yes** — uploads run through the same saliency pipeline so overlay placement keeps working. |
| Cost transparency | Tier 1 (Nano Banana 2 smart edit) ~$0.02/edit. Tier 2 (GPT-4o Image with mask) $0.02 / $0.07 / $0.19 per edit at low/med/high. Default brush quality = **medium**. |

## Approach

Four discrete pieces, in this order:

### Part 1 — Upload action (smallest, ships first)

**Reuse**: the presigned-PUT flow at
[src/app/api/uploads/thumbnail-reference/route.ts](src/app/api/uploads/thumbnail-reference/route.ts).
That route is misnamed (it's a generic image upload to the R2 images
bucket, not thumbnail-specific) but functionally identical to what we
need. The thumbnails page calls it at
[src/app/(app)/thumbnails/page.tsx:315](src/app/(app)/thumbnails/page.tsx#L315) — we mirror that.

**Rename** the route to `/api/uploads/image` and keep
`/api/uploads/thumbnail-reference` as a one-line re-export so the
thumbnails surface keeps working without churn. The R2 key prefix
becomes `user-uploads/` (was `thumbnail-references/`) — old uploads
keep working because their full URL is stored verbatim on the row.

**UI**: extend `ImageCell` idle-state at
[src/app/(app)/production-doc/page.tsx:881-918](src/app/(app)/production-doc/page.tsx#L881-L918):

```
[ + Generate ]  [ ⬆ Upload ]  [ 🔗 URL ]
```

- `⬆ Upload` opens a hidden `<input type="file" accept="image/*">`.
  On change: presigned PUT, set the row's state to
  `{ status: 'done', imageUrl: downloadUrl, source: 'upload' }`,
  then fire-and-forget a saliency POST (see Part 4).
- `🔗 URL` opens a tiny inline input. On submit: server-side validates
  the URL (HTTPS only, no private IPs — copy the SSRF block from
  [src/app/api/thumbnails/image/route.ts:99-120](src/app/api/thumbnails/image/route.ts#L99-L120)),
  fetches the image, mirrors it to R2 (matches the pattern at
  [src/app/api/generate/production-doc/image/route.ts:231-250](src/app/api/generate/production-doc/image/route.ts#L231-L250)),
  returns the R2 URL, and the cell sets state the same way as Upload.

**Row state shape** — add a `source: 'generated' | 'upload' | 'url' | 'edit'`
discriminator on `RowImageState['done']`. Used downstream for:
- A small badge in the cell ("📷 uploaded", "✎ edited") so the
  editor knows what they're looking at without inspection.
- Skipping the "regenerate with original prompt" path on the ↻ button
  for uploaded images — there is no prompt. The ↻ icon is replaced
  with the ✎ pencil for those rows.

### Part 2 — Tier 1: smart edit via Nano Banana 2

**Model**: `google/nano-banana-edit` (current) with `google/nano-banana-pro`
as the higher-fidelity option. Verified via
[Kie.ai docs](https://docs.kie.ai/market/google/nano-banana-edit):
takes `image_urls: [originalUrl]` + `prompt` + `output_format` +
`image_size`. No mask field. Model uses semantic segmentation to
locate the edit region from the prompt. Pricing: ~$0.02 (standard),
~$0.12 (Pro).

**New API route**: `/api/generate/production-doc/image/edit/route.ts`.
- POST body: `{ originalImageUrl, prompt, model: 'nano-banana-edit' | 'gpt-4o-image-edit', mask?: { url: string; quality: 'low' | 'medium' | 'high' } }`.
- Validates `originalImageUrl` with the same SSRF block used elsewhere
  (HTTPS, no private IPs).
- Branches on `model`:
  - `nano-banana-edit` → posts to Kie's `createTask` with
    `model: 'google/nano-banana-edit'`, `input: { prompt, image_urls: [originalImageUrl], image_size: '16:9', output_format: 'png' }`.
  - `gpt-4o-image-edit` → posts to `/api/v1/gpt4o-image/generate` with
    `{ filesUrl: [originalImageUrl], maskUrl: mask.url, prompt, size: '3:2' (closest to 16:9), quality: mask.quality }`.
- Reuses `pollForResult` from the existing image route — extract it to
  `src/lib/kie-poll.ts` so both routes share one implementation. The
  current copy is 95 × 3s = 285s which is the right ceiling for both.
- Mirrors the result to R2 (same `getImagesBucket` / `uploadToBucket`
  pattern as the generate route).
- Recomputes saliency on the new image and returns
  `{ imageUrl, saliency }`.

**UI**: on a `state.status === 'done'` cell, the existing ↻ overlay
button becomes a pair: `↻` (regenerate from prompt — keep current
behaviour for generated rows, hide on upload rows) and `✎` (edit).

Clicking ✎ opens a compact panel anchored to the cell (mirror
[ImageLightbox at page.tsx:847-878](src/app/(app)/production-doc/page.tsx#L847-L878)
for the styling baseline — but smaller, not a fullscreen lightbox):
- A `<textarea>` for the edit prompt.
- A `[Paint a region instead…]` link that opens the brush modal
  (Part 3). The link is visually quiet — Tier 1 is the default.
- A model picker dropdown: "Smart (Nano Banana) · ~$0.02" vs
  "Smart Pro (Nano Banana Pro) · ~$0.12". Default: standard.
- `Apply` button. While generating: spinner + cancel.
- Result preview alongside the original in a before/after layout.
  Two buttons: `Use this` (replaces the row's image) and
  `Discard` (closes the panel, row untouched).

**State during edit**: the row's existing `imageUrl` stays mounted
in the cell. The edit happens in a separate panel-local state. Only
on `Use this` do we mutate the row. Reason: an aborted or bad edit
should never destroy the user's current image.

### Part 3 — Tier 2: brush mask via GPT-4o Image

This is the bulk of the work. **Estimate: ~1 day of solid build.**

**New component**: `src/components/production-doc/MaskBrushEditor.tsx`.

Plain HTML5 Canvas2D, no library. Three layers stacked at the same
size as the source image (we read its natural dimensions on load):

1. **Image layer** — `<img>` rendered into a canvas via `drawImage`.
2. **Mask layer** — a second canvas, fully transparent at start. The
   user paints onto it in red (`rgba(255,0,0,0.5)`) for visual
   feedback. This is what we export when they hit Apply.
3. **Cursor layer** — a third canvas that follows mouse position to
   render a brush-size halo. Pure UX, never read.

Tools (right-side toolbar inside the modal):
- Brush size slider (8 - 200 px).
- Brush / eraser toggle.
- Clear button (wipe the mask).
- Invert button (everything painted becomes unpainted and vice versa
  — useful when the user accidentally painted background).

**Mask export**: at Apply time, we render the mask layer to a fresh
offscreen canvas at the source image's natural dimensions with
**black pixels** wherever the user painted (any alpha > 0) and **white**
everywhere else. PNG export, base64 → blob → presigned PUT (same
upload flow as Part 1). Returns a public R2 URL we pass as `maskUrl`.

The exported mask is **transient**: stored under
`mask-uploads/{date}-{rand}.png` with a short R2 lifecycle rule (we
already have lifecycle on the images bucket; if not, we set one
during this implementation — 7-day expiry is plenty for an edit
mask). Not linked to the row. Not visible to other users. Not
written to the doc state.

**Quality picker**: low / medium / high — surfaced as a small
dropdown next to Apply with the per-edit price visible
("medium · $0.07"). Default medium.

**Modal lifecycle**:
- Opens as a centered overlay covering the page (style mirrors
  [ImageLightbox](src/app/(app)/production-doc/page.tsx#L847-L878)
  but with the toolbar / preview frame layout).
- ESC closes (confirms if mask has unsaved paint).
- After Apply: spinner state, then before/after side-by-side, same
  `Use this` / `Discard` flow as Part 2.

### Part 4 — Saliency on uploads

The existing generate route computes saliency at
[src/app/api/generate/production-doc/image/route.ts:252-260](src/app/api/generate/production-doc/image/route.ts#L252-L260)
via `computeImageSaliency(imageBuffer)` from
[src/lib/image-saliency.ts](src/lib/image-saliency.ts). For uploads
and URL-mirrors, we currently skip this.

**New API route**: `/api/images/saliency/route.ts`.
- POST `{ imageUrl }`.
- SSRF-validates the URL.
- Fetches the buffer, computes saliency, returns `{ saliency }`.
- Authed. No DB write — caller persists onto the row.

**Caller wiring**: after `Upload` or `From URL` succeeds, fire-and-forget
the saliency POST. On response, the cell calls back to the page-level
`setDoc` to update `image_saliency` + `overlay_zone_resolved` +
`overlay_size_resolved` on the row (mirror the block at
[page.tsx:3219-3258](src/app/(app)/production-doc/page.tsx#L3219-L3258)).

Saliency failure is silent — the existing fallback (LLM-planned zone)
takes over. Same robustness contract as today.

The edit route in Part 2 already returns saliency in its response, so
no separate call needed for edits.

## File changes

**New files** (5):
- `src/app/api/uploads/image/route.ts` (renamed from `thumbnail-reference`)
- `src/app/api/uploads/thumbnail-reference/route.ts` (1-line re-export shim)
- `src/app/api/generate/production-doc/image/edit/route.ts`
- `src/app/api/images/saliency/route.ts`
- `src/components/production-doc/MaskBrushEditor.tsx`
- `src/lib/kie-poll.ts` (extracted from existing inline implementations)

**Edited files** (3):
- `src/app/(app)/production-doc/page.tsx` — `ImageCell` gains the new
  buttons + edit panel + brush integration. `generateImageForRow` gains
  a sibling `editImageForRow(rowIndex, originalUrl, prompt, mask?)`.
  `RowImageState['done']` gains `source` discriminator.
- `src/app/api/generate/production-doc/image/route.ts` — import the
  extracted `pollForResult` from `src/lib/kie-poll.ts`.
- `src/app/api/thumbnails/image/route.ts` — same poll-extraction
  import. No behaviour change.

## Alternatives rejected

- **Flux Kontext for edits.** No mask field, only whole-image prompt
  edits. Redundant with Nano Banana 2 and offers nothing unique.
  Verified at [Kie.ai Flux Kontext docs](https://docs.kie.ai/flux-kontext-api/generate-or-edit-image).
- **Drawing the mask as SVG instead of canvas.** Canvas exports to PNG
  in one line (`canvas.toBlob`). SVG → PNG conversion is a chore. No
  upside.
- **Splitting upload between `Upload` and `From URL` into two buttons
  vs one menu.** Two buttons is more discoverable per rule 10. The
  cost is 60 px of horizontal space, which the cell has.
- **Opt-in saliency on uploads (a checkbox).** Adds friction for zero
  perceptible benefit. Saliency is cheap and only improves overlay
  placement — keep it on by default. Failure is already silent.
- **Reusing `/api/thumbnails/image` for the production-doc edit
  endpoint instead of a dedicated `/edit` route.** The thumbnails
  route's contract is shaped around the thumbnails surface (its own
  model registry, its own rate-limit key). Forking now is cheaper
  than coupling them and untangling later.
- **Brush mask v0 in v1.** I floated "ship Tier 1 alone, add the brush
  later." User picked both. Accepting the extra day for the brush; the
  recommendation stands that ~80% of edits will use Tier 1 in practice.

## Security & safety (rule 13)

- **SSRF on URL imports.** Both `/api/uploads/image` (the URL branch)
  and `/api/generate/production-doc/image/edit` must validate the
  input URL: HTTPS only, block private/internal IPs. Copy the block
  from [thumbnails/image/route.ts:99-120](src/app/api/thumbnails/image/route.ts#L99-L120) verbatim. Already used elsewhere in the repo.
- **File-type allowlist on upload.** Current presign route accepts
  jpeg/png/webp/gif only (size cap 10 MB) — keep that.
- **Mask upload is a separate write path** — same R2 bucket, different
  key prefix (`mask-uploads/`). Apply a 7-day lifecycle rule so masks
  don't accumulate.
- **Auth.** Every new route uses `apiRoute.authed` (same pattern as
  the existing presign route). Anonymous callers cannot mint presigned
  URLs, edit images, or run saliency.
- **Rate limit.** Edit route: 20 calls per 60s per IP (the generate
  route is 30; edit is slightly more expensive). Saliency route: 60
  per 60s — it's just a CPU job, cheap.
- **Prompt length cap on edit prompts.** 2000 char ceiling like the
  generate route, same rationale.
- **No PII or secret logging.** The cell logs row indices and clip
  ids today; the edit path follows that pattern. We do not log prompts
  in full (truncate to 200 chars in any `console.info`).
- **Cost ceiling.** Brush mask edit can hit $0.19/call at high quality.
  Default to medium. Surface the per-call price next to the Apply
  button so the user sees it before they spend.

## QA plan

Per CLAUDE.md rule 6 — golden path, edge cases, error paths,
regressions in adjacent code:

**Golden path**
- Generate an image normally → cell shows it. Existing behaviour, regression check.
- Upload a 2 MB JPG → presigned PUT succeeds → cell shows it with "📷 uploaded" badge → saliency populates within a few seconds.
- Click ✎ on a generated image → type "make it night-time" → Nano Banana smart edit returns a new image → click `Use this` → cell updates, original is gone.
- Click ✎ → "Paint a region instead" → paint over the sky → type "stormy sunset" → Apply at medium quality → result returns with only the sky changed → `Use this`.

**Edge cases**
- Upload a 12 MB image → API rejects with the 10 MB cap message.
- Upload a `.tiff` → API rejects (allowlist).
- URL import with `http://` → 400.
- URL import to `192.168.x.x` → 400 (SSRF).
- Edit on an uploaded image → works (the source field is just a URL, model doesn't care about provenance).
- Edit with an empty prompt → 400.
- Brush modal opened, user closes without painting → no R2 write happens (we only upload on Apply).
- Brush modal opened, user paints, closes via ESC → confirm dialog, mask never persisted.
- Image being edited at the exact moment the cell remounts (page refresh) → in-flight edit is lost (acceptable; it's a fire-and-cancel UI, not persisted state).

**Error paths**
- Nano Banana returns a 422 (policy reject) → user sees the actual Kie error, not a generic "Failed".
- GPT-4o Image times out at 285s → polled error surfaces. Apply button re-enables.
- Saliency fetch fails post-upload → cell stays usable, no error toast, overlay falls back to LLM zone (existing behaviour).
- R2 presign returns 503 → toast "Cloudflare R2 storage is not configured" (existing behaviour from the presign route).

**Regression checks**
- ↻ button on a generated image still re-runs the original t2i flow.
- "Generate empty" bulk action ([page.tsx:2398](src/app/(app)/production-doc/page.tsx#L2398)) is unaffected.
- Animate (B-roll i2v) still picks up the row's `stillImageUrl`
  regardless of whether the still came from generate, upload, URL, or
  edit. The downstream contract is "give me an https URL" — none of
  the new paths break that.
- Saved doc → reload → uploaded image survives (it's just a URL in the persisted row state, no special hydration needed).

## Open questions

None blocking. Two items to decide during implementation:

- **Brush modal: do we surface the GPT-4o quality price live as the slider moves, or at Apply time only?** Live is more honest; at-Apply is less noisy. Default to live.
- **Should "Use this" be irreversible, or do we keep one undo step?** Cheapest win: a small `↶ Undo` link in the cell for ~30 seconds after an edit replaces the image, in-memory only. Worth doing if it's ~10 lines. Will assess during build.

## Out of scope

- Multi-image edits (Nano Banana supports up to 10 input images for
  combining; we're not using that here).
- Edits on the thumbnails surface, shorts, generator, or other image
  cells. Production-doc only for v1.
- Style transfer (e.g. "make it look like Studio Ghibli") via a
  preset library. The prompt box covers it for now.
- Saving edit history. Each edit replaces the row's image. The
  generation history surface ([HistoryPanel](src/components/ui/HistoryPanel.tsx))
  is for full doc generations, not per-cell edits.
