# Production-Doc Flow Stabilization & Pacing Overhaul

**Date:** 2026-06-03
**Scope:** Stop the bleeding on the doodle_explainer_2 / paint_explainer_v1 production-doc workflow across four interrelated failure modes the user called out.
**Sequencing:** 4 PRs, in order. Each lands independently and can be QA-validated before the next.

---

## Goals

1. **Motion collage panels stay visually consistent** — figures, items, backgrounds keep size/position across panels of the same shot. Same for base-image variants. No more "everything resizes for no reason."
2. **Image generation stops silently grinding** — fail fast, surface the failure class, give the user a clear retry button. No more "looks like it's generating but it's been stuck for an hour."
3. **Production-doc ↔ editor stay in lockstep** — opening the editor shows the latest doc state, edits made in the editor reflect in the doc on navigate-back, and the pipeline cannot stomp the user's edits (or vice versa).
4. **Pacing is fast and vivid by default** — shorter shots, more motion collages, more variants, no long static holds, and an opening hook that grabs the viewer in the first 10-12 seconds.

## Constraints

- Vercel Fluid Compute 300 s per-function ceiling — per-tick caps must hold.
- Cost cap: `PIPELINE_IMAGE_GEN_CAP_USD` (default $10) is the only safety net today; must not weaken it.
- Atlas Edit ≈ 5% drift per chained step (the code comments admit this) — cannot pixel-lock, only structurally constrain.
- The page-level inline `ProductionDoc` type in [src/app/(app)/production-doc/page.tsx](src/app/(app)/production-doc/page.tsx) MUST stay in sync with the canonical type in [src/remotion/utils.ts](src/remotion/utils.ts) — per AGENTS.md.
- Lambda render bundle is separate — schema/component changes that touch `src/remotion/**` need `npm run deploy:remotion`.
- Settings are user-facing: every new knob lands in the existing Paint Explainer V1 settings panel and Doodle Explainer 2 motion collage panel — no scattered settings (rule 15).
- No breaking changes to existing in-flight production docs persisted via the legacy path.

## Requirements (lazy-user lens — rule 10)

- A failed image shows a red chip with the failure reason and a one-click "Retry this row" button. The user does NOT have to refresh, navigate, or wonder.
- When pipeline and editor disagree, the user sees a banner: "The pipeline added new shots — reload?" — not silent data loss.
- Pacing is one knob in settings: **Standard / Fast / Very Fast**. Default = Fast. The opening hook is **on** by default with no extra knob to toggle.
- All four fixes have to be invisible to the user when they work and obvious to the user when they don't.

---

## Map of the territory (verified 2026-06-03)

| System | Where it lives | Key facts |
|---|---|---|
| Motion collage prompts | [src/lib/motion-collage-prompt.ts](src/lib/motion-collage-prompt.ts), [src/lib/auto-pipeline/production-doc-image-gen.ts:1273-1965](src/lib/auto-pipeline/production-doc-image-gen.ts#L1273-L1965) | Already maximally strict prompts. Dual-input chain (N-1 + panel 0). Forbidden-word list at [styles.ts:769](src/lib/production-doc-styles.ts#L769). |
| Image gen pipeline | [src/lib/auto-pipeline/stages/generate-production-doc-images.ts](src/lib/auto-pipeline/stages/generate-production-doc-images.ts) | Zero per-row retry counter. No circuit breaker. Stage re-enters itself at [line 1263](src/lib/auto-pipeline/stages/generate-production-doc-images.ts#L1263) until all rows succeed OR $10 cap hits. Errors logged silently. |
| Doc storage | [src/app/(app)/production-doc/page.tsx:2607-2724](src/app/(app)/production-doc/page.tsx#L2607-L2724) (legacy) vs [src/lib/project/use-project.ts](src/lib/project/use-project.ts) + [src/app/api/edit/[projectId]/route.ts](src/app/api/edit/[projectId]/route.ts) (canonical) | Production-doc bypasses the canonical endpoint. No version check on legacy path. Pipeline writes directly to `user_history.payload`. |
| Pacing levers | [src/lib/prompts.ts:2098-2497](src/lib/prompts.ts#L2098-L2497), [src/lib/production-doc-styles.ts:399-731](src/lib/production-doc-styles.ts#L399-L731), [src/remotion/utils.ts:1506-1527](src/remotion/utils.ts#L1506-L1527) | 9-13 words/row, ~30% motion_collage, ~40% variants. No opening-specific guidance. |
| Settings UIs | [src/components/production-doc/DoodleExplainer2MotionCollageSettingsPanel.tsx](src/components/production-doc/DoodleExplainer2MotionCollageSettingsPanel.tsx), [src/components/production-doc/PaintExplainerV1SettingsPanel.tsx](src/components/production-doc/PaintExplainerV1SettingsPanel.tsx) | Existing surfaces — extend, don't fork. |

---

## Alternatives rejected

**A. "Just tighten the motion-collage prompts again" — rejected.**
The prompts are already maximal. Image diffusion models do not honor incremental capitalization. Adding more warnings is throwing money at a symptom whose cause is the chained-Edit drift model. The fix has to be structural.

**B. "Rewrite Atlas Edit to use masked inpainting only on the moving region" — rejected for now.**
Would architecturally eliminate drift. But Atlas masking support is unverified, the rewrite would be 2-3 weeks of work, and it gates everything else. Move it to a future RFC. The PR4 fix (shorter chains, panel-0 anchor, verb scrubbing) is the 80% solution.

**C. "Council the plan first" — rejected per user feedback memory** (council fabricates context, waters down real problems).

**D. "Ship sync last" — rejected.**
The sync fix is the lowest-risk highest-leverage change. If we don't fix it first, PR3 (pacing) lands changes the user can't actually see because their editor is showing stale state. PR1 first.

**E. "Skip the motion collage rewrite, ship the other three" — considered seriously.**
Tempting because PR1-3 fix 75% of complaints. But the user's #1 frustration (drift) is the motion collage. Skipping it = the loudest complaint stays unfixed. We do all four.

---

## PR1 — Storage path unification (sync)

**Why first:** Lowest risk. Biggest immediate UX win. Unblocks PR2/3 from racing themselves.

### Reality check (2026-06-03)

The earlier explore was partially wrong. Updated understanding:

- The canonical infrastructure **already exists** from the 2026-05-19 parity plan: [src/lib/project/use-project.ts](src/lib/project/use-project.ts) has GET/PATCH wiring, 800 ms debounce, version tracking, `onConflict` callback, `reload()`, Cmd+S, and a `beforeunload` keepalive.
- Production-doc page **does** mount `useProject` at [page.tsx:2766](src/app/(app)/production-doc/page.tsx#L2766) — but **only for the GET side** (hydration into local state at [page.tsx:2783-2832](src/app/(app)/production-doc/page.tsx#L2783-L2832)). `project.patch()` is **never called** anywhere in the file.
- All 36 `updateProductionDocEntry(historyEntryId, { doc: nextDoc })` calls hit the legacy `/api/history/[id]` PATCH route, which writes `user_history.payload` with **no validation, no version logic, 256 KB cap** ([user-history.ts:52](src/lib/user-history.ts#L52)) versus the canonical 10 MB ([persist.ts:56](src/lib/project/persist.ts#L56)).
- Server contract changed since the original plan: **strict version conflict is gone**, replaced by last-write-wins with three guards (asset maps server-owned via atomic `/row-asset` jsonb_set, empty-rows refused, row-count-shrank warning) — see [persist.ts:213-245](src/lib/project/persist.ts#L213-L245).
- **The bug is the dual-write race**: both `/api/history/[id]` PATCH and `/api/edit/[id]` PATCH write the same `payload` column. They have different validation, different size caps, and one bumps version while the other does not predictably. Whichever lands last wins.

### Changes (revised)

1. **Collapse to one write path — route all doc writes through `project.patch()`.**
   - In production-doc page.tsx, replace the body of every `updateProductionDocEntry(historyEntryId, { doc: nextDoc }).catch(() => {})` call with a new helper `persistDoc(nextDoc)` that:
     - calls `project.patch({ doc: nextDoc })` when `project.payload` is loaded, OR
     - queues into a `pendingDocPatchesRef` if `historyEntryId` isn't set yet (mirrors the existing `pendingPersistsRef` pattern at [page.tsx:2875](src/app/(app)/production-doc/page.tsx#L2875))
     - Replays the queue on hydration via an effect (same as `pendingPersistsRef` does for assets).
   - The local `setDoc(next)` calls stay as-is — they're the UI working copy. We are only collapsing the **persistence** path.
   - Remove the 36 `updateProductionDocEntry(..., { doc: ... })` calls entirely. The legacy route stays for OTHER non-doc fields if any caller uses it (none do today for production_doc, so the function effectively becomes dead code; mark it `@deprecated`).

2. **Cross-tab polling in `useProject`.**
   - Add a slim `GET /api/edit/[projectId]?versionOnly=1` query-param mode to the existing route — returns `{ version: number }` only, ~50 bytes. Faster + cheaper than a separate sub-route, avoids a new Next.js segment.
   - `useProject` polls every 8 s when `document.visibilityState === 'visible'`, pauses on hidden, resumes on visible.
   - On version change: if `isDirty`, surface "pipeline updated elsewhere — local changes will conflict on next save" via `saveStatus`. If clean, auto-`reload()`.
   - Polling stops while a save is in flight (avoid racing the optimistic version refresh).

3. **Conflict + remote-bump banner UI.**
   - When `saveStatus.kind === 'conflict'` OR poll detects an external version bump while local is dirty, render a one-row banner above the doc:
     > "This doc was updated elsewhere (pipeline or another tab). **[Reload]**  · Local edits will not be lost — they'll be re-applied after reload if compatible."
   - Reload calls `project.reload()` then re-hydrates local state.

4. **Pipeline writes — verify version-bump.**
   - Need to confirm the auto-pipeline orchestrator persists the mutated doc via SQL that includes `version = version + 1`. Both `saveProjectPatch` and `saveProjectUnversioned` already do this ([persist.ts:380-389](src/lib/project/persist.ts#L380-L389), [persist.ts:469-478](src/lib/project/persist.ts#L469-L478)). If the orchestrator uses raw SQL that omits the increment, fix it.
   - Action item: read [src/lib/auto-pipeline/orchestrator.ts](src/lib/auto-pipeline/orchestrator.ts) and the stage's `actions.ts` callers before declaring PR1 done.

### Files touched
- [src/app/(app)/production-doc/page.tsx](src/app/(app)/production-doc/page.tsx) — add `persistDoc()` helper + queue + hydration replay; remove 36 `updateProductionDocEntry({ doc })` calls; render banner
- [src/lib/project/use-project.ts](src/lib/project/use-project.ts) — add polling, pause-on-hidden, version-change detection
- [src/app/api/edit/[projectId]/route.ts](src/app/api/edit/[projectId]/route.ts) — add `?versionOnly=1` query mode
- [src/lib/auto-pipeline/orchestrator.ts](src/lib/auto-pipeline/orchestrator.ts) — verify (and fix if needed) version-bump on pipeline writes

### Observability (rule 14)
- `[doc-sync persist-doc]` — every `persistDoc()` call: `{ source, hasPayload, queued }`
- `[doc-sync replay]` — every replay of the deferred queue on hydration: `{ count }`
- `[doc-sync poll]` — every poll cycle: `{ version, changed, isDirty, action: 'reload'|'banner'|'none' }`
- `[doc-sync banner]` — when banner shows: `{ reason: 'save-conflict'|'remote-version-bump' }`
- `[doc-sync pipeline-write]` — if we end up needing to fix the orchestrator: log each pipeline write with version bump

### Testing (rule 18)
- Unit: polling cadence + pause-on-hidden + skip-while-saving in `useProject`.
- Unit: `persistDoc()` queue replay on hydration.
- Manual: two tabs of same doc → edit in A → B reflects within 8 s.
- Manual: open editor view from grid → edit a row → back to grid → reflects.
- Manual: while pipeline is running images, edit a row → banner appears when pipeline writes a row.image_url externally.

### Settings (rule 15)
- No new settings. Sync is infrastructure, not a knob.

---

## PR2 — Reliability (retry counter + error UI + give-up)

**Why second:** Once sync is solid, we can safely add row-level state without races. Removes the silent-grind footgun.

### Changes

1. **Schema: extend ProductionRow.**
   ```ts
   attempts?: number;              // default 0
   last_error?: {
     class: 'content_policy' | 'timeout' | 'blank_output' | 'model_rejected' | 'reference_rejected' | 'unknown';
     message: string;              // short, user-facing
     at: string;                   // ISO timestamp
   } | null;
   ```
   - Mirror the change in [src/remotion/utils.ts](src/remotion/utils.ts) `ProductionRow` AND in the inline type in [src/app/(app)/production-doc/page.tsx](src/app/(app)/production-doc/page.tsx) — AGENTS.md mandate.

2. **Per-error-class retry budgets.**
   ```ts
   const RETRY_BUDGETS: Record<ErrorClass, number> = {
     content_policy: 1,    // prompt is bad; retrying won't help
     reference_rejected: 1,
     model_rejected: 2,
     blank_output: 2,
     timeout: 3,           // transient; worth retrying
     unknown: 2,
   };
   ```
   - In [src/lib/auto-pipeline/stages/generate-production-doc-images.ts](src/lib/auto-pipeline/stages/generate-production-doc-images.ts), every failure call site classifies the error (regex on the existing error strings) and increments `attempts`. When `attempts >= budget`, mark the row as errored and stop re-claiming.

3. **Circuit breaker on the stage.**
   - `stillRemaining()` ([line 1165](src/lib/auto-pipeline/stages/generate-production-doc-images.ts#L1165)) now treats a row with `attempts >= budget` as "done" for purposes of stage advancement.
   - Stage advances to thumbnail when (all done OR all exhausted OR cost cap). Logs a `[image-gen circuit-breaker]` summary.

4. **Error UI in the row.**
   - In the production-doc row component AND in the EditorView row: when `last_error` is set, render a red chip with the class label + a one-click **Retry** button.
   - Retry resets `attempts = 0`, clears `last_error`, and the next cron tick picks it up.
   - Plain-language error messages: "AI rejected your prompt (content policy)" not "POLICY_VIOLATION_429".

5. **Bulk retry.**
   - Top of the production-doc page: if any rows have errors, show a one-line banner "3 shots failed. [Retry all]". One click resets all.

### Files touched
- [src/remotion/utils.ts](src/remotion/utils.ts) — extend `ProductionRow`
- [src/app/(app)/production-doc/page.tsx](src/app/(app)/production-doc/page.tsx) — mirror inline type, add row error UI + bulk banner
- [src/lib/auto-pipeline/stages/generate-production-doc-images.ts](src/lib/auto-pipeline/stages/generate-production-doc-images.ts) — retry logic + circuit breaker + error classifier
- [src/lib/auto-pipeline/production-doc-image-gen.ts](src/lib/auto-pipeline/production-doc-image-gen.ts) — return `errorClass` from each generator
- Editor row component (find within page.tsx EditorView)

### Observability (rule 14)
- `[image-gen retry]` — every decision: `{ rowId, attempts, budget, errorClass, decision: 'retry'|'give-up' }`
- `[image-gen circuit-breaker]` — stage advancement: counts of done/errored/pending
- `[image-gen error-classify]` — the regex match and chosen class

### Testing (rule 18)
- Unit: error classifier on real failure strings; retry budget enforcement; circuit-breaker advancement logic.
- Each error class gets a failing-then-passing test fixture.

### Settings (rule 15)
- No new settings for v1. If users ask, expose per-error-class budgets later — for now, sane defaults.

### Security (rule 13)
- Error messages surfaced to users: scrub API keys, internal paths, and customer-id-bearing fields before display. Lint pass on the error classifier.
- Retry budget caps cost exposure — without this, a stuck row burns cost cap. With this, max spend per row is bounded by its budget × per-call cost.

---

## PR3 — Pacing & opening hook

**Why third:** Sync + reliability are stable, so pacing changes land cleanly. Pacing is user-visible quality, where reliability is operational quality.

### Changes

1. **`pacing_profile` field on the doc.**
   ```ts
   pacing_profile?: 'standard' | 'fast' | 'very_fast';  // default: 'fast'
   ```
   Mapping in [src/lib/prompts.ts](src/lib/prompts.ts):
   | Profile | Words/row | Target s/row | Motion floor | Variant floor |
   |---|---|---|---|---|
   | standard | 9-13 | 4-6 s | 30% | 40% |
   | **fast (default)** | **6-9** | **3-4 s** | **40%** | **50%** |
   | very_fast | 4-7 | 2-3 s | 50% | 55% |

2. **Opening hook directive.**
   - Add to `productionDocPrompt()`:
     > "FIRST 12 SECONDS = THE HOOK. Every row in the first 12 s must be ≤ 2.5 s. At least one motion_collage must appear in the first 8 s. The first row cannot be a standalone static base image — it must be motion_collage, variant group, or a base WITH a real-photo overlay or label burst."
   - Belt-and-braces: a **post-processor** ([src/lib/auto-pipeline/post-process-pacing.ts](src/lib/auto-pipeline/post-process-pacing.ts), new file) runs after the LLM emits rows. It enforces:
     - Split any opening row > 2.5 s into 2 rows
     - If first row is a standalone static base, promote it to motion_collage (set `visual_type` and emit collage panel prompts via existing helper)
   - Post-processing is mandatory because LLMs ignore numeric constraints in long prompts ~30% of the time. Don't trust, verify.

3. **Bump style-default ratios.**
   - doodle_explainer_2 mixing rules: motion floor 30 → 40%, variant 40 → 50%.
   - paint_explainer_v1 `median_shot_seconds` default 2.75 → 2.4.
   - Existing user-overridden settings are preserved.

4. **UI knob.**
   - In the Paint Explainer V1 panel and Doodle Explainer 2 panel: add a **Pacing** section with three pill buttons (Standard / Fast / Very Fast) + a one-line description below each.
   - Default = Fast. Surfaced clearly, not buried in advanced settings.

### Files touched
- [src/lib/prompts.ts](src/lib/prompts.ts) — `pacing_profile` mapping + opening hook directive
- [src/lib/production-doc-styles.ts](src/lib/production-doc-styles.ts) — bump motion + variant floors
- [src/remotion/utils.ts](src/remotion/utils.ts) — `pacing_profile` on doc + paint defaults
- [src/app/(app)/production-doc/page.tsx](src/app/(app)/production-doc/page.tsx) — mirror inline type
- **NEW:** [src/lib/auto-pipeline/post-process-pacing.ts](src/lib/auto-pipeline/post-process-pacing.ts) — enforcement layer
- [src/lib/auto-pipeline/stages/generate-production-doc.ts](src/lib/auto-pipeline/stages/generate-production-doc.ts) — invoke post-processor
- [src/components/production-doc/PaintExplainerV1SettingsPanel.tsx](src/components/production-doc/PaintExplainerV1SettingsPanel.tsx) — Pacing section
- [src/components/production-doc/DoodleExplainer2MotionCollageSettingsPanel.tsx](src/components/production-doc/DoodleExplainer2MotionCollageSettingsPanel.tsx) — Pacing section

### Observability (rule 14)
- `[pacing profile-applied]` — which profile, what word budget, what floors
- `[pacing opening-hook]` — what the LLM emitted vs what the post-processor changed
- `[pacing post-process split]` — every row split with before/after durations
- `[pacing post-process promote]` — every static→motion promotion

### Testing (rule 18)
- Unit: post-processor opening-row-split logic, static→motion promotion, ratio bumps.
- Integration: feed real script fixtures through the full row-generation + post-process flow, assert opening rows ≤ 2.5 s.
- Snapshot the LLM prompt for each profile to catch regressions.

### Settings (rule 15)
- Pacing pill group surfaces here. Default = Fast. Opening hook is always on (no knob).

---

## PR4 — Motion collage architectural fixes

**Why last:** Riskiest change, benefits most from sync + reliability already being solid (so we can A/B vs the new baseline cleanly).

### Changes

1. **Cap chain depth at 4.**
   - In [src/lib/auto-pipeline/production-doc-image-gen.ts](src/lib/auto-pipeline/production-doc-image-gen.ts) `generateMotionCollage()`:
     - Panel 0: fresh Atlas i2i with refs (unchanged)
     - Panels 1-3: chained dual-input (N-1 + panel 0) — unchanged
     - **Panels 4+: anchor to panel 0 ONLY** (single-input Edit, no N-1 dependency)
   - Eliminates compounding drift past 4 steps.
   - For 12-panel grids (common): 4 chained + 8 panel-0-anchored. For 6-panel grids: 4 chained + 2 panel-0-anchored.

2. **Verb scrubbing at the composer.**
   - In [src/lib/motion-collage-prompt.ts](src/lib/motion-collage-prompt.ts) `composePerPanelPrompt()`:
     - BEFORE injecting `panel_prompt`, run a `scrubScaleVerbs()` pass.
     - Replace forbidden verbs ([styles.ts:769](src/lib/production-doc-styles.ts#L769) list) with structurally-equivalent neutral phrasing:
       - "grows" → "is drawn in"
       - "shrinks" → "is partially erased"
       - "fills the frame" → "is positioned at the frame center"
       - "looms" → "is drawn larger from the same position"
     - Log every replacement at `[motion-collage scrub]`.
   - Don't trust the LLM to follow the forbidden-word list — pre-process.

3. **Reinforced mode default-on.**
   - The reinforced directive at [motion-collage-prompt.ts:80-85](src/lib/motion-collage-prompt.ts#L80-L85) currently fires only when the slicer detects a malformed grid. Make it always-on.
   - No cost impact (same prompt, just always included).

4. **Per-panel description verb constraints — feed to LLM.**
   - In `buildPanelFillPrompt()` ([src/lib/motion-collage-panel-fill.ts](src/lib/motion-collage-panel-fill.ts)):
     - Add: "Every per-panel description MUST use only translate/rotate/draw verbs. Examples: 'the cat's paw lifts 20° from prior frame', 'a thin black line extends 30px to the right'. NEVER use 'grows', 'looms', 'fills', 'shrinks', 'gets bigger'. Frame N's description is the DELTA from frame N-1's pose — not the whole scene."
   - Belt: LLM follows. Braces: scrubber catches what slips through.

5. **Same fix for base-image variants.**
   - Variant generation in [production-doc-image-gen.ts](src/lib/auto-pipeline/production-doc-image-gen.ts) `generateVariantImage()` (line 340) uses Atlas Edit on the parent base. Apply the same verb-scrubber + the same "Reproduce composition exactly" prompt prefix.
   - Variants only chain 1 step from the base, so drift is already small — but the user complained, so we apply the fix uniformly.

### Files touched
- [src/lib/auto-pipeline/production-doc-image-gen.ts](src/lib/auto-pipeline/production-doc-image-gen.ts) — chain-depth cap + variant fix
- [src/lib/motion-collage-prompt.ts](src/lib/motion-collage-prompt.ts) — verb scrubber + reinforced default-on
- [src/lib/motion-collage-panel-fill.ts](src/lib/motion-collage-panel-fill.ts) — LLM verb-constraint guidance
- **NEW:** [src/lib/verb-scrubber.ts](src/lib/verb-scrubber.ts) — pure helper, easily unit-tested

### Observability (rule 14)
- `[motion-collage chain-strategy]` — which strategy used per panel (chained vs anchored)
- `[motion-collage scrub]` — every verb replacement: `{ panel, original, replacement }`
- `[motion-collage reinforced]` — always on now; log once per shot

### Testing (rule 18)
- Unit: `scrubScaleVerbs()` against the full forbidden-word list + edge cases (case, punctuation, partial matches).
- Unit: chain-strategy selector (which panels get chained vs anchored).
- Integration: generate a 12-panel collage from a fixture script, verify panels 4+ are single-input from panel 0.
- Manual A/B: render the same shot with old vs new chain strategy, compare drift visually.

### Settings (rule 15)
- No new user settings — these are correctness fixes, not preferences. Chain depth and verb scrubbing are internal.

---

## Cross-cutting

### Security (rule 13)

- Error messages surfaced to users must not leak API keys, internal paths, customer IDs, or model-specific identifiers. Add a sanitization pass in the error classifier (PR2).
- The `/api/edit/{projectId}/version` endpoint (PR1) must enforce the same auth as the existing PATCH route — don't let an unauthenticated probe read project metadata.
- Polling rate-limited at 8 s minimum — prevents accidental DoS of own API.
- The bulk-retry banner (PR2) requires a confirmed user action — no auto-retry that could loop on a persistent failure.

### Observability (rule 14)

Every PR ships with the namespaced logs listed in its section. The bar: when a user reports "X is broken," I can grep one namespace and see every decision the system made.

Master namespace list after all 4 PRs:
- `[doc-sync patch]`, `[doc-sync conflict]`, `[doc-sync poll]`, `[doc-sync pipeline-write]`
- `[image-gen retry]`, `[image-gen circuit-breaker]`, `[image-gen error-classify]`
- `[pacing profile-applied]`, `[pacing opening-hook]`, `[pacing post-process split]`, `[pacing post-process promote]`
- `[motion-collage chain-strategy]`, `[motion-collage scrub]`, `[motion-collage reinforced]`

### Settings (rule 15)

After all 4 PRs, the Settings audit:
- **Pacing** pill (Standard / Fast / Very Fast) — default Fast — exposed in Paint Explainer V1 panel AND Doodle Explainer 2 panel.
- Opening hook: **always on**, not exposed. Reason: it's a quality floor, not a preference. Document this decision in this plan so future me doesn't second-guess.
- Retry budgets: **internal**, not exposed in v1. Surface later if users ask for control.
- Chain depth: **internal**, not exposed. Implementation detail.

### Testing (rule 18)

- Every PR has the test plan in its section above.
- The full test suite must pass green at the end of each PR.
- Manual QA after each PR walks the golden path + 2 error paths + the regression-risk area.
- Final QA after PR4: render one 60 s doodle_explainer_2 script end-to-end with the new pipeline, compare side-by-side with a pre-fix render.

---

## Open questions

1. **Atlas masking support** — for the future RFC on masked inpainting (rejected alternative B), need to verify whether Atlas supports it natively. Not blocking any of the 4 PRs.
2. **Should `pacing_profile = 'fast'` default also propagate to existing docs on open?** Default position: NO — only new docs get the new default, existing docs keep their state. Need user call.
3. **Cross-tab SSE upgrade** — punted in PR1. Revisit if polling causes noticeable lag.
4. **Per-channel pacing overrides** — should each YouTube channel be able to set its own default pacing profile? Out of scope for v1, easy to add later.

---

## Sequencing rationale (one more time)

- **PR1 (sync) first** because every other fix lands cleaner once writes go through one path with version checks. Without it, PR2's error states race the pipeline; PR3's prompt changes race the editor; PR4's regenerations race everything.
- **PR2 (reliability) second** because once the user can see failures, we can stop guessing about which generation steps fail and triage from real data.
- **PR3 (pacing) third** because it's the most user-visible quality lever and benefits from the reliability layer (stuck rows in faster pacing = more visible problem).
- **PR4 (motion collage architecture) last** because it's the riskiest change and we want the previous fixes solid so we're not debugging multiple layers at once.

---

## Done when

- Two browser tabs of the same project stay in lockstep within 8 s (PR1).
- A failed image gen surfaces a labelled error chip + retry button within 30 s of the failure (PR2).
- A new doodle_explainer_2 doc generated with default pacing has all opening rows ≤ 2.5 s and at least one motion_collage in the first 8 s (PR3).
- A 12-panel motion collage shows zero visible drift in static elements (sticky notes, background, scale) across the 12 panels (PR4).
- All four QA walks (golden + edge + error + regression) pass for each PR.
