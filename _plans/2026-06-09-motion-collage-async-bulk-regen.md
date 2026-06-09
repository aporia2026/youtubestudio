# Motion-collage: server-side async bulk regen

Date: 2026-06-09
Status: Phase 1 + Phase 2 + caveat fixes + Phase 3 (editor polling) shipped. Follow-up (restore 3×3 default) pending production verification.

## Resolution of the prereq questions

1. **Auto-pipeline kick endpoint:** EXISTS at `POST /api/auto-pipeline/tick`. Session-authenticated, single-flight guard via `withCronLock`, processes up to 3 videos per call. Reused as-is.
2. **Polling cadence:** `ImageGenProgress.tsx:24` polls every 8 seconds against `/api/auto-pipeline/videos/[id]/image-progress`. Editor doesn't currently use it; left as a follow-up.
3. **Per-uid rate limit:** kept at 5/min/uid (10/min/IP). Easily widened if observed traffic argues for it.
4. **Per-call cost cap:** $10 default via `MOTION_COLLAGE_BULK_REGEN_CAP_USD` env var. ~12 max-grid Kie collages in one batch.
5. **Partial-failure handling:** the existing `attempts` + `last_error` row fields are already populated by `generateMotionCollage` failures. The change-model endpoint pattern (re-activate `production_doc_images_failed` → `generating_production_doc_images`) ships in this PR too.

## Phase 1 — what shipped (commit `<filled in at commit time>`)

## Problem

The editor's bulk **"Generate all motion collages"** and **"Regenerate all motion collages"** buttons fire N fetches sequentially from the browser. Each fetch synchronously calls `/api/generate/production-doc/motion-collage`, which has Vercel's hard `maxDuration = 300` seconds. After the 2026-06-09 changes (Kie vendor support + 3×3 default), a single 9-panel collage on Kie takes ~660 s — every fetch 504s. After the 03ac5b42 revert back to 2×2, the per-call duration fits inside 300 s on both vendors, but the architecture is still fundamentally fragile:

1. **Browser tab must stay open** for the entire batch. 5 collages × ~5 minutes = 25 minutes of "don't close the tab." User reported clicking regen, walking away, coming back hours later to find nothing changed.
2. **No persistence of in-flight work.** If the user navigates away mid-batch, the in-flight fetches die and the rows that hadn't completed keep their old URLs.
3. **The 3×3 default we wanted to keep for motion quality is gone**, because the per-call duration headroom doesn't exist on Kie.

The fix needs to:
- Process bulk regen server-side, asynchronously, with persistent progress.
- Survive the user closing the browser tab.
- Allow per-collage durations longer than 300 s (so 3×3 / 4×3 grids are viable on Kie).
- Reuse as much existing infrastructure as possible.

## Goals

1. **Click → walk away → come back done.** User clicks "Regenerate all motion collages", browser shows "queued N rows" toast and returns immediately. Rows persist as "needs regen" on the server. User can close the browser, come back hours later, and find every row's panels regenerated.
2. **Per-collage duration independent of 300 s Vercel limit.** A 9-panel collage on Kie that takes 12 minutes server-side still completes. No per-call timeout pressure.
3. **Same panel quality, same costs.** This is an orchestration change. Each panel still costs the same; the chained Atlas Edit / Kie i2i contract for each panel is unchanged.
4. **Bring back the 3×3 default** once duration pressure is gone (see §"Follow-up — restore 3×3 default" below).

## Non-goals

- No change to single-shot "Generate all N panels" in the per-row inspector. That fits in 300 s for 2×2 and is responsive enough; not worth reworking.
- No change to single-shot non-collage Regenerate (already fits in 300 s for any model).
- No change to the auto-pipeline's existing initial-doc-generation path. That already works async; this plan extends the same pattern to user-initiated bulk regen.
- No new vendor or new model. Atlas + Kie continue as today.

## Approach

Two phases. Phase 1 fixes the "browser tab must stay open" problem for 2×2 grids. Phase 2 removes the per-collage duration ceiling so larger grids work.

### Phase 1 — Enqueue + auto-pipeline drive (the bulk experience)

**New endpoint:** `POST /api/generate/production-doc/motion-collage/bulk-regen`

Request body:
```ts
{
  videoId: string;
  rowIndices: number[];  // Indices of motion_collage rows to regen
}
```

Behavior:
1. Authenticate via existing `apiRoute.authed` wrapper. Verify the caller owns the video's workspace.
2. Rate limit: 5/min/uid (bulk operations are expensive; this is a "I want a batch" rate, not per-row).
3. For each `rowIndex` in the request:
   - Load the row from the persisted production-doc.
   - Validate it's `shot_kind === 'motion_collage'` with a valid grid + prompts.
   - **Clear `motion_collage_panel_urls`, `motion_collage_image_url`, and `image_url`** on the row (this is what marks it for regen — the auto-pipeline's stage handler picks up rows whose URLs are blank).
   - Save the production-doc.
4. **Kick the auto-pipeline** for this video via an internal trigger (see §"Kicking the pipeline" below).
5. Respond `200 OK` with `{ queued: number, estCostUsd: number }`.

The endpoint does no AI calls. It returns in <1 s. The browser can close immediately after.

**Editor changes:**
- The existing bulk modal stays. Its confirm handler swaps from the sequential `fetch + PATCH_ROW` loop to a single call to `/bulk-regen` with the row indices.
- Success toast: `"Queued N motion collages. They'll appear here as they finish — feel free to close this tab."`
- Add a small "Queued for regen" badge to motion-collage rows whose URLs were just cleared, so the user sees visual feedback that "the system received the request."
- Editor's existing polling — `/api/auto-pipeline/videos/[id]/image-progress` (already exists) — will surface "rendering" status on rows during the pipeline tick. When a row completes, the polled state shows URLs filled in. Editor's normal reactive rendering picks up the change.

**Auto-pipeline stage handler:**

Already implemented at `src/lib/auto-pipeline/stages/generate-production-doc-images.ts:688`. It calls `generateMotionCollage` for rows that need regen. After commit `daeec72e` it correctly forwards `pickedModel = row.image_model_override || doc.image_model_default`. No changes needed.

**Kicking the pipeline:**

The auto-pipeline runs on a cron. To avoid making the user wait for the next scheduled tick (worst case ~10 minutes), the bulk-regen endpoint should kick the pipeline immediately:
- Option A: Internal HTTP call to the auto-pipeline cron endpoint (it's idempotent — if a tick is already running for this video, the kick is a no-op).
- Option B: Direct in-process call to the tick function (skips HTTP, but tightens coupling).
- Option C: Database flag (`pending_kick`) that the next cron poll picks up. Simpler but slower.

Pick A. Mirrors the "Kick asset cron" pattern in the recent shorts-batch commit (`89fff7ce`) that's already proven.

**Status & polling:**

The editor already polls `/api/auto-pipeline/videos/[id]/image-progress` for in-flight rows. After this PR, the polled progress will include motion-collage rows that were just queued. No new polling endpoint needed.

A small UI affordance: when a row has its URLs cleared but the auto-pipeline hasn't started processing yet, show "Queued" instead of "No image". When the pipeline starts processing, the progress endpoint surfaces "rendering" — editor shows a spinner. When done, the URLs fill in via the existing PATCH_ROW dispatch in the polling loop.

### Phase 2 — Per-collage chunked progress (restore the 3×3 default)

Once Phase 1 ships, the per-collage 300 s ceiling is still the limiting factor: a 9-panel Kie collage that needs 660 s won't complete in a single auto-pipeline tick. The tick will time out partway through, the next tick will start the same collage from scratch (Atlas charges spent), and we're stuck in a loop.

Fix: persist partial progress at the panel level.

**Approach:**

Reuse the **existing `panelIndices` + `existingPanelUrls` partial-regen mechanism** already in `generateMotionCollage`. When a row enters the pipeline:
1. **Tick 1:** Run `generateMotionCollage` with `panelIndices = [0, 1, 2, 3]` (or however many fit in the per-tick budget). When the call returns successfully, write those 4 URLs back to the row's `motion_collage_panel_urls` (sparse — indices 4..8 are still empty / placeholder).
2. **Tick 2:** Stage handler sees the row has SOME panel URLs but is not complete. Calls `generateMotionCollage` with `panelIndices = [4, 5, 6, 7]` and `existingPanelUrls = <what we have so far>`. The partial-regen path already supports this exact shape.
3. **Tick 3:** Same with `panelIndices = [8]`.
4. After tick 3, the row is complete. Stage handler stops touching it.

**Per-tick budget calculation:**

The stage handler today has a `MAX_*_PER_TICK = 3` pattern (`MAX_MOUTH_REMOVED_PER_TICK`, `MAX_VISION_PASS_PER_TICK`, `MAX_PROP_GEN_PER_TICK` in `src/lib/auto-pipeline/stages/generate-production-doc-images.ts`). Add an analogous `MAX_MOTION_COLLAGE_PANELS_PER_TICK` constant. Calibrate so the panel work + overhead fits in ~250 s, leaving 50 s slack for the tick framework. For Kie: 3 panels/tick (~225 s). For Atlas: 5 panels/tick (~200 s). Vendor-aware sizing.

**Resumable state shape:**

No new fields. The existing `motion_collage_panel_urls: string[]` array already supports sparse population — slots that have no URL are just empty strings. The stage handler's "needs regen" predicate becomes: "has shot_kind motion_collage AND `motion_collage_panel_urls` is not fully populated with non-empty strings."

**Stage-handler changes:**

In `processMotionCollageRow` (or its current location), before calling `generateMotionCollage`:
```ts
const existing = row.motion_collage_panel_urls ?? [];
const N = row.motion_collage_grid.cols * row.motion_collage_grid.rows;
const missing = Array.from({ length: N }, (_, i) => i).filter(
  (i) => !existing[i] || existing[i].length === 0,
);
if (missing.length === 0) return;  // Already complete
const chunkSize = pickChunkSize(row.image_model_override, doc.image_model_default);
const chunk = missing.slice(0, chunkSize);
const mc = await generateMotionCollage({
  row, doc, workspaceId,
  panelIndices: chunk,
  existingPanelUrls: existing.length === N
    ? existing
    : padToN(existing, N),
  pickedModel: row.image_model_override || doc.image_model_default,
});
// Merge new URLs into existing, persist sparse array.
```

**Chain-continuity caveat:**

The chained-Edit motion-collage path makes panel K depend on panel K-1. When we process panels in chunks across ticks, panel 3 → panel 4 chains across the tick boundary. Panel 3's URL must be persistent (it lives in R2 from tick 1) when tick 2 reads it. After the 2026-06-09 R2 mirror fix (commit ending in `…3d9b6f34`), all motion-collage panel URLs are R2-persistent, so this works as-is.

**Telemetry:**

New log namespace `[motion-collage tick]` carrying:
- `row_index`, `chunk_size`, `chunk_indices`, `completed_panels`, `remaining_panels`, `tick_ms`.

So the user (or me, debugging) can grep "did this row's panels progress across ticks?"

### Kicking the pipeline (Phase 1 detail)

The existing auto-pipeline cron endpoint is at a known path (need to verify). The kick is an unauthenticated internal call from server to server, with a shared-secret header. Pattern matches the shorts-batch `kick-asset-cron` endpoint that already ships.

If the kick endpoint doesn't exist, add `POST /api/auto-pipeline/kick` that just calls the same handler the cron runs. Same auth model as the cron (shared secret in header).

## Security (rule 13)

- **Auth on the bulk-regen endpoint:** `apiRoute.authed`. Caller must be authenticated.
- **Workspace scoping:** verify `video.workspace_id === session.ws` before clearing any URLs. A user can't queue someone else's video for regen.
- **Rate limit:** 5/min per uid on the bulk endpoint. Per-IP limit 3/min as defense-in-depth.
- **Validation:** every `rowIndex` must be in-range and reference a `motion_collage` shot kind. Other shot kinds are silently skipped (don't error — let users send a generous filter from the editor without each row passing strict checks).
- **Cost ceiling:** the endpoint computes the total cost (panels × per-panel cost) and rejects if it exceeds a per-call cap (e.g. $5). User has to break large batches into smaller ones. Prevents a runaway "regen 500 rows" click from costing $50 in one go.
- **Per-panel ledger:** every panel still records intent + delivered/failed in `provider_generations` via the existing `generateMotionCollage` audit, so cost reconciliation stays correct.
- **Pipeline kick auth:** shared-secret header on the internal kick. Same model as the existing cron auth.

## Observability (rule 14)

New log namespaces:

- `[motion-collage bulk-regen request]` — endpoint entry: user, video, requested rowIndices, estCost.
- `[motion-collage bulk-regen queued]` — endpoint exit: number of rows actually marked for regen, kick result.
- `[motion-collage bulk-regen rejected]` — when a row is rejected (wrong shot_kind, out of range, invalid grid).
- `[motion-collage tick]` — per-row per-tick: chunk_size, chunk_indices, completed_panels, remaining_panels, tick_ms.
- `[editor bulk-regen]` — client side: kicked, polling for status.

Existing `[motion-collage pipeline] start` / `panel done` lines stay — they fire per row inside each chunk.

## Settings audit (rule 15)

No new user-facing settings. The bulk regen is a one-click action.

Optional follow-up consideration (not in this scope): expose a "Pipeline tick frequency" pref for power users who want sub-cron pulls. Skip for now — the immediate kick on bulk-regen click + the existing cron polling is enough for the "click and come back later" experience.

## Testing (rule 18)

- **Unit:** `motion-collage-bulk-regen-validation.test.ts` — pin every rejection path: missing videoId, empty rowIndices, out-of-range index, non-motion-collage row, cost cap exceeded, rate limit, workspace mismatch.
- **Unit:** `motion-collage-chunked-progress.test.ts` — `pickChunkSize` returns vendor-aware sizes; the missing-panel detector identifies sparse `motion_collage_panel_urls` correctly; chunk slicing covers all missing panels across multiple ticks.
- **Integration:** end-to-end mock of bulk-regen → kick → tick → second tick → completion. Assert intent records line up with delivered records, panel URLs all populated, no double-charges.
- **Existing regressions:** the 25 tests in `motion-collage-validation.test.ts` and the 9 in `motion-collage-partial-regen-validation.test.ts` must stay green.

## Cost implications (rule 8)

- **Per-collage cost unchanged.** Phase 1 + 2 only shift WHERE the work runs, not WHAT.
- **Storage cost:** sparse `motion_collage_panel_urls` in JSONB. Negligible.
- **Pipeline kick:** one extra HTTP roundtrip per bulk-regen call. Free.
- **Total impact:** ~$0 incremental.

## Alternatives rejected

1. **Bump Vercel Pro → Enterprise for longer maxDuration.** Solves nothing about browser-tab-must-stay-open. Phase 1 is still needed.
2. **Run bulk regen in a single super-long fetch with progress streamed back via SSE.** Browser-tab dependency remains. SSE adds complexity. Same problem.
3. **Web Workers / service worker that survives tab close.** Survives some tab closes but not browser quit, OS restart, etc. Half-fix.
4. **Drop chained Edit for parallel per-panel generation in motion-collage.** Faster (parallel beats sequential) but breaks composition continuity — the chained-Edit architecture exists specifically because parallel panels produced unrelated scenes. Tested and rejected in the 2026-05-31 plan.
5. **Drop motion-collage to a single Atlas Edit call with collage prompt.** Would fit in 300 s but produces the broken-quality output the chained-Edit pipeline was built to replace.

## Out of scope

- Single-shot inspector "Generate all N panels" stays synchronous. Fast feedback loop is worth the per-call timeout pressure for 2×2.
- Auto-pipeline scheduling improvements (smarter tick selection, priority queues, etc.) — orthogonal.
- Motion-collage cost-bound batching (group N rows into one tick) — let the existing per-tick budget speak for itself.

## Phasing & estimate

**Phase 1 — Async bulk regen via auto-pipeline (1.5 days):**
- New `/bulk-regen` endpoint (~3 hours)
- Editor swap to use it + "Queued" UI affordance (~2 hours)
- Pipeline kick endpoint or reuse (~1 hour)
- Tests (~3 hours)
- QA in a real session (~2 hours)

**Phase 2 — Per-collage chunked progress (1 day):**
- `pickChunkSize` + sparse-panel detection helper (~2 hours)
- Stage-handler integration (~2 hours)
- Tests + chain-continuity verification (~3 hours)
- QA: regen a 9-panel collage on Kie, verify it completes across 3 ticks (~1 hour)

**Follow-up — restore 3×3 default (~1 hour):**
- Flip `ConvertToMotionCollageButton.DEFAULT_GRID` back to `GRID_PRESETS[3]` (3×3) and update the canonical example in `production-doc-styles.ts` and the test. Same one-liner as 03ac5b42 in reverse.
- Only ship AFTER Phase 2 is in production and tested.

## Open questions

1. **Does the auto-pipeline cron already have a "kick" endpoint?** If yes, use it. If no, build it (small). Need to grep for the existing pattern.
2. **What's the per-uid bulk-regen rate limit?** I picked 5/min. Might be too generous if users start scripting it; might be too restrictive if a power user has a 50-row doc. Calibrate against observed editor usage if we have telemetry.
3. **Per-call cost cap:** I picked $5. Verify against the most-expensive realistic case — 12-panel collage at $0.05/panel = $0.60. So 8 collages at max grid = $4.80. Tight. Maybe raise to $10.
4. **Editor polling cadence:** the existing image-progress polling probably has a fixed cadence. Verify it fits this use case — for a 25-minute batch, the user wants progress updates more often than every 5 minutes (encourages them to come back), less often than every 10 seconds (network thrash).
5. **What happens if the pipeline tick fails mid-row?** The chunk processing means partial URLs land. Next tick resumes from where we stopped. But if a chunk fails entirely (Atlas + Kie both 5xx), the row stays partial forever until the user retries. Should we surface this in the editor as "stalled" vs "in progress"? Probably yes — add a `last_error` field on motion_collage rows similar to the existing PR2 reliability pattern.
