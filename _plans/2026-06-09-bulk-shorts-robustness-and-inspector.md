# Bulk Shorts: robustness + per-row content inspector

**Date:** 2026-06-09
**Trigger:** User reports bulk shorts failing. Diagnosed via DB query — Kie gateway returned 500 "server being maintained" during the extract stage for 2 of 8 shorts, and the orchestrator has no retry, so a transient upstream blip becomes a permanent terminal error. Same gap exists in voiceover, SEO, trigger_render. User also wants to see the actual generated content per row (script text, audio player, SEO output, frame thumbnails) instead of just a timing log.

## Goals

1. **Survive transient upstream errors** (Kie maintenance windows, network blips, 5xx responses) in all four orchestrator stages without permanently failing the short.
2. **Give the user a one-click recovery path** when retries are exhausted, instead of requiring DB poking.
3. **Expose the actual generated artifacts** per row in the bulk shorts UI so the user can see what came out, not just whether it succeeded.

## Constraints

- Don't touch model defaults or `DEFAULT_FALLBACK_CHAINS` (per `feedback_model_defaults_user_owned.md`).
- Don't change the orchestrator's per-tick concurrency or the Vercel 300s function budget — retries must fit inside the existing budget.
- Refusals + 4xx must still short-circuit (we don't want to spam a model with the same bad input three times).

## Chosen approach (A + C from the options the user picked)

### Part 1 — Retry-on-transient in orchestrator

New helper `retryTransient<T>(fn, opts)` in a new file `src/lib/shorts-batch-retry.ts`:

- 3 attempts max, base 1s, exponential backoff with ±20% jitter (1s, 3s, 9s) — fits comfortably inside the per-tick wall-clock with three shorts running in parallel.
- Retries on:
  - `error.message.includes('code 500')` / `'code 502'` / `'code 503'` / `'code 504'`
  - `error.message.includes('server is currently being maintained')` (Kie's exact phrasing)
  - `'ETIMEDOUT'` / `'ECONNRESET'` / `'ENOTFOUND'` / `'fetch failed'` / `'network'`
- Does NOT retry on:
  - Anything from `ai-fallback.ts`'s refusal classifier
  - 4xx HTTP statuses
  - JSON parse / schema errors (the model returned bad shape — retrying same prompt won't help)
- Each retry emits `[shorts-batch retry] { stage, short_id, attempt, delay_ms, reason }`.

Wrap the four stage runners:

- `runExtractStage` → wrap the `generateText()` call.
- `runVoiceoverStage` → wrap the `generateShortVoiceover()` call.
- `runSeoStage` → wrap the `generateText()` call.
- `runTriggerRenderStage` → wrap the `fetch()` to `/api/render/short`.

Failure path: when all retries exhaust, the existing `catch` block runs unchanged. The error message stored on `generation_progress.error_message` includes a `(after 3 attempts)` suffix so the user knows we tried.

### Part 2 — Retry button per failed short

New route `POST /api/shorts/[id]/retry`:

- Mirrors the `cancel` route shape (apiRoute.authed, returns 404 if not found, logs `[shorts-batch retry-short]`).
- Clears `generation_progress` to `{}` so `nextStageFor` re-derives the next stage from observable columns. The orchestrator will pick it back up on the next tick.
- Also clears `ai_model` only when extract is the next stage (avoids stale model metadata leaking into the row).

New UI button in `Step3Progress.tsx`:

- Appears on rows where `isError === true`, next to the existing `Try other model ▾` slot.
- Label: `↻ Retry`. Tooltip: "Re-run from where it failed".
- Calls the new endpoint, toasts the result, lets the poll-loop pick up the change.

### Part 3 — Per-row inspector (replaces what's inside the expand panel)

Rewrite the `Log` component in `Step3Progress.tsx` (rename → `RowInspector`):

- Top section: **stage content cards**, one per completed stage. Each card is collapsible and pre-collapsed (`<details>`-style with summary).
  - **Script** — show `title`, `hook`, `payoff`, `short_script` (full text, `<pre>` with `whitespace-pre-wrap`), word count. Hook + payoff visually highlighted as bordered call-out boxes above the body.
  - **Voiceover** — `<audio controls preload="metadata" />` with `voiceover_audio_url`, plus `voiceover_duration_seconds` formatted.
  - **SEO** — `seo_result.primary_keyword`, `seo_result.title`, `seo_result.description` (multi-line), `seo_result.tags` (chips), `seo_result.hashtags` (chips).
  - **Assets** — thumbnail grid (3-up for vertical 9:16) from `style_assets.doodle.base` + `style_assets.doodle.variants[]`. Each is `<a target="_blank">` so click opens full-res.
  - **Render** — `<video controls>` with `rendered_video_url` when present, plus a "Open in editor" link to the existing short editor.
- Error banner: when `gp.phase === 'error'`, prominent red box above the cards with the full error message + when it failed.
- Bottom section: **existing textual log** kept verbatim (timeline + asset job phase detail). Visually separated with a divider + smaller text so the content cards lead.

### Part 4 — Tests

- `tests/shorts-batch-retry.test.ts` (new):
  - Retries on 500 → succeeds on 2nd attempt.
  - Retries on "server is currently being maintained" string.
  - Does NOT retry on 400.
  - Stops after max attempts and rethrows the last error.
  - Respects the backoff schedule (use fake timers).
- `tests/shorts-batch-orchestrator.test.ts` (extend):
  - One integration-style test confirming a transient extract failure recovers when the underlying generator succeeds on retry.
- Inspector is presentational; covered by manual QA only.

### Part 5 — Observability

- `[shorts-batch retry]` log line on every retry attempt.
- `[shorts-batch retry-short]` on manual retry endpoint.
- Stage error log already exists; extend message with attempt count when retries were used.

### Part 6 — Settings audit

No new user-visible knobs. Retry policy is hardcoded by design — exposing it as a setting would be a power-user trap. Documented in the helper's docstring instead.

### Part 7 — Image-model default switch (added mid-flight, user-confirmed)

User asked to switch the default base T2I image model from `atlas-gpt-image-2` ($0.009/image) to `kie-gpt-image-2` ($0.050/image, ~5.6× more) because of Atlas reliability issues seen in recent commits (motion-collage grid revert, image-model forwarding fixes). Same OpenAI gpt-image-2 model, different vendor gateway.

Touch points:
- `DEFAULT_BASE_T2I_MODEL_ID` constant in `src/lib/shorts-base-t2i-types.ts`.
- Hardcoded `'atlas-gpt-image-2'` in `src/lib/shorts-batch-orchestrator.ts` `enqueueAssetGeneration`.
- Two `useState<string>('atlas-gpt-image-2')` seeds in `src/components/shorts/ShortEditor.tsx` — replace with import of `DEFAULT_BASE_T2I_MODEL_ID`.
- `Step3Progress.tsx` `RetryAssetsPicker` fallback at line 417 — same.
- `tests/shorts-base-t2i.test.ts` assertions — update expected default to `kie-gpt-image-2` + the cost expectation.
- `tests/shorts-frame-ops.test.ts` similar.
- Comment in `src/lib/user-settings.ts` describing the fallback default — update.

Cost guard: documented in the plan, user confirmed in-chat. No automated cost cap is added.

### Part 8 — Follow-up (separate PR): expand the shorts T2I picker

User asked to make the shorts T2I default picker cover **all cloud T2I models** (Kie + Atlas, no local ComfyUI) — adding Grok Imagine, Ideogram v3 quality/turbo, Flux 2 Flex, Nano Banana, Seedream, Qwen, etc. — and to surface the choice as a Settings-level default.

Not in this change. Tracked as the next plan after this one ships, so the current bulk batch unblocks first. Approach options for the follow-up:
- Unify the shorts `BASE_T2I_MODELS` registry with `image-models.ts` (one source of truth, may need migration for the existing per-user setting).
- OR keep them separate and write an adapter so the shorts dispatcher can route to the production-doc image dispatcher for non-shorts-native models.
- Either way: surface the chosen default in `/settings` next to the existing image-related controls.

## Out of scope

- Fallback chains across providers (option B). The user explicitly chose A+C; fallback chains can come later if Kie continues to flake.
- Any change to the asset cron, render route, or batch state machine.
- Removing or relocating the existing model picker `Try other model ▾`.

## Risks

- **Total wall-clock per stage grows.** Worst case: 3 attempts × ~30s LLM call + 1+3=4s backoff ≈ 100s per failing stage per short. With 3 shorts in parallel and 4 stages, the per-tick budget can be pressured. Mitigation: keep backoff small (1s/3s), and the existing per-tick concurrency cap (3) already bounds wall-clock.
- **Retry storm during a long Kie outage.** Every tick re-tries, every retry takes time. Mitigation: the orchestrator only re-tries shorts that aren't terminal; once retries exhaust and the short is marked error, it stops being picked. Manual retry button is the user's lever for "Kie's back, try again".
- **Inspector adds bundle weight.** Mitigation: no new libs; uses existing `<audio>`, `<video>`, `<img>` primitives.
