# Port collage path into the auto-pipeline image-gen stage

**Date:** 2026-05-28
**Status:** implemented (council-revised). See "Council revisions applied" at the bottom.
**Related plans:**
- `_plans/2026-05-24-system-upscale-and-collage.md` — original collage route + slicer.
- `_plans/2026-05-26-collage-default-on-with-per-cell-augmentation.md` — flipped manual bulk to collage-default-on + introduced shared `augmentCellPrompt`.
- `_plans/2026-05-27-doodle-explainer-2-foundation.md` — Stage 4 of which introduced `production-doc-image-gen.ts` (the auto-pipeline image-gen module being extended here).
- `_plans/2026-05-28-doodle-2-character-cache.md`, `2026-05-28-doodle-2-scene-cache.md` — character/scene cache paths that must be respected by the eligibility filter.

## Problem

When the auto-pipeline runs end-to-end (topic → script → production doc → images → thumbnail → render), the `generating_production_doc_images` stage fills every row's image with a single Atlas i2i / Edit call. There is zero collage usage in this path — `src/lib/auto-pipeline/production-doc-image-gen.ts` exposes only `generateBaseImage`, `generateVariantImage`, `generateCharacterContinuationImage`, `generateSceneContinuationImage`, `generateMouthRemovedForCharacter`. None of them call `composeCollagePrompt`, `sliceCollage`, or `/api/generate/production-doc/collage`.

The manual "Generate all missing stills" button in `src/app/(app)/production-doc/page.tsx` does use collage (default-on), but that button is only clicked when the user opens an unfinished doc. The end-to-end auto-pipeline never goes through it.

**Cost impact:** every row the auto-pipeline fills is its own ~$0.011 Atlas call + its own Recraft Crisp Upscale (~$0.0025). A 20-row doc that could have been 5 collage groups (5 generations + 5 upscales) becomes 20 generations + 20 upscales — roughly **4× the spend per video**, on every video the system auto-generates.

## Goal

Make the auto-pipeline's image-gen stage use the collage path for eligible base rows so end-to-end videos pay the same ~75% cost reduction the manual bulk-gen path already enjoys.

## Constraints

- **No quality regression.** Collage cells go through the same `augmentCellPrompt` directives as single-shot, so OST / safe-edge / sheet-desc behavior must remain byte-identical.
- **No new vendor surface.** Reuse the existing Atlas T2I (collage uses Atlas) + Recraft pipeline. No new SKUs.
- **No data migration.** Treat `doc.collage_mode === undefined` as ON (matching the 2026-05-26 flip on the manual path).
- **Cache paths win over collage.** A row with a character_id / scene_id cache hit MUST keep its Atlas Edit continuation — identity preservation is worth more than the ~$0.04 saved per row.
- **Style-ref rows stay single-shot.** The collage route is t2i-only and drops refs; bypassing it for styled rows preserves style consistency.
- **Per-tick budget honored.** A collage chunk of 4 counts as 4 rows against `ROWS_PER_TICK_DEFAULT = 8` so the Vercel 300s ceiling stays safe.

## Approach (recommended)

Add a collage-aware planner inside the stage handler that groups consecutive eligible BASE rows into chunks of 4, calls a new `generateCollageGroup` helper in `production-doc-image-gen.ts`, and falls back to single-shot on any failure or malformed-after-retry. Cache-anchored rows and style-ref rows are excluded from the collage pool and continue through their existing single-shot paths.

### Eligibility filter (per row, evaluated before chunking)

A row is **collage-eligible** when ALL of the following hold:

1. `(row.variant_index ?? 0) === 0` — base row only. Variants are Atlas Edit per row and cannot share a generation call.
2. Row has no character_id hit in `doc.doodle_explainer_2_character_cache`.
3. Row has no scene_id hit in `doc.doodle_explainer_2_scene_cache`.
4. The doc has no `style_preset`, OR the doc's style has zero loaded references (i.e. the row would fall to t2i anyway).
5. The row has no per-row image_model override (mirrors the manual editor's same-model-per-chunk constraint).
6. Row has a non-empty `ai_image_prompt`.
7. Row has no `image_url` set (the existing "is empty" check).

Ineligible rows fall through to the existing per-row branches (i2i / Atlas Edit / cache continuation), unchanged.

### Chunking

Walk eligible rows in DOC ORDER (not arbitrary order — the user expects images to fill top-to-bottom). Greedy: take 4 consecutive eligible rows, form a chunk; advance past them; if the next 4 aren't all eligible, advance one and try again. Any leftover eligible runs of <4 fall through to single-shot. Total rows attempted per tick must still respect `ROWS_PER_TICK_DEFAULT`.

### New helper `generateCollageGroup`

Lives in `src/lib/auto-pipeline/production-doc-image-gen.ts`. Signature:

```ts
export async function generateCollageGroup(args: {
  rows: [PipelineImageRow, PipelineImageRow, PipelineImageRow, PipelineImageRow];
  doc: PipelineImageDoc;
  workspaceId: string;
  ownerId?: string;
}): Promise<{
  results: [PipelineImageResult, PipelineImageResult, PipelineImageResult, PipelineImageResult];
  // Aggregated cost across the 4 cells. Single Atlas T2I + single Recraft +
  // 4× R2 mirror. ~$0.011 / 4 ≈ $0.0028 per row when amortized.
  totalCostUsd: number;
  // True when the route's detect-malformed-after-retry tripped and the
  // caller should fall back to 4 single-shot calls.
  fallbackNeeded: boolean;
  reason?: string;
}>
```

Body mirrors the happy path of `/api/generate/production-doc/collage`:

1. `augmentCellPrompt` per cell with `COLLAGE_CELL_PROMPT_CAP`, source `'pipeline-collage-cell-${i}'`. Inputs: `ai_image_prompt`, `on_screen_text`, `on_screen_text_mode || doc.on_screen_text_mode_default`, `section_title`, `section_title_layout || doc.section_title_layout_default`, `characterDescriptions: doc.doodle_explainer_2_character_descriptions`.
2. `composeCollagePrompt(augmentedPrompts, false)` first attempt; `(prompts, true)` on retry.
3. `generateAtlasT2I({ prompt, size: '1536x1024', quality: 'low' })` (same hardcoded geometry as the collage route — 1536×1024 → crop → upscale → 4 quadrants of ~3K each).
4. `cropTo16x9AndUpload` → `upscaleViaRecraft` → `detectMalformedCollage`.
5. If all-valid: `sliceCollage` → upload each quadrant to R2 → return 4 results.
6. If malformed: retry once with reinforced prompt. On second malformed, return `fallbackNeeded: true`.

**Saliency is OFF on the auto-pipeline collage path for v1.** The route runs `computeImageSaliency` per quadrant; the auto-pipeline already skips saliency on single-shot (`PipelineImageResult` has no saliency field). Keeping the behavior consistent. Saliency on the auto-pipeline is its own follow-up.

### Stage handler changes (`generate-production-doc-images.ts`)

1. Compute `collageOn = doc.collage_mode !== false` once per tick.
2. If on, run the eligibility filter + chunker to build `[CollageChunk | SingleRow]` work units.
3. Per tick budget (`ROWS_PER_TICK_DEFAULT = 8`): a collage chunk costs 4 row-credits; a single row costs 1.
4. For each collage chunk:
   - Mark all 4 rows `loading` (status pillars upstream are file-based; this handler writes back to `metadata_jsonb`, so the persisted `image_url` field is what the editor reads — no "loading" status field on the persisted doc, just empty `image_url` until success).
   - Call `generateCollageGroup`. On success: write all 4 URLs in one DB UPDATE.
   - On fallback: per-row single-shot in chunk order. Telemetry tags fallbacks as `collage_fallback_per_row` so we can monitor fallback rate.
5. For each single row: existing branch.

### Telemetry

New log lines, all tagged for grep parity with existing pipeline logs:

- `[pipeline image-gen collage] eligibility` per tick — counts eligible / ineligible reasons (cache_hit / style_refs / variant / model_override).
- `[pipeline image-gen collage] start` per chunk with row indices + model + prompt char count.
- `[pipeline image-gen collage] success` per chunk with cost_usd.
- `[pipeline image-gen collage] malformed` per failed attempt with quadrant indices + heuristic that tripped.
- `[pipeline image-gen collage] fallback` per chunk that fell to single-shot, with reason.
- `[pipeline image-gen collage] cost-rollup` per tick — collage_cells vs single_cells, total spend.

### Alternatives rejected

- **B: don't port; rely on manual bulk button after auto-pipeline fills nothing.** Regresses the "video appears ready end-to-end" UX. The point of the auto-pipeline is the user clicks once and walks away.
- **C: port collage to ALL rows including styled ones (drop style refs on the collage call).** Cheaper but silently regresses style consistency on styled docs. Wrong trade.
- **D: bump auto-pipeline concurrency on single-shot.** Solves a different problem (latency, not cost). The cost ratio is the same regardless of concurrency.
- **E: change collage to call `generateAtlasI2I` so style refs work.** Vendor doesn't support multi-ref collage composition without a custom prompt format we haven't validated. Out of scope for this plan.

## Security and safety

- No new external surface. The collage path already exists, is rate-limited at the route, and is trusted-internal from auto-pipeline (no rate-limit wrapping, matching the existing `generateBaseImage` posture).
- Per-cell prompts are sanitized inside `augmentCellPrompt` (newline strip, length cap) — same as today.
- No new secrets. Reuses `ATLAS_CLOUD_API_KEY` already provisioned.
- Stage-handler failure modes (Vercel timeout mid-tick, partial chunk write) covered by the existing `if (row.image_url) skip` idempotency — a re-run picks up where the previous tick stopped without double-spending.
- A malicious doc with carefully-crafted `ai_image_prompt` cannot escape the prompt sandbox via collage any more than via single-shot (same sanitizer applies).

## Observability

(Covered under Telemetry above.) Every step that emits cost surfaces a log line tagged with `[pipeline image-gen collage]` namespace. The stage handler aggregates per-tick `cost-rollup` so `/qa-stats` (or the eventual cost dashboard) can show collage adoption rate over time.

## Settings audit

- `doc.collage_mode` (boolean) — ALREADY EXISTS at the doc level. The auto-pipeline now reads it (same default-on semantics as the manual path). No new doc-level setting.
- No new workspace setting. The doc-level toggle already gives per-doc opt-out, which is the right granularity (workspace-wide opt-out would silently regress every video; per-row would create confusing partial collage behavior).
- No new UI surface needed — the toggle already lives in the production-doc Settings panel.

## Pricing impact

Reduction, not addition. Verified pricing reference: `_plans/2026-05-24-system-upscale-and-collage.md` (Atlas T2I @ $0.011/call, Recraft Crisp Upscale @ $0.0025/call). A 20-row collage-eligible doc:

- **Today:** 20 × ($0.011 + $0.0025) = $0.27.
- **After this plan:** 5 × ($0.011 + $0.0025) + 0 × singles = $0.0675.
- **Saving:** ~$0.20 per fully-eligible 20-row doc, ~75% cost reduction.

Real impact depends on the eligibility mix per doc — docs with heavy character/scene caching reuse those (no collage, but no double-pay either — character continuation is its own ~$0.011 Edit call). The cost win lands hardest on doodle-style docs WITHOUT character/scene anchoring, and on built-in-style docs.

## Open questions

1. **2560×1440 vs 1536×1024 for character/scene continuation Atlas Edit calls.** `src/lib/image-edit-pricing.ts:256-262` documents that Atlas Edit returns 404 on 2560×1440 (verified 2026-05-27). But `production-doc-image-gen.ts:571,659` use 2560×1440 for character/scene continuation (added 2026-05-28). Either the 404 finding was T2I-only and Edit accepts it, or those continuation calls are silently failing in production. **Need to verify before this plan ships, because the eligibility filter excludes cache-hit rows from collage — meaning every cache-hit row depends on Edit working at 2560×1440. If Edit at 2560×1440 IS broken, the fix is independent (drop to 1536×1024 + crop) and lands before this plan.**
2. **Fallback rate visibility.** No existing dashboard for per-tick / per-doc collage success rate. Acceptable for v1 (logs are enough), but worth tracking if fallback rate exceeds ~15% in early days.
3. **Tail < 4 chunks.** Doc with 7 eligible rows → 1 chunk of 4 + 3 singles. The 3 tail singles each pay the full single-shot rate. Alternative: lower the eligibility bar to chunks of 3 (with one blank cell). Rejected for v1 — blank-cell composition is untested with the current `composeCollagePrompt` template, and the cost win on the tail is small.
4. **Order of operations across cache+collage docs.** A doc that mixes 6 character-anchored rows and 8 non-anchored rows: do character bases come first (so their cache is warm before subsequent rows reference it) or do non-anchored chunks come first (so the user sees faster initial fill)? Current stage handler processes top-to-bottom; this plan preserves that. Worth flagging in the council pass.

## Surfaces changed

1. **`src/lib/auto-pipeline/production-doc-image-gen.ts`** — add `generateCollageGroup`. Import `composeCollagePrompt`, `sliceCollage`, `detectMalformedCollage` (currently route-only).
2. **`src/lib/auto-pipeline/stages/generate-production-doc-images.ts`** — add eligibility filter + chunker; route collage chunks through the new helper; per-tick cost rollup log.
3. **`tests/auto-pipeline-collage-eligibility.test.ts`** (new) — covers: cache-hit row excluded, variant excluded, style-ref row excluded, model-override excluded, mixed eligible / ineligible doc order preserved, fewer-than-4-eligible falls to single, ROWS_PER_TICK budgeting.
4. **`tests/auto-pipeline-collage-fallback.test.ts`** (new) — covers: malformed-after-retry path triggers 4 single-shot calls; partial-failure attribution; cost rollup math.
5. **`ROADMAP.md`** — entry under image-gen / collage / auto-pipeline.

## Out of scope

- Saliency on the auto-pipeline collage path (route does it; pipeline already skips saliency).
- Cost dashboard / `/qa-stats` integration beyond log lines.
- Eligibility relaxation for styled docs (would require a multi-ref collage prompt template — separate plan).
- Tail chunks of <4 cells.

## Council revisions applied (2026-05-28)

Pressure-tested through the LLM council. Resulting changes from draft → shipped:

1. **Eligibility filter completeness.** Council flagged that the draft was missing two row types that MUST be excluded:
   - `paint_explainer_v1` rows with `motion_beats.length > 0` — paint uses Atlas Edit sibling frames built FROM the base; the base must exist as a single coherent frame, not a sliced quadrant.
   - Rows with `mouth_removed_url` populated — the `<MouthSwap>` overlay requires pixel-perfect alignment with the underlying base, which a slice can't guarantee.
   - Both implemented as new branches in `isCollageEligibleRow` in `production-doc-image-gen.ts`.
2. **Per-tick budget math fixed.** Original draft treated a chunk as 4 row-credits. Council pointed out that on `fallbackNeeded: true`, the same chunk costs 4 + 4 = 8 calls in one tick (collage attempt + 4 single-shot fallbacks), and could time out mid-fallback leaving half-written chunks. Resolution: each scheduled chunk reserves `collageBudgetPerChunk = 8` credits up front. A default tick with `ROWS_PER_TICK_DEFAULT = 8` schedules AT MOST ONE collage chunk and zero other work. paint_explainer_v1 docs are excluded from collage entirely (different per-tick budget, plus motion-beat requirement).
3. **`paint_explainer_v1` docs skip collage entirely.** Not just on a per-row eligibility basis — the stage handler checks `isPaintExplainerV1` once and routes the whole doc to single-shot. The mouth-removed / vision-pass chain requires a stable base frame per character that the collage path can't reliably deliver.
4. **Loud failure logging.** Council flagged the swallow-warn pattern. All five `production-doc-image-gen.ts` catches (base / variant / mouth-removed / character-continuation / scene-continuation / collage) now log at `logger.error` level with `[atlas-edit-failed pipeline <stage>]` namespace. Collage adds a sixth catch with the same shape.
5. **Variant readiness includes scheduled collage indices.** A variant whose source row is in a scheduled collage chunk now correctly waits for the NEXT tick (was previously eligible to fire this tick with a source that wasn't yet generated). One-line fix: `inFlightBaseIndices` includes `scheduledCollageIndices`.
6. **Style refs check is eager.** `resolveStyle` + `loadStyleReferences` runs once at the top of the tick (was implicit per-row in the original draft). If the doc has loaded style refs, every base is collage-ineligible — calling the route in t2i mode would silently drop the refs and regress style consistency.
7. **`generateCollageGroup` signature accepts a 4-tuple of `PipelineCollageCellInput`, not `PipelineImageRow[]`.** Expansionist council member suggested `cells: PipelineImageRow[]` with a `gridShape` arg for future 3×3 / NxM extension. Rejected for v1 (over-engineering for a feature that isn't on the roadmap), but the tuple shape is intentionally a separate type from `PipelineImageRow` so a future v2 can extend without breaking the row shape.

What didn't change from the draft: chunks of 4 (route hardcodes 2×2 template), Atlas T2I @ 1536×1024 → crop → Recraft, fallback to single-shot on malformed-after-retry, doc.collage_mode default-on semantics, eligibility filter EXcluding character/scene cache hits + styled docs + variants + model overrides. Saliency still skipped on the auto-pipeline path (route does it; pipeline doesn't).

### Open question NOT yet resolved

Already-published videos may have shipped with character drift because the cache was silently bypassed when Atlas Edit 404'd at 2560×1440 between 2026-05-28 and the hotfix. The council asked whether they need recall / regeneration / user notification. Decision deferred to product — no automated remediation in this plan.
