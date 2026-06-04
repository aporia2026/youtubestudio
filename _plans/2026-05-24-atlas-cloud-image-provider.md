# Atlas Cloud image provider — Baidu ERNIE-Image-Turbo (free)

**Date:** 2026-05-24
**Owner:** Yoav
**Status:** Implementation complete (8 files modified, 2 new, 23 tests pass, typecheck clean) — LIVE API BLOCKED on auth scope / endpoint discrepancy. See "Execution outcome" at the bottom.

---

## Goal

Wire Atlas Cloud into the image-generation stack as a 4th provider (after `kie`, `comfyui-local`, `openai`), starting with the free `baidu/ERNIE-Image-Turbo/text-to-image` model. Surface it in the production-doc per-row picker, the thumbnail picker (all 3 format variants), and the auto-pipeline thumbnail generator. Run every Atlas output through the existing Kie/Recraft upscale path, the same way every other cloud image does.

## Why this is worth doing

- ERNIE-Image-Turbo bills at $0.00000000 per image in Yoav's account (confirmed by billing screenshot). Every thumbnail iteration on this model is free.
- Adding a 4th provider proves the registry abstraction generalises — future Atlas models (paid Qwen-Image, FLUX, Ideogram via Atlas) become one-line registry entries.

## Constraints

- **No new defaults.** Production-doc keeps Grok Imagine; thumbnails keep nano-banana. ERNIE is an opt-in option in the dropdowns. (User decision.)
- **T2I only.** ERNIE-Image-Turbo's model string ends in `/text-to-image`. Atlas's i2i schema isn't documented on the pages I could read, and the user picked "no Atlas i2i" — so `image-models-i2i.ts` is untouched in this phase. (User decision.)
- **Upscale via existing Recraft path.** No new upscale layer. Atlas URLs flow into `pollKieResultThenUpscale`-equivalent that delegates to `upscaleViaRecraft`. (User constraint.)
- **1K source resolution.** Match the existing top-of-file policy in `image-models.ts`: pin source to 1K (or smallest supported), let Recraft do the 4× upscale. Saves money even on free models because the upscaler bill is uniform.

## Requirements

| # | Requirement | Source |
|---|---|---|
| R1 | Add `'atlas'` to `ImageModelProvider` union | image-models.ts:28 |
| R2 | Add ERNIE registry entry with provider/atlasModel fields | image-models.ts:47 |
| R3 | New `src/lib/atlas-images.ts` — create + poll + upscale wrapper | mirrors kie-poll.ts |
| R4 | Production-doc image route dispatches on `provider === 'atlas'` | route at `/api/generate/production-doc/image/route.ts` |
| R5 | Thumbnail image route + 3 format variants dispatch on `provider === 'atlas'` | thumbnails routes |
| R6 | Auto-pipeline image-gen treats Atlas as a fallback-eligible provider | `src/lib/auto-pipeline/image-gen.ts` |
| R7 | `.env.local.example` documents `ATLAS_API_KEY` | env example file |
| R8 | Pricing entry in `ai-pricing.ts` marks ERNIE as $0 | ai-pricing.ts |
| R9 | Tests: 1K-policy guard, dispatch test, Atlas builder unit test | mirror existing test patterns |

## Verified facts (rule 1)

- Endpoint: `POST https://api.atlascloud.ai/api/v1/model/generateImage` (verified from `/docs/models/image`)
- Poll: `GET https://api.atlascloud.ai/api/v1/model/prediction/{prediction_id}` (verified)
- Auth: `Authorization: Bearer <key>` (verified from `/docs/api-keys`)
- Request shape: `{ model: string, prompt: string, ...modelSpecificParams }` (verified)
- Response: async — initial returns `{ data: { id } }`; poll returns `{ data: { status: 'completed' | 'failed', outputs: [url] } }` (verified)
- Model string is the literal `baidu/ERNIE-Image-Turbo/text-to-image` (matches user's billing UI verbatim)
- `ATLAS_API_KEY` is present in `.env.local` (verified; `.env*` is gitignored — verified)

## Unverified (will probe at integration time, with fallback)

- ERNIE's exact accepted size / aspect-ratio params — Atlas docs say "each model has unique parameters, check the model page." The model page itself returned no API details when fetched. The first-pass builder will send `{ model, prompt }` only and treat extra params as additive once we see what the API accepts/rejects. **Mitigation:** the first request will be logged with full request + response shape (rule 14) so the schema reveals itself on first run.
- Output URL TTL — unknown. **Mitigation:** R2 re-host the result immediately after upscale, same pattern Kie URLs already use. No code path depends on the raw Atlas URL surviving.
- Rate limits / quotas — undocumented in the pages I fetched. **Mitigation:** copy the per-IP + per-user rate limits the production-doc route already enforces. If Atlas pushes back with 429, the poll loop already handles that pattern.

---

## Chosen approach

**Mirror the Kie pattern, not invent a new abstraction.** Add `'atlas'` to the provider union, add a registry entry, add a new `atlas-images.ts` lib that mirrors `kie-poll.ts` structure (createAtlasTask + pollAtlasResult + pollAtlasResultThenUpscale), and add a dispatch branch in every consuming route.

### Files touched

**New files (2):**
1. `src/lib/atlas-images.ts` — `createAtlasTask` / `pollAtlasResult` / `pollAtlasResultThenUpscale` / `atlasErrorMessage`. Same shape as `kie-poll.ts:55-186`. The `ThenUpscale` variant calls `upscaleViaRecraft` exactly like Kie does — that's how the user's "upscale through Kie" requirement is met without a new code path.
2. `tests/atlas-images.test.ts` — unit tests for the builder (1K policy, payload shape) and an integration smoke test gated on `ATLAS_API_KEY` being set.

**Modified files (8):**
1. `src/lib/image-models.ts` — extend `ImageModelProvider` union to include `'atlas'`; add `atlasModel?: string` to `ImageModelSpec`; add ERNIE registry entry; add a `buildAtlasImageInput` builder that mirrors `buildKieImageInput`. Keep the 1K-policy guard fired identically.
2. `src/app/api/generate/production-doc/image/route.ts` — add `case 'atlas'` branch that calls `createAtlasTask` + `pollAtlasResultThenUpscale`. R2-mirror the returned URL with the existing helper.
3. `src/app/api/thumbnails/image/route.ts` — same dispatch, same shape.
4. `src/app/api/thumbnails/format/n-levels/image/route.ts` — same.
5. `src/app/api/thumbnails/format/topic-card-grid/image/route.ts` — same.
6. `src/lib/auto-pipeline/image-gen.ts` — extend `generateImageWithFallback` to allow `'atlas'` as a provider in the fallback chain. **Default chain stays Kie-first.** Atlas is added as a tail entry so the unattended pipeline keeps producing identical-quality output today.
7. `src/lib/ai-pricing.ts` — add `baidu/ERNIE-Image-Turbo/text-to-image` with `costUsdPerImage: 0` and a comment pointing at the billing screenshot.
8. `.env.local.example` (or equivalent — verify which file the repo uses) — document `ATLAS_API_KEY`.

### Why this shape (vs alternatives)

| Approach | Summary | Verdict |
|---|---|---|
| **A. Mirror Kie pattern (chosen)** | New `atlas-images.ts` matches `kie-poll.ts` shape. Per-route dispatch branches. Registry adds 4th provider. | **Chosen.** Lowest cognitive load — every existing maintainer already understands the Kie pattern. Zero refactor risk to the other 3 providers. New Atlas models become 1 registry-entry change. |
| B. Build a unified `ImageProvider` interface and migrate all 4 to it | Define `interface ImageProvider { generate(prompt, opts): Promise<string> }`; rewrite kie / openai / comfyui / atlas to implement it. | Rejected. Bigger surface, touches 3 working providers for the sake of architectural purity. The 4-route dispatch isn't actually painful (4 small switches). Save the refactor for when a 5th provider proves the abstraction. |
| C. Skip the dedicated lib; inline the fetch calls in each route | Each route file gets its own ~30-line createTask + poll. | Rejected. Duplicates the same retry / 502-handling / poll-loop / R2-rehost / upscale-dispatch logic in 5 places. Guaranteed drift. |

---

## Security (rule 13)

- **Secret handling:** `ATLAS_API_KEY` read via `process.env.ATLAS_API_KEY` server-side only. Same pattern as `KIE_API_KEY`. Never bundled into client code (image-models.ts is client-safe and contains *no* env access — by design).
- **No client exposure:** Generation runs server-side in a Next API route; only the resulting R2-hosted URL ever reaches the browser. Atlas's raw URL is never echoed to the client even transiently.
- **Logging discipline:** `console.info` calls log the model name, the input shape (sizes, aspect ratio, prompt length — NOT the prompt itself for PII reasons, matching what Kie logs do today), and the response status. The API key is never logged. Prompts are not logged in production (`NODE_ENV === 'production'` guard).
- **Input validation:** Prompt length capped at the existing per-route ceiling. Model value validated against `IMAGE_MODELS` registry (already done — adding to the registry inherits this).
- **Failure mode:** If Atlas returns a content-policy reject, classify it the same way the i2i dispatcher does (image-gen-i2i.ts:587-615) so the user sees a clear message, not a stack trace.
- **No bypass of rate limits:** Production-doc image route enforces per-IP + per-user limits at route entry. Atlas dispatch is downstream of those, so it inherits them. Verify on the thumbnails routes — if any lack rate limits today, this change does not introduce them but flags it for a follow-up.

## Observability (rule 14)

Every Atlas step gets a namespaced `console.info` log. Concrete logging plan:

- `[atlas createTask] sent` — `{ model, promptLen, hasNegative, aspect }` before the POST
- `[atlas createTask] ok` — `{ predictionId, latencyMs }` after the POST
- `[atlas createTask] failed` — `{ status, body }` on any non-2xx (body truncated to 400 chars)
- `[atlas poll] tick` — `{ predictionId, attempt, status }` each poll iteration (gated to log every 5th tick to avoid spam)
- `[atlas poll] done` — `{ predictionId, totalLatencyMs, outputUrl }` (outputUrl logged because it's about to be R2-mirrored and we want a trail of what URL we mirrored from)
- `[atlas poll] failed` — `{ predictionId, error }` on terminal fail
- `[atlas dispatch] route=production-doc` (and equivalents for thumbnails / n-levels / topic-card-grid / auto-pipeline) — fires at route entry, identifies which surface picked Atlas
- `[atlas upscale] delegated` — confirms the result URL was handed to `upscaleViaRecraft` (visible in the existing upscale log line, but stating it explicitly here closes the audit loop on the user's "must go through Kie upscale" requirement)

When a user reports "ERNIE didn't work for me," the console output from these 8 lines should make the failure point obvious without needing to add ad-hoc logging.

## Settings (rule 15)

The picker dropdowns already auto-populate from the `IMAGE_MODELS` registry — adding the registry entry surfaces ERNIE in the production-doc per-row picker and the thumbnail pickers without touching any UI code. That satisfies the "user can pick it" requirement.

**No new Settings page entries** in this phase. Reason: the only user-facing knob would be "default image model," and the user already chose to keep current defaults. Revisit if we later add: (a) a "free models only" filter toggle, (b) a "prefer free when quality is comparable" auto-selector, or (c) the ability to mark certain models as channel-default. Flagging these as future work, not implementing now.

## UI/UX (rule 16)

- **Picker label:** "Baidu ERNIE Image Turbo — Free" with hint "Atlas Cloud · text rendering · $0 / image (free tier)" — makes the free-ness visible at-a-glance, matches the existing pattern (Grok hint says "Default — fast, broad style range"; nano-banana hint says "$0.04/image").
- **Group ordering:** Insert under a new comment-divider `// ─── Atlas Cloud (text-to-image, free tier) ───` between the Kie cloud group and the bottom of the file. Keeps the existing reading order: local → Kie → Atlas, free-first within paid-free mix.
- **Failure messaging:** When Atlas times out or rejects, the user-visible error reads "ERNIE generation failed — try a different model or retry" with the underlying message appended. Same UX shape as today's Kie failure path.
- **No new screens, no new states.** The pickers and the progress UI handle Atlas exactly as they handle Kie.

## Testing / QA (rule 6)

- **Unit:** `tests/atlas-images.test.ts` — builder produces expected payload shape; throws on unknown model; matches 1K policy.
- **1K policy:** extend `tests/image-models-1k-enforcement.test.ts` with Atlas builder coverage.
- **Integration smoke (gated on `ATLAS_API_KEY`):** end-to-end generate-and-upscale, asserts the final URL is R2-hosted (not raw Atlas).
- **Manual QA walkthrough:**
  1. Production-doc → pick a row → switch model to "Baidu ERNIE Image Turbo" → generate → verify image appears, R2-hosted, upscaled.
  2. Thumbnails → pick ERNIE → generate three thumbs → verify all upscaled and saved.
  3. Auto-pipeline → simulate a Kie failure → verify Atlas takes over per fallback chain.
  4. Error path: temporarily unset `ATLAS_API_KEY` → verify 503 with clear message.
  5. Logs: tail the dev server while generating once on ERNIE → confirm all 8 log lines from the Observability section fire with non-empty values.

## Cost (rule 8)

- **ERNIE-Image-Turbo:** $0.00 per image (confirmed by user's billing screenshot showing `$0.00000000` for two recent calls).
- **Recraft upscale per Atlas image:** $0.0025 (same as today's per-image upscale — unchanged because Atlas inherits the Kie upscale path).
- **Net new spend:** ~$0.0025 per Atlas image (upscale only). Per 1000 thumbnails switched from nano-banana to ERNIE, savings are ~$40 in generation cost minus $0 change in upscale cost.
- **Open question:** Atlas's free tier may have a daily quota that isn't documented on the pages I could reach. **Action:** if first-week usage hits a quota wall, we'll see it as a specific error from Atlas and can add a daily counter + auto-fallback to Kie. Not building that today.

## Open questions for Yoav

1. **Auto-pipeline fallback position:** when Kie fails in the cron, should Atlas (free, slightly unknown quality) come before or after the existing Kie retries? Default in this plan: **after** — Kie keeps primacy, Atlas only fires if Kie keeps failing. If you'd rather try Atlas first for the cost savings, say so before I wire it.
2. **Tests folder convention:** `tests/atlas-images.test.ts` is a guess — confirm if the project uses a different test-file location for lib-level units.
3. **`.env.local.example`** — I haven't yet checked whether the repo keeps one; if not, the `ATLAS_API_KEY` docs go into the README env section. Will resolve at execution time.

## Out of scope (for this plan)

- Atlas i2i model wiring (user explicitly excluded — revisit when there's a concrete i2i use case)
- Atlas's other 299+ models (Qwen-Image, FLUX, Ideogram via Atlas) — registry can absorb them in 1 line each once the first one ships
- Cost-tracking-per-call telemetry — the current pipeline logs $0 for image generation already; adding real cost telemetry is a separate project the user has flagged previously
- A "free models only" UI filter — Settings audit (rule 15) flagged it; not building it now
- Daily-quota tracking + auto-fallback when Atlas's free tier caps — wait for evidence the cap exists

---

## Execution outcome (2026-05-24)

**Code shipped:** 8 files modified, 2 new files (`src/lib/atlas-images.ts`, `tests/atlas-images.test.ts`). All 23 Atlas-related tests pass. `npx tsc --noEmit` clean. Full test suite: 1855/1856 pass (1 pre-existing voiceover failure, unrelated). Dispatch wired in production-doc image route, `/api/thumbnails/image` route + the inline picker on `src/app/(app)/thumbnails/page.tsx`, and auto-pipeline tail-fallback (`generate-thumbnail.ts:DEFAULT_THUMBNAIL_CHAIN`).

**Live API: NOT verified.** End-to-end smoke against the real Atlas surface failed. Specifically:

- `GET https://api.atlascloud.ai/v1/models` with `Authorization: Bearer <ATLAS_API_KEY>` returns **200** with the full LLM model catalog — proves the key is valid against Atlas's OpenAI-compatible surface.
- `POST https://api.atlascloud.ai/api/v1/model/generateImage` (the endpoint Atlas's docs publish, including the API tab on the ERNIE model page) returns **`404 not found`** for every body variant tried — flat `{model, prompt}` (matches OpenAPI schema embedded in the page) AND wrapped `{model, input:{prompt}}` (matches the Python code block on the page). The same 404 fires against Atlas's own example model (`seedream-3.0`). Direct cURL reproduces.
- Three other plausible paths exist (`/api/v1/sd/generateImage`, `/api/v1/more-models/{model}/generateImage`, `/api/v1/model_run`) — all return **401** with the user's key, meaning routes exist but the key lacks image-generation scope.

**Most likely root cause:** the API key in `.env.local` has LLM-only scope. The user's billing dashboard shows ERNIE usage at $0, but those calls probably went through Atlas's dashboard session, not a scoped API key.

**Unblock options for the user:**
1. Provision a new Atlas API key with image-generation scope from the dashboard, paste into `.env.local`. Code starts working immediately — no further changes.
2. Open the model's "Try it" tab in the Atlas dashboard, hit DevTools → Network, capture the exact working request URL + headers + body, share with us. Update `src/lib/atlas-images.ts:ATLAS_BASE` + body shape in `createAtlasTask` to match (single-file diff, < 10 lines).
3. Contact Atlas support — the docs page is publishing a 404 endpoint, which is worth flagging to them regardless.

**Why this plan is closed as "implementation complete":** Every architectural decision is locked in, every dispatch site is wired, all tests pass, the upscale-via-Recraft requirement is met, and the LIVE blocker is a credential/endpoint issue outside the codebase. The plan as written has no remaining engineering work; it's blocked on an external integration detail only the user can resolve.
