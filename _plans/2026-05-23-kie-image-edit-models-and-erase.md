# Add Kie.ai image-edit models + Erase-by-brush

**Date:** 2026-05-23
**Status:** Draft, awaiting approval
**Scope:** Production-doc image cells + shot editor (per user)

## 1. Goal

Add six new kie.ai image-editing models to the editor so users have real choice
of speed, quality, and price when fixing an asset; and add a dedicated **Erase**
action that lets the user paint over an unwanted object and have it removed
cleanly (object removal via mask inpainting).

Today the editor exposes two models hardcoded into one route:
`google/nano-banana-edit` (prompt-only, cheap) and `gpt4o-image/generate`
(mask-capable, expensive). Everything below extends that pipeline; no new
adapter layer.

## 2. Constraints

- Existing kie polling layer (`src/lib/kie-poll.ts`) stays the integration
  surface. No new client.
- Existing brush UI (`MaskBrushEditor.tsx`) stays the mask-painting surface.
- New models must work in **both** production-doc (`ImageCell`) and shot editor
  (`ShotInspector`/`EditPanel`), per user.
- Picker UX: a single dropdown listing model + per-edit USD cost, last-used
  default, sorted cheapest-first, per user.
- Mask-based models only: **Ideogram v3-edit** + **GPT-4o image-edit**. All
  other models on the list are prompt-only — they do not accept a mask. The UI
  must reflect that, not lie about it.
- Erase requires a mask-capable model. Default backend = Ideogram v3-edit
  QUALITY ($0.05) because it is purpose-built for inpainting and cheaper than
  the GPT-4o medium tier ($0.07).

## 3. Requirements (lazy-user lens, Rule 10)

A user opens an image. They want to fix it. They should:

1. See one obvious **Fix image** button (already exists, currently labelled
   ✎). It opens the EditPanel.
2. In the panel, see a model dropdown where each row reads like
   `Nano Banana — $0.02` or `Ideogram v3 Quality — $0.05 (mask)`. Mask-capable
   models tagged so the user knows brushing will engage.
3. Type a prompt → click **Apply** → see before/after → click **Use this** or
   try another model.
4. For a brush-mask edit: click the **Brush** button next to the dropdown. If
   the currently-selected model does not support masks, the Brush button is
   disabled with a tooltip — "This model edits the whole image; switch to
   Ideogram v3 or GPT-4o to brush a region." This is the cleanest of the three
   options the user picked from.
5. In the brush editor, alongside Apply, see an **Erase** button. Clicking
   Erase auto-fills a removal prompt ("Remove the painted region and rebuild
   the background to match the surroundings.") and routes through the default
   mask backend without making the user pick one. One click, object gone.
6. Last-used model persists per-user across sessions.

## 4. Decision — single route + model branching (recommended)

### Option A. Extend the existing route with per-model branches *(recommended)*

Add the six new models to `ALLOWED_EDIT_MODELS` in
`src/app/api/generate/production-doc/image/edit/route.ts`, branch the createTask
call on `model`, and reuse the existing R2 mirror + saliency block. The route
already has the shape; this is the smallest delta.

- **Summary:** One route, one polling layer, one mirror/saliency block, eight
  models. New models slot into the existing if/else ladder.
- **Pros:** Smallest code surface. Reuses every existing guard (auth, rate
  limit, SSRF, R2 mirror, saliency). One place to instrument logs.
- **Cons:** The if/else grows long — eight branches. Manageable with a small
  model-to-input-builder table.

### Option B. Per-model route files

`/api/generate/production-doc/image/edit/nano-banana`, `.../seedream-v4`,
`.../ideogram-v3`, etc.

- **Pros:** Each route stays small; easier to read in isolation.
- **Cons:** Eight near-identical files. Rate limiting + auth + mirror logic
  duplicated. New shared guards have to be touched eight times.

### Option C. Plugin-style model registry with `editImage(model, input)`

Drop the route's branching into a `src/lib/image-edit-models.ts` registry that
maps each model id to a `{ buildInput, callKie }` pair; the route becomes
`registry[model].callKie(buildInput(req))`.

- **Pros:** Cleanest separation; trivial to add the ninth model later.
- **Cons:** Adds an abstraction layer for a list of eight items, six of which
  collapse to "createKieTask + pollKieResult with these inputs". Premature
  abstraction (Rule against speculative design). Reconsider if we hit 15+
  models, not 8.

**Recommendation: Option A.** Smallest delta, all guards reused. We get a
clean implementation in one PR. If we ever cross 12+ models we revisit.

## 5. Model catalog & input shapes

The full catalog with verified facts from kie.ai docs. Prices marked **TBD**
are not on the static docs and not in the screenshot you shared; I cannot
verify them without you screenshotting the rest of your kie.ai pricing page
(see §11 Open questions).

| Picker label | Kie model id | Mask? | Native input we send | Price |
|---|---|---|---|---|
| Nano Banana — $0.02 | `google/nano-banana-edit` | no | `prompt`, `image_urls`, `image_size`, `output_format` | $0.02/image *(already wired)* |
| Qwen Image — $0.03/MP | `qwen/image-edit` | no | `prompt`, `image_url`, `acceleration`, `image_size`, `output_format` | $0.03/MP |
| Qwen2 Image — TBD | `qwen2/image-edit` | no | `prompt`, `image_url`, `image_size`, `output_format` | TBD |
| Ideogram v3 Turbo — $0.0175 *(mask)* | `ideogram/v3-edit` | yes, `mask_url` required | `prompt`, `image_url`, `mask_url`, `rendering_speed: TURBO`, `expand_prompt: true` | $0.0175/image |
| Ideogram v3 Balanced — $0.035 *(mask)* | `ideogram/v3-edit` | yes | same with `BALANCED` | $0.035/image |
| Ideogram v3 Quality — $0.05 *(mask)* | `ideogram/v3-edit` | yes | same with `QUALITY` | $0.05/image |
| Seedream 4.5 Basic — TBD | `seedream/4.5-edit` | no | `prompt`, `image_urls`, `aspect_ratio: 16:9`, `quality: basic` | TBD |
| Seedream 4.5 High — TBD | `seedream/4.5-edit` | no | same with `quality: high` (4K) | TBD |
| Seedream v4 — TBD | `bytedance/seedream-v4-edit` | no | `prompt`, `image_urls`, `image_resolution: 2K`, `max_images: 1` | TBD |
| Flux Kontext Pro — TBD | `flux-kontext-pro` *(possibly different endpoint)* | no | `prompt`, `inputImage`, `aspectRatio: 16:9`, `outputFormat: png` | TBD |
| Flux Kontext Max — TBD | `flux-kontext-max` | no | same with `flux-kontext-max` | TBD |
| GPT-4o Low — $0.02 *(mask)* | (already) | yes | (already) | *(already wired)* |
| GPT-4o Medium — $0.07 *(mask)* | (already) | yes | (already) | *(already wired)* |
| GPT-4o High — $0.19 *(mask)* | (already) | yes | (already) | *(already wired)* |

**Flux Kontext caveat:** the docs page sits at `/flux-kontext-api/` not
`/market/`. It may use a different create endpoint than the unified
`/api/v1/jobs/createTask`. Implementation step: verify against the kie.ai
playground or the response shape before assuming `createKieTask` works for it.
If it does not, add a parallel `createFluxKontextTask` helper alongside
`createGpt4oImageTask` in `kie-poll.ts`.

## 6. Implementation phases

### Phase 1 — Backend: extend the edit route
- `route.ts`: expand `ALLOWED_EDIT_MODELS` to include all eight ids.
- Build a per-model input-builder map: `MODEL_BUILDERS[model] → (req) → kieInput`.
- For mask-capable models: validate `mask.url` exists before dispatch.
- For Ideogram: pass `rendering_speed` derived from the picker label.
- For Flux Kontext: verify endpoint, add helper if needed.
- Add an **erase** branch: when `body.intent === 'erase'`, force model to the
  default mask backend (Ideogram v3-edit QUALITY) and substitute a removal
  prompt.

### Phase 2 — Pricing config
- New file `src/lib/image-edit-pricing.ts` exporting a typed catalog:
  `{ id, label, kieModel, kieExtraInputs, maskRequired, pricePerImage|pricePerMP }`.
- Single source of truth consumed by both the API route (for logging) and the
  UI (for the dropdown).
- Pricing marked `null` falls back to "Cost: see kie.ai" in the UI so we
  never invent a number.

### Phase 3 — UI: model picker in EditPanel
- Read pricing config, render dropdown sorted by ascending price.
- Tag mask-capable rows with a small "brush" icon and tooltip.
- Persist last-used selection to `src/lib/editor/settings.ts`
  (`getLastEditModel` / `setLastEditModel`).
- Disable Brush button when current model is prompt-only, with a tooltip
  explaining why and pointing at Ideogram v3 or GPT-4o.

### Phase 4 — UI: Erase action in MaskBrushEditor
- Add an **Erase** button next to **Apply**. Disabled until the user has
  painted at least one stroke.
- Erase calls the same `/api/generate/production-doc/image/edit` with
  `intent: 'erase'`, no user prompt, no model picker (backend fills both).
- Clear visual treatment: button labelled "Erase painted region" with a
  one-line explainer underneath ("removes the marked object and rebuilds the
  background — uses Ideogram v3 Quality, $0.05").

### Phase 5 — Wire into shot editor
- The shot editor's `ShotInspector` already mounts `MaskBrushEditor` and its
  own EditPanel-equivalent. Same model picker component drops in; the API
  contract is shared.

### Phase 6 — QA pass (Rule 6)
- Each model: golden path (a prompt + image returns a sane result), edge
  cases (giant images, tiny images, non-16:9), error paths (kie 401 / 429 /
  500), regression (existing Nano Banana + GPT-4o flows still work).
- Erase: brush a face, paint the whole image, paint a 1px dot, leave canvas
  empty.
- Mobile / desktop both surfaces.
- Refresh during a pending edit should not double-charge.

## 7. Security (Rule 13)

The existing route already does the right things; we keep them.

- **Auth:** `apiRoute.authed` — unchanged.
- **Rate limit:** 20/min/IP — unchanged. New models are not cheaper, so the
  cap stands.
- **SSRF on source URL:** `checkSafePublicUrl` — unchanged.
- **SSRF on mask URL:** add the same guard for mask-capable models that don't
  already have one (Ideogram v3-edit will pass `mask_url` through; same guard
  applies).
- **Prompt length cap:** stays at 2000 chars even though some models claim 5000
  — defensive cap.
- **Erase prompt is server-generated.** The client passes
  `intent: 'erase'`, not the prompt itself, so a tampered client can't sneak
  a wider regen by claiming it's an Erase.
- **API key:** `KIE_API_KEY` — unchanged.
- **No PII / image content in logs.** Log model id, prompt length, intent —
  never the image URL or the prompt text.
- **Cost ceiling:** every edit is at most one paid call. No retries on top
  of paid calls in the route. `pollKieResult` already only retries on
  transient transport errors, not on a billed-but-failed task. Confirm this
  in code review of the new branches.

## 8. Observability (Rule 14)

Per Rule 14, log at every meaningful step. Namespace `[image-edit]`.

- Route entry: `[image-edit request]` with `{ model, hasMask, intent, promptLen }`
- Kie task created: `[image-edit task] taskId, model`
- Kie poll progress: `[image-edit poll] taskId, attempts`
- Kie task complete: `[image-edit done] taskId, durationMs, resultBytes`
- R2 mirror result: `[image-edit mirror] r2Key, ok`
- Saliency result: `[image-edit saliency] ok, durationMs`
- Errors: existing `logger.error` keeps the structured detail; add `model`
  consistently.

Client-side, in EditPanel: `[edit panel apply] model, hasMask, promptLen`.
In MaskBrushEditor: `[brush erase] paintedPixels, model: 'ideogram/v3-edit'`.

Boolean states must log the value, not "happened" — per Rule 14.

## 9. Settings (Rule 15)

Per Rule 15, every new feature gets a settings audit. Decisions:

**To expose:**
- `editor.lastEditModel` (string, persisted) — default to Nano Banana for new
  users. Per-user, not per-project, so the muscle memory follows the user.
- `editor.defaultEraseBackend` (enum: ideogram-quality | gpt-4o-medium) — power
  users who prefer GPT-4o for object removal can switch. Default
  ideogram-quality (cheaper, purpose-built for inpaint).
- `editor.showEditModelPrices` (boolean, default true) — for users who find
  the prices distracting once they've memorized them.

**Not exposed:**
- Per-model rate limits (admin-only concern; not user-facing).
- Polling intervals (no user value).
- Output format per model (we standardise on PNG for editing fidelity).

Settings group: **Editor → Image editing**. New section in the existing
settings layer (`src/lib/editor/settings.ts`). Labels in plain English, no
jargon.

## 10. Cost (Rule 8)

Cheapest verified edit: **Ideogram v3 Turbo, $0.0175/image.**
Most expensive verified edit: **GPT-4o High, $0.19/image** (already wired).

For a video with 30 production-doc image cells, a single round of fixes:

- All on Ideogram Turbo: 30 × $0.0175 = **$0.53**
- All on Ideogram Quality (default Erase backend): 30 × $0.05 = **$1.50**
- All on GPT-4o Medium: 30 × $0.07 = **$2.10**
- All on GPT-4o High: 30 × $0.19 = **$5.70**

For unknown prices (Seedream, Qwen2, Flux Kontext), we hide cost in the
picker until you confirm the dashboard numbers — better than inventing a
figure (Rule 1).

## 11. Open questions

1. **Pricing for the TBD rows.** Can you screenshot the bottom half of your
   kie.ai pricing dashboard with the Seedream, Qwen2, and Flux Kontext rows
   visible? I refuse to ship a "Seedream v4 — $0.04" label if I haven't
   verified it (Rule 1).
2. **Flux Kontext endpoint shape.** Does it go through the unified
   `/api/v1/jobs/createTask` like the others, or its own endpoint? I'll
   verify with a single test call during implementation; flagging now so it
   doesn't surprise us.
3. **Default model for new users.** Nano Banana (current default, cheapest
   prompt-only) or Ideogram Balanced (mid-tier, mask-capable)? I'd recommend
   Nano Banana since most users start with prompt-only edits.
4. **Multi-image Seedream v4.** It supports `max_images: 1–6` — do you ever
   want "give me 4 variations" as a UI affordance, or always 1? Default 1
   keeps cost predictable.

## 12. Rejected alternatives (recap)

- **Option B (per-model routes):** rejected — duplication outweighs the
  per-file clarity at this catalog size.
- **Option C (plugin registry):** rejected — premature abstraction for eight
  models; revisit at 12+.
- **Crop-and-paste brush emulation for prompt-only models:** rejected at the
  scoping step (you picked "Hide brush for prompt-only models"). Risk of
  seams + complexity not worth it.
