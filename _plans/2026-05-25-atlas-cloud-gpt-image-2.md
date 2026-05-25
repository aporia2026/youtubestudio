# Atlas Cloud as a second provider for GPT Image 2 (T2I + Edit + I2I)

**Date:** 2026-05-25
**Status:** Drafted, awaiting approval
**Owner:** info@flexelent.com
**Related plans:** [_plans/2026-05-24-system-upscale-and-collage.md](2026-05-24-system-upscale-and-collage.md) (defines `upscaleViaRecraft` + `pollKieResultThenUpscale` + the collage route this builds on)

## Goal

Add Atlas Cloud (`api.atlascloud.ai`) as a second routing path for the GPT Image 2 model family, in addition to the existing Kie.ai route. Atlas is materially cheaper per image ($0.009 T2I vs. an estimated ~$0.04 for comparable Kie cloud models), so the user wants Atlas as the default surface for any GPT Image 2 call, with Kie kept as a parallel picker option.

Scope:
1. **T2I** (`openai/gpt-image-2/text-to-image`) wired into the production-doc image generator, thumbnails routes, and auto-pipeline.
2. **Edit** (`openai/gpt-image-2/edit`) wired into `/api/generate/production-doc/image/edit/route.ts` and `/api/overlay/edit/route.ts`.
3. **I2I** (`openai/gpt-image-2/image-to-image`) wired into the production-doc i2i dispatcher (`image-gen-i2i.ts`) so ref-bearing styles can pick it.
4. **Collage** support: `/api/generate/production-doc/collage/route.ts` learns to dispatch to Atlas when the chosen model is the Atlas variant.

Every generated Atlas image flows through the existing Recraft Crisp Upscale via `src/lib/upscale.ts` and lands in R2 by the same `prodoc-images*` key pattern Kie images use today.

## Why this shape

The existing app has a clean chokepoint for "generate → upscale → R2 mirror" (the Phase 2 work from the 2026-05-24 plan), and a working collage path that already does "single batched call → upscale → slice → 4 quadrants." Both were built assuming the only async provider was Kie. Atlas's API is shaped almost identically (POST → `prediction_id` → poll → URL), so the integration is best modelled as a sibling to Kie, not a replacement. Keeping both routes coexist means we can A/B Atlas vs. Kie on quality and fallback by switching the picker if Atlas degrades.

The user explicitly chose **no automatic Kie failover** when Atlas errors, so failure surfaces match the rest of the app: clean error message, regenerate button. That keeps vendor problems visible to the operator rather than hidden behind silent failover that inflates spend.

## Discovered constraints (verified against Atlas docs, 2026-05-25)

These shape the implementation; flagging because two of them are not obvious from the user's framing.

### 1. Atlas GPT Image 2 does not support 16:9 natively
The published `size` enum is `1024×1024` / `1024×1536` / `1536×1024`. The closest to 16:9 is `1536×1024` (3:2 aspect, ~1.5), but the app generates everything at 16:9 (~1.78 aspect) and the Remotion + FFmpeg renderers assume 1920×1080 stills.

**Decision (locked with user):** Generate at `1536×1024`, center-crop to `1536×864` in the Atlas adapter before handing the URL upstream. Crop removes a ~80px strip top and bottom (~8% each side, ~16% total). After Recraft 4× upscale that becomes ~6144×3456, comfortably 4K at native 16:9.

**Risk:** If the model frames the subject high or low in the 3:2 frame, the crop clips it. Mitigation: a prompt-augmentation directive added by the Atlas adapter ("composition centred vertically; subject in the central 70% of the frame") to bias the model away from edge-framed compositions. Tunable post-QA.

### 2. Edit endpoint is token-billed, not flat $0.01
Atlas's catalog page advertises Edit at "$0.01/PIC"; the actual API doc shows token billing: `$0.00003/output token + $0.000008/image token + $0.000005/prompt token`. The $0.01 is a rough estimate. Real cost depends on input image size, output quality, and prompt length.

**Decision:** Treat Edit as "approximately $0.01 per call" for the cost model, but log the actual token counts returned by Atlas per call so we can true up the estimate after a week of real traffic.

### 3. I2I docs are sparse
The dedicated `/models/openai/gpt-image-2/image-to-image` page does not document the request schema. The Edit endpoint accepts `images: [...]` ("one or more"). We are going to treat I2I as the same shape as Edit (multi-image input via `images`), with a conservative cap of 4 refs for v1, and validate the actual upper limit during implementation via a curl probe.

**Risk:** If I2I rejects multi-image input or has a stricter cap, the i2i registry entry needs adjusting before launch. Mitigation: a unit test that hits a sandbox Atlas key with 1, 4, and 8 refs and asserts the response shape. If 4 fails, drop to 2 in the spec.

### 4. No mask param documented
Atlas Edit doesn't show a `mask` field. Our existing eraser / smart-edit flows in `/api/overlay/edit/route.ts` use Kie's mask param. So:

**Decision:** Atlas Edit is wired up only for the **prompt-only** edit flows (full-image rewrites). The mask-requiring eraser flow stays on Kie. The eraser UI either disables the Atlas option in its model picker or, if the user picks Atlas + mask, the route returns 400 with a clear message.

## Architecture: alternatives + recommendation (rule 4)

Three ways to slot Atlas into the existing per-route dispatch:

### Option A — Centralized dispatch shim (recommended)
Add `src/lib/image-gen-dispatch.ts` exporting one function:
```
async function generateImageWithUpscale(
  spec: ImageModelSpec,
  prompt: string,
  opts?: { atlasSizeOverride?: string },
): Promise<{ url: string; modelUsed: string; durationMs: number }>
```

It branches on `spec.provider` (`'kie' | 'atlas' | 'comfyui-local'`) and returns a finalized URL after upscale + (for Atlas only) the 16:9 center-crop. Each of the 7 existing surfaces shrinks from a 30-line if/else block to a one-line call.

**Pros:** Adding a 4th provider later is one branch in one file, not 7 routes. Test surface is small. The 16:9 crop logic lives in one place so it can never drift.

**Cons:** Touches 7 files in a single PR for the refactor portion. Higher review burden up front.

### Option B — Atlas adapter that mimics the Kie task-id shape
Make `generateImageAtlas()` return a synthetic "task ID" that `pollKieResultThenUpscale` can swallow, so existing route code path is unchanged. The adapter does the Atlas POST + poll under the hood and pretends it was Kie.

**Pros:** Zero changes to existing routes. Lowest blast radius.

**Cons:** Cute but dishonest abstraction. The `apiKey` parameter is meaningless for Atlas calls; logs say "[kie poll]" for Atlas operations; future readers have to learn the lie. Every observability tag goes wrong. Atlas's center-crop step has nowhere clean to live.

### Option C — Just add an `else if` branch to each of the 7 routes
Mirror what `comfyui-local` does today. No refactor.

**Pros:** Easy to read in isolation, smallest diff per route.

**Cons:** 7 copies of the same Atlas branch. 7 places to update when Atlas changes their auth header. 7 places to fix when we discover the 16:9 crop has an edge case. This is exactly the maintenance burden the 2026-05-24 upscale plan dodged by introducing `pollKieResultThenUpscale` as a chokepoint. Repeating the mistake here would be a regression.

**Recommendation:** **Option A.** Cost is a one-time refactor of 7 routes during the same PR; benefit is permanent. Matches the chokepoint design the upscale plan already committed to.

## Phase 1 — Atlas T2I + dispatch chokepoint

### Files

1. **New `src/lib/atlas-cloud-images.ts`** — one file for all three Atlas modes.
   ```typescript
   export interface AtlasGenerateOpts {
     prompt: string;
     size: '1024x1024' | '1024x1536' | '1536x1024';
     quality?: 'low' | 'medium' | 'high';
   }
   export async function generateAtlasT2I(opts: AtlasGenerateOpts): Promise<string> // URL
   export async function generateAtlasEdit(opts: { prompt: string; images: string[]; size?: ...; quality?: ... }): Promise<string>
   export async function generateAtlasI2I(opts: { prompt: string; images: string[]; size?: ...; quality?: ... }): Promise<string>
   ```
   All three:
   - POST to `https://api.atlascloud.ai/api/v1/model/generateImage` with `Authorization: Bearer ${ATLAS_CLOUD_API_KEY}`.
   - Poll `GET /api/v1/model/prediction/{id}` with the same backoff curve `pollKieResult` uses (1s → 2s → 2s, capped at 285s total to match Kie's ceiling).
   - Throw plain `Error` with a `[atlas-images]`-namespaced message on failure. No silent fallback. Matches the fail-soft policy locked with the user.

2. **New `src/lib/image-gen-dispatch.ts`** — the shim from Option A.
   - `generateImageWithUpscale(spec, prompt, opts)` branches on `spec.provider`.
   - Kie branch: existing `createKieTask + pollKieResultThenUpscale` (already in `kie-poll.ts`).
   - Atlas branch: pick Atlas size based on `spec`, call `generateAtlasT2I`, then **center-crop** via sharp to 16:9 (helper `cropTo16x9(url) → url` lives here), then `upscaleViaRecraft(url)`.
   - Returns `{ url, modelUsed, durationMs }`.
   - Local ComfyUI branch out of scope for this plan; that path stays as-is in each route (it has its own LOCAL_STUDIO flag dance that doesn't share the upscale path).

3. **`src/lib/image-models.ts`** — registry additions.
   - New entry between `gpt-image-2-t2i` and `ideogram-v3-quality-t2i`:
     ```
     {
       value: 'gpt-image-2-atlas-t2i',
       label: 'GPT Image 2 (Atlas — cheaper)',
       provider: 'atlas',
       atlasModel: 'openai/gpt-image-2/text-to-image',
       atlasSize: '1536x1024',  // we crop to 1536x864 in the dispatcher
       atlasQuality: 'medium',
       hint: 'Default GPT Image 2. ~$0.009/image, ~8s. Same model as the Kie entry below, cheaper route.',
     }
     ```
   - **Default GPT Image 2 = Atlas:** the Atlas entry appears above the Kie entry in `IMAGE_MODELS`, and per the user's instruction the picker copy makes Atlas the recommended GPT Image 2 variant. The overall app default (`DEFAULT_IMAGE_MODEL = 'grok-imagine-t2i'`) does not change.
   - Add `provider: 'atlas'` to the `ImageModelSpec` discriminated union. Existing entries get `provider: 'kie'` made explicit (today the registry implies it via the `kieModel` field).
   - Update `buildKieImageInput` to throw if called with an Atlas spec (defense in depth — the dispatcher should never reach this branch for Atlas, but if a future change forgets the new branch, this fails loud rather than sending garbage to Kie).

4. **`src/app/api/generate/production-doc/image/route.ts`** — replace the inline `createKieTask + pollKieResultThenUpscale + R2-mirror` block (lines 463–507) with a single `generateImageWithUpscale(spec, augmentedPrompt)` call. The R2 mirror logic moves into the dispatcher so it's shared.

5. **`src/app/api/thumbnails/image/route.ts`** — same treatment. The Atlas dispatch behaves identically to Kie from this route's perspective.

6. **`src/app/api/thumbnails/format/n-levels/image/route.ts`** + **`src/app/api/thumbnails/format/topic-card-grid/image/route.ts`** — same.

7. **`src/lib/auto-pipeline/image-gen.ts`** — `generateImageWithFallback` calls the new dispatcher; existing "fallback to a second model on failure" loop stays, just with Atlas as a possible candidate.

8. **`.env.example`** — add `ATLAS_CLOUD_API_KEY=...` with a comment pointing at `https://www.atlascloud.ai/console/api-keys`.

### Center-crop helper

`cropTo16x9(url): Promise<string>` in `image-gen-dispatch.ts`:
- Fetches the bytes.
- `sharp(buf).metadata()` to get W×H.
- Computes target height = `Math.round(W * 9 / 16)` (for 1536 → 864).
- Computes `top = Math.round((H - targetHeight) / 2)`.
- `sharp(buf).extract({ left: 0, top, width: W, height: targetHeight }).jpeg({ quality: 92 }).toBuffer()`.
- Uploads to R2 with key prefix `prodoc-images-atlas-crop/` (lets us see in R2 metrics how often the Atlas path runs).
- Returns the R2 URL.

This URL is what `upscaleViaRecraft` is then called on, so the upscale operates on the cropped 16:9 image (not the original 3:2). Net result: same final shape as today's Kie-generated images.

### Tests
- New `tests/atlas-cloud-images.test.ts` — mocks fetch, asserts request body shape, asserts auth header, asserts the 285s timeout matches Kie's.
- New `tests/image-gen-dispatch.test.ts` — asserts each provider branch is reached for the right spec; asserts Atlas branch invokes the crop step before upscale; asserts a Kie spec never hits `generateAtlasT2I` and vice versa.
- New `tests/image-gen-dispatch-atlas-crop.test.ts` — feeds a 1536×1024 fixture image into `cropTo16x9`, asserts the output is exactly 1536×864 with the same width, top trim ~80px.
- Existing tests that hardcoded `createKieTask` direct calls in routes need updating to mock the dispatcher instead.

## Phase 2 — Atlas Edit

### Surfaces
- `/api/generate/production-doc/image/edit/route.ts` — the production-doc per-row edit flow. Today it routes everything through Kie. Adds an Atlas branch via the dispatcher.
- `/api/overlay/edit/route.ts` — the eraser / smart-edit flow. **Keeps Kie only** because of the mask-param gap (see discovered constraint 4). The model picker for this surface filters out the Atlas Edit option.

### Registry
New file `src/lib/image-edit-models.ts` (we don't have one today — edit-mode model selection is implicit). It exports an `EditModelSpec` union:
```
{ value: 'gpt-image-2-atlas-edit', label: 'GPT Image 2 Edit (Atlas)',
  provider: 'atlas', atlasModel: 'openai/gpt-image-2/edit', supportsMask: false }
{ value: 'gpt-image-2-kie-edit',   label: 'GPT Image 2 Edit (Kie)',
  provider: 'kie',   kieModel: 'gpt-image-2-edit',          supportsMask: true }
```
The production-doc edit route lets the user pick either. The overlay/edit route filters to `supportsMask: true`.

The Atlas Edit branch in the dispatcher does **not** apply the 16:9 crop — it preserves the input image's aspect. If the input was 16:9 the output will be too (Atlas Edit returns the same aspect as input per their docs).

### Dispatcher extension
`generateImageWithUpscale` gains a sibling: `editImageWithUpscale(spec, prompt, refImageUrls, opts)`. Same provider-branch shape.

### Cost telemetry
Atlas Edit is token-billed. The dispatcher logs the actual token counts from Atlas's response (`metrics.input_tokens`, `metrics.output_tokens`, `metrics.image_tokens` if returned) so we can true up our cost-per-call estimate over the first week.

## Phase 3 — Atlas I2I (reference-driven generation)

### Surfaces
`src/lib/image-gen-i2i.ts` — the i2i dispatcher used by the production-doc image route when a style with refs is selected. Today it routes to Kie (NanoBanana variants) or ComfyUI Local. Adds Atlas as a third `provider`.

### Registry (`src/lib/image-models-i2i.ts`)
New entry:
```
{
  value: 'gpt-image-2-atlas-i2i',
  label: 'GPT Image 2 + Refs (Atlas)',
  provider: 'atlas',
  atlasModel: 'openai/gpt-image-2/image-to-image',
  refsField: 'images',
  maxRefs: 4,  // conservative; verify against Atlas during implementation
  extraInput: { size: '1536x1024', quality: 'medium' },
  hint: 'Cheap ref-driven generation. Max 4 refs.',
  costUsdPerImage: 0.009,
}
```

### Implementation
`generateImageWithRefs` in `image-gen-i2i.ts` branches on `spec.provider`. New Atlas branch calls `generateAtlasI2I({ prompt, images: refs.map(r => r.public_url), size, quality })`, then center-crops to 16:9, then runs `upscaleViaRecraft`.

### Reference URL safety (rule 13)
Atlas pulls each ref by URL. Our refs live in R2 with presigned URLs (already public for Atlas to fetch). The existing `checkSafePublicUrl` SSRF guard in `production-doc/image/route.ts` already runs on caller-supplied ref URLs; the i2i dispatcher inherits that protection because refs always come from `loadStyleReferences` which only returns server-vouched URLs.

### Probe test
New script `scripts/atlas-i2i-ref-cap-probe.ts` (not committed to CI; run-once during implementation):
- Calls `generateAtlasI2I` with 1, 4, and 8 refs against a sandbox key.
- Asserts each call's response shape.
- If 4 fails, downgrade `maxRefs` to 2 in the registry before launch.

## Phase 4 — Collage route supports Atlas

### File: `src/app/api/generate/production-doc/collage/route.ts`

Today the route restricts to `spec.provider === 'kie'` and uses `createKieTask + pollKieResultThenUpscale` directly. Two changes:

1. **Eligibility widening:** allow `spec.provider === 'kie' || spec.provider === 'atlas'`. ComfyUI Local stays excluded (no upscale path → 540px quadrants, same reason as the original plan).

2. **Provider dispatch:** replace the two-line generate-and-poll with `generateImageWithUpscale(spec, composedPrompt)` from the new dispatcher. Atlas's center-crop runs as a sub-step so the 2×2 collage lands at 1536×864 → after Recraft 4× becomes ~6144×3456, sliced into 4 quadrants of ~3072×1728 each (still 16:9, still 4K class).

3. The detection (`detectMalformedCollage`) and slicing (`sliceCollage`) steps are provider-agnostic and don't change.

### Collage prompt for Atlas
`composeCollagePrompt` (in `src/lib/collage-prompt.ts`) already produces a single text block. For Atlas we **also** append the centring directive from constraint 1: "composition centred vertically in each cell; subject in the central 70% of each cell." This shows up only when `spec.provider === 'atlas'` so we don't perturb Kie behaviour.

### Cost picture for collage on Atlas
Per group of 4 shots:
- 4 single Atlas T2I calls + 4 upscales = 4 × $0.009 + 4 × $0.0025 = ~$0.046
- 1 collage Atlas call + 1 upscale = $0.009 + $0.0025 = ~$0.0115
- **Savings: ~75%**, same as the Kie collage savings ratio.

## Cost picture (rule 8)

| Operation | Today (Kie) | Atlas | Delta |
|---|---|---|---|
| Single GPT Image 2 T2I + upscale | ~$0.04 + $0.0025 = $0.0425 (est.) | $0.009 + $0.0025 = $0.0115 | ~73% cheaper |
| Single Edit (full image) | ~$0.04 + $0.0025 = $0.0425 (est.) | ~$0.01 + $0.0025 = $0.0125 (token-billed; est.) | ~70% cheaper |
| Single I2I with refs | ~$0.04 + $0.0025 = $0.0425 (est.) | $0.009 + $0.0025 = $0.0115 | ~73% cheaper |
| 2×2 collage (4 shots) | $0.04 + $0.0025 = $0.0425 (est., 1 call) | $0.009 + $0.0025 = $0.0115 | ~73% cheaper |

Caveats on these numbers:
- Kie's per-image cost for `gpt-image-2-text-to-image` is not on a public Kie docs page I could fetch (their pricing page 404'd). The $0.04 figure is the estimate from the existing image-models-i2i.ts cost annotations for comparable Kie cloud models. **QA step: pull the actual Kie invoice line for gpt-image-2 calls last 30 days and verify the savings estimate before locking the picker copy.**
- Atlas Edit cost is token-billed; the $0.01 is Atlas's marketing estimate, not a contract. Real cost likely ranges $0.005–$0.02 depending on input image size and quality. Logged per-call so we can refine.
- Recraft Crisp Upscale stays at $0.0025/image regardless of which generation provider runs.

At 1000 GPT Image 2 generations/month, projected monthly savings: **~$31/month**. At 10000/month: **~$310/month**.

## Security (rule 13)

- **New env var `ATLAS_CLOUD_API_KEY`.** Server-only. No `NEXT_PUBLIC_` prefix. Documented in `.env.example` with the dashboard URL. Stored in Vercel project env vars before deploy.
- **Key handling:** never logged. The `[atlas-images]` log namespace logs the model id, prompt length (not content), and the prediction id only.
- **SSRF surface:** Atlas Edit and I2I take image URLs we provide. Two URL sources:
  1. Server-generated R2 URLs (collage path, edit-result chain) — safe.
  2. User-stored style references via `loadStyleReferences` — already SSRF-guarded by `checkSafePublicUrl`; the i2i dispatcher inherits that protection.
- **Rate limits:** the existing IP+UID rate limits on production-doc image and edit routes (`30/min` each) apply to the Atlas branch unchanged. The collage route's 30/min ceiling also covers Atlas calls; the savings ratio matters here because the same minute budget can produce 4× as many shots when collage mode is on.
- **Mask gap:** the eraser flow on `/api/overlay/edit` filters out Atlas Edit at the picker level **and** at the route level (defense in depth). If a client somehow posts an Atlas model id with a mask field, the route returns 400 with `code: 'MASK_NOT_SUPPORTED'`.
- **Cost cap defense:** a malicious user with a session could try to drive cost through repeated Atlas calls. The two-layer rate limit already covers this (30/min IP + 30/min UID); no new attack surface vs. today.
- **Best practice check:** I will verify Atlas's current TLS posture and API hygiene recommendations (cert pinning, key rotation cadence) on https://www.atlascloud.ai/docs/api-keys before shipping. If they recommend a rotation cadence, add a calendar reminder.

## Observability

All logs namespaced. Examples:
- `[atlas-images t2i] start { model, size, prompt_chars }`
- `[atlas-images t2i] poll { prediction_id, attempt, status }`
- `[atlas-images t2i] success { prediction_id, predict_ms, output_url_preview }`
- `[atlas-images t2i] failed { prediction_id, error }`
- `[atlas-images edit] success { prediction_id, input_tokens, output_tokens, image_tokens, estimated_cost_usd }`
- `[atlas-images i2i] start { model, ref_count, prompt_chars }`
- `[image-dispatch] route { provider, model, has_refs }`
- `[image-dispatch] atlas crop { source_w, source_h, target_w, target_h, ms }`

Client-side: the production-doc editor surfaces a small "Atlas" tag next to the image when the Atlas variant is the picked model, so the user can see which provider ran without opening dev tools.

## Settings audit (rule 15)

New env vars:
- **`ATLAS_CLOUD_API_KEY`** — required for any Atlas branch to run. If unset, dispatcher logs a warning and the Atlas picker options are filtered out at registry-load time (graceful degradation rather than 500).
- **`ATLAS_CLOUD_ENABLED`** (optional, default `true`) — kill switch matching the `AUTO_UPSCALE_ENABLED` precedent. Lets us flip Atlas off without a redeploy if they have an outage.

User-facing toggles: none new. Atlas is a picker option in the existing model dropdowns; no separate setting panel.

## UX (rule 10 + rule 16)

- **Picker copy.** Atlas variant labels make the cost-vs-route obvious without jargon:
  - `GPT Image 2 (Atlas — cheaper)`
  - `GPT Image 2 (Kie)` (the existing entry, label clarified)
  - `GPT Image 2 Edit (Atlas)` / `GPT Image 2 Edit (Kie)`
  - `GPT Image 2 + Refs (Atlas, max 4 refs)` / existing Kie/NanoBanana entries unchanged
- **Default behaviour for first-time generations.** When a row has no model preference saved and the prompt is a candidate for GPT Image 2 (e.g., the user's style was already on `gpt-image-2-*`), the Atlas variant gets picked. Existing saved preferences are honoured verbatim — no silent migration.
- **Error surface.** Atlas timeouts/errors show the same error toast the rest of the app uses ("Generation failed. Try again or pick a different model."). Following the user's locked decision: no auto-failover to Kie. The toast includes the model id so the user knows Atlas was the failed call.
- **Tag on generated image.** A subtle "Atlas" pill in the bottom-right of any image generated through an Atlas route, fading out after 3 seconds. Lets the user trace cost without spelunking through logs.
- **Mask-flow guard.** When the user is in the eraser tool, the Atlas Edit option doesn't appear in the model picker, full stop. No "select then disable" footgun.

## QA checklist (rule 6)

### Phase 1 (T2I + dispatcher)
- Open the production-doc editor, pick "GPT Image 2 (Atlas — cheaper)" on a row, generate → image appears at 1920×1080 (the upscaled 1536×864 × ~4) → logs show `[atlas-images t2i]` then `[upscale recraft]` then R2 mirror.
- Pick the Kie variant on a different row, generate → routes through Kie, logs show `[kie create-task]` not `[atlas-images]`. Two providers coexist cleanly.
- Pick Atlas with a prompt that's malicious-looking (long, with weird chars) → request body shape preserved, no header injection, no 5xx.
- Atlas API down (mock 503) → user sees clean error toast, no silent Kie fallback, logs show the failure.
- Atlas API slow (mock 60s poll latency) → dispatcher respects the 285s ceiling, eventually returns clean error.
- `ATLAS_CLOUD_API_KEY` unset → Atlas options filtered from picker on registry load, no 500s.
- `ATLAS_CLOUD_ENABLED=false` → Atlas options filtered same as above.
- Crop edge case: feed Atlas an image where the subject is in the top 15% → crop clips the head → flagged in QA; tune the centring prompt directive if this happens repeatedly.
- All 4 thumbnail routes (`thumbnails/image`, `thumbnails/format/n-levels/image`, `thumbnails/format/topic-card-grid/image`, the production-doc image route) work end-to-end with Atlas.

### Phase 2 (Edit)
- Production-doc per-row edit with Atlas Edit, prompt-only (no mask) → output image returns, aspect preserved, R2 URL durable.
- Same flow with Kie Edit (existing behaviour) → unchanged.
- Eraser flow on `/api/overlay/edit`: Atlas Edit option not present in picker.
- If a client POSTs an Atlas Edit model id + mask field to `/api/overlay/edit`, the route returns 400 with `code: 'MASK_NOT_SUPPORTED'`.
- Token-billed cost log: a single edit logs `input_tokens`, `output_tokens`, `image_tokens`, `estimated_cost_usd`. Number is plausible (matches the formula).

### Phase 3 (I2I)
- Create or edit a production-doc style with 1 reference image, pick "GPT Image 2 + Refs (Atlas)", generate a row → image returns, style is visibly carried.
- Same with 4 refs → still works (max cap).
- Same with 5 refs → route drops to 4 in the call and logs a warning.
- Reference URL SSRF: try to inject a `file://` or `http://169.254.169.254/...` ref via the API → `checkSafePublicUrl` blocks it, route returns 400.
- Probe script `scripts/atlas-i2i-ref-cap-probe.ts` ran successfully against a sandbox key with 1, 4, 8 refs — confirmed max is `4` (or update if Atlas accepts more).

### Phase 4 (Collage)
- Production-doc with collage mode on, pick the Atlas T2I model, generate 8 shots → 2 collage calls land, each gets upscaled + sliced, 8 quadrants assigned to rows in order.
- Each quadrant is 16:9, ~3K class.
- Malformed-quadrant detection still fires for Atlas results (the heuristic is shape-agnostic).
- Mixed-provider scenario: 4 rows have Kie GPT Image 2, the next 4 have Atlas GPT Image 2 → collage runs the first 4 through Kie, the next 4 through Atlas; both groups succeed.

### Cross-cutting
- 30/min IP and UID rate limits fire correctly on Atlas-route requests.
- No `ATLAS_CLOUD_API_KEY` in any log line (grep the dev log after a 100-call test run).
- `[atlas-images]` namespace search in logs shows clean entries with prediction ids only.

## Alternatives rejected

- **Option B (Atlas adapter mimicking Kie task-id):** rejected because dishonest abstraction creates long-term maintenance debt. Future readers see `[kie poll]` log lines for Atlas operations.
- **Option C (per-route Atlas branches, no shim):** rejected because the 2026-05-24 upscale plan already chose the chokepoint pattern; repeating the per-route copy-paste here is a step backward.
- **Replacing Kie's GPT Image 2 entirely with Atlas:** rejected by the user. Both routes coexist so we can flip the picker if Atlas degrades.
- **Auto-failover Atlas → Kie on error:** rejected by the user. Failures stay visible.
- **Outpaint to 16:9 instead of center-crop:** rejected as overkill for v1. Extra vendor call, extra cost, extra latency. Center-crop with a prompt directive covers 90% of real-world framing.
- **Letterbox the 3:2 image instead of cropping:** rejected because Atlas-generated shots would look visibly different (black bars) next to Kie / local 16:9 shots in the same doc. Inconsistency is worse than a defensible crop.
- **Skip Atlas entirely because of the aspect mismatch:** rejected because the cost savings (estimated ~73% per call) more than justify the crop step.

## Open questions

1. **Atlas I2I reference cap.** Documented as "one or more"; we're assuming up to 4 for v1 and will validate with a probe. If 4 fails, downgrade to 2 before launch.
2. **Kie's exact per-image cost for `gpt-image-2-text-to-image`.** Public docs pages 404'd; the savings estimate uses `~$0.04` based on comparable Kie cloud models. QA step is to pull the actual Kie invoice for last 30 days before locking the picker copy.
3. **Atlas Edit aspect behaviour.** Atlas docs say Edit preserves input aspect, but no explicit promise. If a 16:9 input ever returns a 3:2 output, the edit dispatcher needs a conditional crop. Verify during Phase 2 QA with a deliberate 16:9 input.
4. **Atlas response field for `images` in Edit/I2I — URL or base64?** Docs imply URL based on the upload-endpoint hint, but not confirmed. If base64, the adapter needs to add a step to upload bytes to R2 before passing on. Test during implementation; if base64, add the upload step.
5. **First-time-row default behaviour.** When a row has no model preference and the prompt is generic (not GPT-Image-2-tagged), we currently default to `grok-imagine-t2i`. Should that default shift to `gpt-image-2-atlas-t2i` now that it's the cheapest? Not in scope for this plan; flag for a follow-up if cost telemetry justifies it.

## Delivery order

1. **Phase 1.A (foundation):** new `atlas-cloud-images.ts` + `image-gen-dispatch.ts` + registry additions + `.env.example` + new tests. No route changes yet — the new files are reachable but unused.
2. **Phase 1.B (route refactor):** swap each of the 7 generate routes to use `generateImageWithUpscale`. Per-route smoke test after each swap. Atlas variant available in the picker for the first time at the end of this step.
3. **Phase 1 QA pass.**
4. **Phase 2 (Edit):** new `image-edit-models.ts` registry, `editImageWithUpscale` dispatcher extension, two-route swap, eraser-route Atlas exclusion, token-cost logging.
5. **Phase 2 QA pass.**
6. **Phase 3 (I2I):** ref-cap probe script first, then i2i registry entry, then `image-gen-i2i.ts` Atlas branch, then style-flow QA.
7. **Phase 3 QA pass.**
8. **Phase 4 (Collage):** collage-route eligibility widening + dispatcher hookup + centring-directive append for Atlas. QA the mixed-provider scenarios.
9. **Phase 4 QA pass.**
10. Update [ROADMAP.md](../ROADMAP.md) with the Atlas integration line.
11. After 1 week of real traffic: pull the Atlas + Recraft cost lines and verify the savings projection. Refine the cost telemetry if the token-billed Edit numbers are off.
