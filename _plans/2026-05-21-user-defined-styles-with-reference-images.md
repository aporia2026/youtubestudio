# User-defined image styles with reference images

**Date:** 2026-05-21
**Status:** ✅ Council-passed (v2) · ✅ Phase 0 cloud spike done (see "Phase 0 result" below) · ⏳ Local spike pending · ⏳ Phase 3+ pending
**Owner:** Yoav
**Files touched:** `src/lib/migrations/0080_extend_production_doc_styles_with_refs.ts` (new), `src/lib/production-doc-styles.ts`, `src/lib/production-doc-styles-refs.ts` (new), `src/lib/image-models.ts`, `src/lib/auto-pipeline/image-gen.ts`, `src/app/api/production-doc/styles/route.ts`, `src/app/api/production-doc/styles/[id]/route.ts`, `src/app/api/production-doc/styles/[id]/refs/route.ts` (new), `src/app/api/production-doc/styles/[id]/refs/[refId]/route.ts` (new), `src/app/api/production-doc/styles/[id]/test-render/route.ts` (new), `src/components/production-doc/StyleEditor.tsx` (new), `src/app/(app)/production-doc/styles/new/page.tsx` (new), `src/app/(app)/production-doc/styles/[id]/edit/page.tsx` (new)

## The ask

Let the user create their own image styles by writing a descriptor + uploading 5–8 reference images, and have every subsequent image generation under that style pass the descriptor AND the refs to the chosen provider — Kie.ai (cloud) or ComfyUI (local). Goal: consistent style lock-in across an entire video without training a model. Driver: the doodle/stick-figure explainer aesthetic the user pasted; the existing `doodle_explainer` built-in approximates it with prompt suffix only and drifts scene-to-scene.

## Why this works

Reference-image conditioning carries aesthetic — line weight, palette, character proportions, background convention — far better than prompt words alone. Cloud providers and our local stack both support multi-reference inputs natively, so the architectural lift is small relative to the consistency win. The piece refs alone can't solve is character identity across many scenes; that's a future LoRA escape hatch outside this v1.

## What the council changed (v2 deltas from v1)

The plan was pressure-tested by a 5-advisor LLM Council on 2026-05-21. Findings that changed the plan:

1. **Schema contradiction fixed (Contrarian).** v1 had Phase 5 gating Save on an `approved_at` column that didn't exist, and refs FK-ing to a `style_id` that didn't exist until Save. v2 adds `draft boolean` and `approved_at timestamptz` to `production_doc_styles`; row is created on first ref upload as `draft=true`; `listAllStyles` filters `draft=false`; Save flips draft and stamps `approved_at`.
2. **Data leak closed (Contrarian).** `ON DELETE SET NULL` on `channel_id` (v1) silently promoted private channel-scoped styles to workspace-wide. v2 uses `ON DELETE CASCADE`. (Also: v2 drops `channel_id` from the v1 release per Executor — single-user scope only for now.)
3. **Scope trimmed (Executor).** v1 had three scope tiers (private / channel / workspace). v2 ships only **private to creator** (`owner_id NOT NULL`). Workspace-wide and channel-shared can land in v2 when there's a second user.
4. **Role tags and weight sliders deferred (Outsider + Executor).** v1 forced users to tag every ref with `style/character/palette/composition` and tune a 0–1 weight slider. Reality: a first-timer has no idea what weight 0.6 means. v2 ships all refs as `role='style'`, `weight=1.0` invisibly. The columns stay in schema (forward-compatible) but the UI hides them.
5. **Forced test-render gate removed (Outsider + Executor + Contrarian).** v1 disabled Save until an approved test render existed. The gate enforced *a render happened*, not *the style is good*, and silently turned style creation into a paid action. v2: test-render is a free-to-call button (showing cost on the button), Save is always available, no `approved_at`-gates-Save logic. Plan keeps `approved_at` as a soft signal (date the user last clicked "this is good") for future surfacing, not a hard gate.
6. **Style versioning added (Reviewer 5).** v1 had no semantics for "what happens when a style is edited mid-video." v2 adds a `version int` that bumps on every edit; test renders and (later) generated images pin to the version they ran against. v1 doesn't yet rewrite generated images on version bump — it just stops lying about which version produced what.
7. **Blind-rank spike added as Phase 0 (First Principles).** v1 picked Flux 2 Pro i2i as default cloud model on paper, no testing. v2 inserts a 1-day spike: 5 refs × 10 prompts × all 4 cloud + 2 local workflows = grid, user blind-ranks, winner becomes default.
8. **Model dropdown reframed (Outsider).** v1 exposed "Flux 2 Pro i2i / GPT Image 2 i2i / NanoBanana Pro / Ideogram Remix" by name. v2 labels models in plain English keyed to the doodle aesthetic ("Doodle (Flux 2 Pro)", "Photoreal Mix (NanoBanana)", etc.) with a one-line hint each. The picker has an opinion, not a buffet.
9. **Scope language plain-English (Outsider).** "Private to me", not "owner_id".
10. **Cost preview baked into every render action (Outsider + Reviewer 4).** Every button that spends money — test render, regenerate — shows the cost inline. Rule 8.
11. **Presigned URL TTL pinned (Contrarian + Executor).** R2 GET URLs for refs sent to Kie.ai are minted at *dispatch*, not at style-load, with TTL ≥ 900s. v1 was silent on this; v2 specifies it.
12. **Provider-rejection UX added (user request, post-council).** When Kie.ai or Replicate refuses to use a ref (copyrighted character detection, NSFW filter, etc.), the system identifies the offending ref, marks it visibly in the UI as "rejected by provider", and offers a one-click regenerate-without-this-ref. Operational, not legal — saves the user a debugging day per month.
13. **Rights-attestation UI dropped (user decision).** Per the user, the use case is YouTube fair-use commentary/explainer content; full rights-attestation UI + takedown path skipped. **Operational pieces kept**: per-ref upload audit log; provider-rejection surfacing (see #12).
14. **LoRA escape hatch removed from v1 entirely (Executor).** Future work, not this plan.
15. **Local ComfyUI path NOT fully deferred — surfaced as next-step (2026-05-21 user pushback).** The initial v2 plan deferred local Flux Redux / IP-Adapter to v3 "after cloud stabilises." User correctly pointed out the local path is free per-image and the spike should run there too before committing to cloud as the canonical default. Revised architecture: **hybrid** — local (free) when `LOCAL_STUDIO=1` + ComfyUI running, cloud (NanoBanana Pro, ~$0.05/image) as the always-available fallback. A local spike covering the same 10 doodle prompts is queued immediately after the cloud spike's winner is wired in. See "Phase 0 result" + "Local spike (next)" below.
16. **Drift detector, channel-as-brand-kit, regression grid (Expansionist) all deferred.** Good ideas; v2+ territory after v1 ships.

## Phase 0 result (cloud spike) — 2026-05-21

Ran [scripts/style-spike.ts](../scripts/style-spike.ts) on the 5 curated doodle refs × 10 scene prompts × 3 working cloud models. Outputs at [_plans/2026-05-21-phase-0-spike-results/grid.html](2026-05-21-phase-0-spike-results/grid.html). Total spend: ~$2.75.

| Model | Cells succeeded | Avg time/image | Visual rank (blind) | Notes |
|---|---|---|---|---|
| **NanoBanana Pro** (winner) | **10/10** | **~90s** | Tied for top | 8 refs max. Never refused. Stripped-payload only — `output_format` / `resolution` 500 the endpoint despite being in the docs. |
| GPT Image 2 i2i | 10/10 | ~170s | Tied for top | 16 refs max. Visually indistinguishable from NanoBanana on the 10 prompts. Slower by ~2×. |
| Flux 2 Pro i2i | 9/10 | ~35s | Last | Fastest by far but visually weakest — prior toward photoreal/polished hurts the doodle aesthetic. Also refused p06 (cyber/sabotage) even after neutral rephrase. Surprise loser. |
| ~~Ideogram v3 Remix~~ | 0/10 | — | dropped | Returned taskId fine but polling failed `internal error` on every minimal-payload call. Kie-side outage. Single-ref only anyway. |

**Verdict:** NanoBanana Pro wins on speed (tiebreaker after visual tie with GPT Image 2). Wired as `DEFAULT_CLOUD_I2I_MODEL` in [src/lib/image-models.ts](../src/lib/image-models.ts) — see `IMAGE_MODELS` entries `nano-banana-pro-i2i` / `gpt-image-2-i2i` / `flux2-pro-i2i`. All three exposed in the picker via `I2I_MODEL_VALUES` (derived from `IMAGE_MODELS` so the styles validator stays in sync).

**Adjustment to the plan based on the spike:** the v2 plan above had Flux 2 Pro as the assumed default — that was paper-only reasoning and the spike falsified it. The council recommendation to spike before committing paid for itself.

## Local spike (next) — Flux Redux + IP-Adapter

The cloud spike picked the best CLOUD option. But local Flux Redux + IP-Adapter is `$0` per image when `LOCAL_STUDIO=1` and ComfyUI is running. We owe the same 10-prompt test to local before declaring NanoBanana Pro the "preferred" path.

Plan:
1. Download Flux Redux weights (~3–5 GB) + IP-Adapter weights (~2 GB) to the existing ComfyUI install
2. Build a local equivalent of `style-spike.ts` that hits `localhost:8188` instead of Kie
3. Run the same 5 refs × 10 prompts through:
   - Flux Redux (single style anchor, position 0 only)
   - IP-Adapter (multi-ref with all 5)
4. Compare against NanoBanana Pro outputs cell-by-cell
5. Decision tree:
   - Local quality ≥ NanoBanana → local becomes preferred when available, NanoBanana stays as fallback for deployed app
   - Local quality < NanoBanana → cloud-only system; local stays a v3 problem

Cost: $0. Time: depends on hardware — likely 15–30 min for 20 cells on the user's RTX 5070 Ti.

## Goals (v1)

1. User UI to create / edit / delete a private style with: name, prompt descriptor, 5–8 reference images, preferred cloud model.
2. Reference images stored on R2 (existing `images` bucket).
3. Generation path routes a style's preferred cloud i2i endpoint with refs in the right field.
4. Test-render button (free to call but shows cost) — runs the configured model with the current refs, output appended to a small gallery.
5. Provider-rejection awareness: when a ref is refused, mark it in the UI and offer regenerate-without-it.
6. Coexist with all existing built-in styles unchanged.

## Non-goals (v1)

- No local ComfyUI generation (deferred to v3).
- No LoRA training (deferred entirely).
- No channel-shared or workspace-wide scopes (deferred to v2 — only `owner_id` private).
- No role tags or weight sliders in the UI (schema reserves them; UI hides them).
- No drift detector / regression suite / channel brand kit.
- No rights-attestation UI / takedown flow.
- No image-to-video reference conditioning (that's the May 20 plan).

## Constraints

- Cloud path must work in the deployed Vercel app.
- Refs upload via the existing presigned-R2 pattern.
- Per rule 13: validate every uploaded ref (MIME, size, dimensions). Reject SVG (XSS) and HEIC (libvips landmines). Audit-log every upload.
- Per rule 14: every style operation logs values.
- Per rule 15: settings audit before "done".
- Per rule 16: editor UI obvious to a lazy user.

## Verified provider matrix (Kie.ai cloud)

Fetched live from docs.kie.ai on 2026-05-21:

| Model spec value | Kie model string | Refs field | Max refs | Notes |
|---|---|---|---|---|
| **`flux2-pro-i2i`** (new) | `flux-2/pro-image-to-image` | `input_urls` | **8** | 10MB/file, JPEG/PNG/WebP. 1K/2K. Default after spike. |
| **`gpt-image-2-i2i`** (new) | `gpt-image-2-image-to-image` | `input_urls` | **16** | Highest ref capacity. |
| **`nano-banana-pro-i2i`** (new) | `nano-banana-pro` | `image_input` | **8** | 30MB/file. Widest aspect ratios incl 21:9. |
| **`ideogram-v3-remix`** (new) | `ideogram/v3-remix` | `image_url` (single) | **1** | Single-ref only; reserve for typography-heavy styles. |
| Grok Imagine | n/a | — | — | No ref support; drops out. |

Final picker default = spike winner (Phase 0).

## Architecture

### Schema (migration 0080)

```sql
ALTER TABLE production_doc_styles
  ADD COLUMN owner_id uuid NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  ADD COLUMN draft boolean NOT NULL DEFAULT false,        -- true while editor open
  ADD COLUMN approved_at timestamptz NULL,                -- soft signal, not a gate
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN style_prompt text NULL,                      -- plain-English descriptor
  ADD COLUMN preferred_cloud_model text NULL;             -- e.g. 'flux2-pro-i2i'
-- Existing styles backfill: owner_id NULL (workspace-wide), draft=false, version=1.

CREATE TABLE style_reference_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id uuid NOT NULL REFERENCES production_doc_styles(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  position smallint NOT NULL,                              -- 0..7
  role text NOT NULL DEFAULT 'style'                       -- v1 always 'style'
    CHECK (role IN ('style','character','palette','composition')),
  weight real NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  r2_bucket text NOT NULL,
  r2_key text NOT NULL,
  size_bytes integer NULL,
  mime_type text NOT NULL,
  width integer NULL,
  height integer NULL,
  -- Provider-rejection tracking
  rejected_by_provider boolean NOT NULL DEFAULT false,
  rejection_reason text NULL,                              -- raw error from provider
  rejection_provider text NULL,                            -- 'kie:flux-2-pro' etc
  rejected_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_style_reference_images_style ON style_reference_images(style_id, position);

CREATE TABLE style_test_renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id uuid NOT NULL REFERENCES production_doc_styles(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  style_version integer NOT NULL,                          -- which version of the style produced this
  test_prompt text NOT NULL,
  output_url text NOT NULL,
  r2_key text NULL,
  model_used text NOT NULL,
  duration_ms integer NOT NULL,
  cost_usd numeric(10,4) NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_style_test_renders_style ON style_test_renders(style_id, created_at DESC);
```

**Visibility rule for v1** (`listAllStyles`):
```sql
SELECT * FROM production_doc_styles
WHERE workspace_id = :ws
  AND draft = false
  AND (owner_id IS NULL OR owner_id = :uid)   -- workspace-wide OR mine
```

**Edit semantics:** any UPDATE to `style_prompt`, `preferred_cloud_model`, or ref membership bumps `version = version + 1`. Test renders pin to `style_version` at submit time. (v2 will pin generated images too.)

### Provider-rejection UX (post-council addition)

When Kie.ai returns a rejection response for a generation that used a style with refs:

1. **Classify the failure** — extend the existing `GenerateImageAttempt.failureClass` enum to add `content_refusal_input_image` (distinct from `content_refusal` which is prompt-level).
2. **Identify the offending ref** — Kie.ai NanoBanana Pro returns the index of the rejected `image_input`; GPT Image 2 returns generic refusal. When the index is known, mark that specific ref in `style_reference_images` as `rejected_by_provider=true`. When the index is unknown, mark all refs in that call with a "possibly rejected" softer flag (in v1, just log; v2 can bisect).
3. **Surface in UI** — refs in the style editor that have `rejected_by_provider=true` render with a red border, an icon, and the rejection reason on hover. The generation result page shows a "One or more reference images were rejected by the provider" banner with a "Regenerate without rejected refs" button.
4. **Regenerate path** — the button submits the same prompt with `excluded_ref_ids = [...rejected ids]`. The dispatcher loads refs from `style_reference_images` but excludes any whose id is in the exclude list. If all refs are excluded, fall back to T2I (with a clear notice — not silent per Contrarian's #3).
5. **Recovery** — user can manually clear the rejected flag in the editor ("I think this was a false positive, try again") which resets `rejected_by_provider=false` and re-enables the ref on next generation.

### Generation dispatch

`src/lib/auto-pipeline/image-gen.ts` and `src/app/api/generate/production-doc/image/route.ts` both pick up the same code path:

```ts
const style = await resolveStyle(styleId, ws);
const refs = await loadStyleReferences(style.id, { excludeRejected: true, excludeIds: opts.excludeRefIds });

if (refs.length > 0 && style.preferred_cloud_model) {
  // Mint presigned R2 GET URLs for each ref AT DISPATCH, TTL 1h.
  const refUrls = await Promise.all(refs.map(r => getImagesDownloadUrl(r.r2_key, { ttlSeconds: 3600 })));
  return generateViaKieI2I(style, refUrls, prompt, opts);
}
// No refs / no cloud model → existing T2I path.
return generateViaKieT2I(style, prompt, opts);
```

Per-spec request shapes:
- `flux2-pro-i2i` → `{ prompt, input_urls: refUrls, aspect_ratio: '16:9', resolution: '1K' }`
- `gpt-image-2-i2i` → same shape
- `nano-banana-pro-i2i` → `{ prompt, image_input: refUrls, aspect_ratio: '16:9', resolution: '1K' }`
- `ideogram-v3-remix` → `{ prompt, image_url: refUrls[0], strength: 0.7 }` (single)

### Reference storage

Existing `images` R2 bucket. Key: `style-refs/{workspace_id}/{style_id}/{position}-{timestamp}-{filename}`. Upload via presigned PUT. On style delete, `ON DELETE CASCADE` removes DB rows; a background job (or end-of-request hook) deletes the R2 objects to avoid orphans.

## Phased implementation

### Phase 0 — Blind-rank spike (1 day, runs in parallel with Phase 1)

User-driven. Goal: pick the v1 default cloud model based on the user's actual doodle aesthetic, not on paper.

1. User supplies 5 reference doodle images (the ones from this thread).
2. User supplies 10 representative scene prompts (any source — past doodle videos or new).
3. We run each ref-set × prompt combo through:
   - `flux2-pro-i2i` (Kie)
   - `gpt-image-2-i2i` (Kie)
   - `nano-banana-pro-i2i` (Kie)
   - `ideogram-v3-remix` (Kie, single-ref so use first ref)
4. Render the 4×10 grid on a simple admin page.
5. User blind-ranks (model labels hidden during ranking).
6. Winner becomes `default_cloud_model` for the new built-in `doodle_explainer_v2` style and the editor's default selection.

**Cost estimate**: 4 models × 10 prompts ≈ 40 generations. At avg ~$0.05/image, ~$2 total spend. Real numbers verified live before submit.

### Phase 1 — Schema + types + style core (~½ day)

1. Migration `0080_extend_production_doc_styles_with_refs.ts` (DDL above).
2. Update `src/lib/production-doc-styles.ts`:
   - `SavedStyleRow` gains the new columns
   - `ResolvedStyle` gains `references: StyleReferenceImage[]`, `style_prompt`, `preferred_cloud_model`, `version`, `approved_at`
   - `listAllStyles` filter changes to include `draft=false` AND ownership
   - New `bumpStyleVersion(styleId, tx?)` helper called by any edit path
3. New module `src/lib/production-doc-styles-refs.ts`:
   - `loadStyleReferences(styleId, opts: { excludeRejected?, excludeIds? })`
   - `addStyleReference(styleId, file)`
   - `deleteStyleReference(refId)`
   - `markReferenceRejected(refId, reason, provider)`
   - `clearReferenceRejection(refId)`
4. **Smoke**: insert via psql, list via helper, mark rejected, list with `excludeRejected: true` skips it.

### Phase 2 — Refs API + draft style lifecycle (~½ day)

1. `POST /api/production-doc/styles` — creates a `draft=true` row immediately (returns `{ id }`). UI uses this id for ref uploads before Save.
2. `POST /api/production-doc/styles/[id]/refs` — presigns R2 PUT, creates `style_reference_images` row. Hard cap 8 refs. 25MB / image. Validates MIME (JPEG/PNG/WebP only, no SVG/HEIC).
3. `GET /api/production-doc/styles/[id]/refs` — list with refreshed presigned download URLs.
4. `DELETE /api/production-doc/styles/[id]/refs/[refId]` — delete R2 object + DB row.
5. `PATCH /api/production-doc/styles/[id]/refs/[refId]` — update position (drag-reorder). v1 doesn't expose role/weight in UI but the endpoint accepts them for forward-compat.
6. `PATCH /api/production-doc/styles/[id]` — update name/style_prompt/preferred_cloud_model. **Bumps version on any mutating field**. Flips `draft=false` and stamps `approved_at` if request includes `{ save: true }`.
7. `DELETE /api/production-doc/styles/[id]` — cascade deletes refs + test renders (DB) + R2 objects (best-effort cleanup hook).
8. Observability: `[style draft create]`, `[style refs upload]`, `[style refs delete]`, `[style refs rejection mark]`, `[style save]`, `[style version bump]` with values.

**Smoke**: full create→upload 5 refs→save→re-edit→version bumps to 2 cycle via curl.

### Phase 3 — Style editor UI (~1 day)

New routes `/production-doc/styles/new` and `/production-doc/styles/[id]/edit`. Component `StyleEditor.tsx`.

```
+----------------------------------------------------------+
| ← Back     [ Style name: "Stick figure explainer"     ]  |
+----------------------------------------------------------+
| Visible to:  (•) Just me                                  |
|              ( ) [v2 — disabled in v1: My team]           |
+----------------------------------------------------------+
| Describe the style                                        |
|  [ Hand-drawn stick figure doodle, thick black ink     ]  |
|  [ outline, pure white background, one or two flat     ]  |
|  [ accent colors per scene, no shading, no gradients   ]  |
+----------------------------------------------------------+
| Reference images  (5 / 8)                                 |
|                                                           |
|  +-------+ +-------+ +-------+ +-------+                  |
|  | img 1 | | img 2 | | img 3 | | img 4 |  + add ref       |
|  +-------+ +-------+ +-------+ +-------+                  |
|                                                           |
|  • Drag to reorder. First image carries the most weight.  |
|  • Rejected refs show a red border + reason on hover.     |
+----------------------------------------------------------+
| Model                                                     |
|  Doodle (Flux 2 Pro)   ▼                                  |
|  Best for hand-drawn stick figures. ~$0.05/image.         |
+----------------------------------------------------------+
| Test render                                               |
|  Prompt: [ Two stick figures whispering near a phone  ]   |
|  [ Run test (~$0.05) ]                                    |
|                                                           |
|  History:  [thumb] [thumb] [thumb]                        |
+----------------------------------------------------------+
|                            [ Cancel ]   [ Save style ]    |
+----------------------------------------------------------+
```

Implementation notes:
- Save always enabled (no test-render gate).
- Rejected refs render with a red ring + "Rejected by provider: <reason>" on hover + a "Clear rejection" menu item.
- Drag-and-drop reorder using existing upload helpers.
- Model dropdown shows plain-English labels keyed to use case, not provider name. One default highlighted as recommended.
- Cost on the Run button is inline (`~$0.05` — read from `image-models.ts` cost field, added in this phase).
- Style list page `/production-doc/styles` shows: built-ins first, then "My styles" (private). v1 has no team / workspace section.

### Phase 4 — Cloud i2i generation path + provider-rejection plumbing (~1 day)

1. Extend `image-models.ts` with i2i specs:
   - `flux2-pro-i2i`, `gpt-image-2-i2i`, `nano-banana-pro-i2i`, `ideogram-v3-remix`
   - Each gets `kieModel`, `refsField` (`input_urls` | `image_input` | `image_url`), `maxRefs`, `costPerImageUsd`
2. Extend `buildKieImageInput` (or split into `buildKieT2IInput` + `buildKieI2IInput`) to assemble the right field shape per model.
3. `image-gen.ts`:
   - `generateImageWithFallback` accepts an optional `refs: StyleRefInput[]` param.
   - When refs present and the active model supports them, route to i2i.
   - Mint presigned R2 GET URLs **at dispatch**, TTL 3600s.
   - On `content_refusal_input_image` failure class (new), parse provider error to identify offending ref index where available; call `markReferenceRejected`. Throw a custom `ReferenceRejectedError` with `rejectedRefIds[]` so the route can surface it.
4. `src/app/api/generate/production-doc/image/route.ts`:
   - Load active style, resolve refs (with `excludeRejected: true`).
   - Pass refs to `generateImageWithFallback`.
   - On `ReferenceRejectedError`, return 409 with `{ rejectedRefIds, suggestRegenerate: true }`.
5. **Per-style preferred model**: dispatch reads `style.preferred_cloud_model`; falls back to user/workspace default if unset.
6. Per-row "Use kie.ai with refs" button on production-doc UI inherits style refs automatically.
7. Observability: `[image-gen kie-i2i submit]`, `[image-gen kie-i2i complete]`, `[image-gen ref-rejected]` with `{ ref_id, provider, reason }`.

### Phase 5 — Test render endpoint + small gallery (~½ day)

1. `POST /api/production-doc/styles/[id]/test-render` body `{ test_prompt }`. Uses current refs (with `excludeRejected: true`). Persists to `style_test_renders` with `style_version`.
2. Returns `{ render: { id, url, model_used, duration_ms, cost_usd, rejectedRefIds? } }`.
3. UI appends to a thumbnail strip in the editor. No "approve" button in v1 — the user just sees the result; the editor saves regardless.
4. Cap retained renders at 6 per style (oldest evicted from R2 + DB on overflow).
5. **Regenerate from a rejected result**: if `rejectedRefIds` non-empty, the result thumbnail shows a "Regenerate without [n] rejected" button — single-click resubmit excluding those refs.

### Phase 6 — Production-doc integration polish (~½ day)

1. Style picker on the production-doc page now lists "My styles" alongside built-ins.
2. Per-row generate-image button respects the active style's `preferred_cloud_model` + refs.
3. Per-row regenerate menu gains "Regenerate without rejected refs" when applicable.
4. Cost gauge in doc header sums per-row generation cost; ref-bearing rows cost the i2i price not the T2I price.

**Smoke (end-to-end)**: create a new doodle style, upload 5 refs, save, attach to a doc, generate 3 rows → outputs respect the refs across all three rows.

## Settings audit (rule 15)

**Per-user defaults** (in `collaborators.encrypted_settings`):
- `imageGen.default_style_id` — fallback when nothing picked
- `imageGen.cloud_i2i_model` — default = Phase 0 spike winner
- `imageGen.refs_when_available` — boolean, default ON

**Per-style** (editor):
- Name, descriptor, scope (v1 only "Just me"), preferred cloud model
- Implicit: `version`, `approved_at` not shown in UI but exposed in style detail JSON for power users

**Per-doc** (production-doc UI):
- Active style picker (existing, extended to include user-saved styles)

**Per-row** (right-click):
- "Regenerate without rejected refs" — only when applicable
- "Use a different style for this row" — existing

## Security (rule 13)

- **Upload validation**: MIME ∈ {jpeg, png, webp}, ≤25MB, ≤4096px either side. Reject SVG (XSS) and HEIC.
- **R2 keys**: prefixed by `style-refs/{workspace_id}/{style_id}/` — workspace ownership baked into the path.
- **Kie.ai URL passthrough**: refs sent to Kie are R2 presigned GET URLs we just minted at dispatch, never user-provided URLs. No SSRF surface.
- **Owner-private guard**: `owner_id IS NULL OR owner_id = current_user`. Tested explicitly in QA.
- **Style ownership on every mutation**: PATCH/DELETE endpoints check `owner_id = current_user` or admin role. 403 otherwise.
- **Logging**: log `r2_key`, never full presigned URLs (short-lived but still sensitive). Audit log every upload + delete.
- **Per-ref provenance**: the `style_reference_images` row has `created_at` + workspace_id + style_id + the position. Sufficient to trace which ref came from where for any debugging or future takedown (skipped UI-wise per user decision; operational record persists).

## Observability (rule 14)

Namespaces with concrete values:
- `[style draft create]` — `{ style_id, workspace_id, owner_id }`
- `[style refs upload]` — `{ style_id, ref_id, position, mime, size_bytes }`
- `[style refs delete]` — `{ style_id, ref_id }`
- `[style refs rejection mark]` — `{ style_id, ref_id, provider, reason_slice }`
- `[style refs rejection clear]` — `{ style_id, ref_id }`
- `[style save]` — `{ style_id, version_after, ref_count, model }`
- `[style version bump]` — `{ style_id, version_before, version_after, fields }`
- `[style test-render submit]` — `{ style_id, version, model, ref_count, prompt_slice }`
- `[style test-render complete]` — `{ style_id, duration_ms, cost_usd, output_r2_key }`
- `[style test-render rejected-refs]` — `{ style_id, ref_ids, provider }`
- `[image-gen kie-i2i submit]` — `{ style_id?, version?, model, ref_count, prompt_slice }`
- `[image-gen kie-i2i complete]` — `{ duration_ms, cost_usd, kie_task_id }`
- `[image-gen ref-rejected]` — `{ ref_id, provider, reason_slice, regenerate_offered }`

Per rule 14: every line carries values, not just events.

## Cost (rule 8)

| Step | Cost | Notes |
|---|---|---|
| R2 storage for refs | ~$0.015/GB/mo, $0 egress | 8 refs × ~2MB × 100 styles ≈ 1.6 GB ≈ $0.025/mo per workspace |
| R2 PUT/GET ops | $4.50/M Class A, $0.36/M Class B | Negligible |
| Cloud i2i generation | Verified per model from docs.kie.ai. Surfaced in UI on every Run button. | Phase 0 spike confirms which model wins on cost per acceptable result |
| Phase 0 spike | ~$2 (40 generations) | One-time |

**Cost preview discipline**: every button that spends money displays the cost inline before click. Test render, regenerate, doc-wide regenerate — all show `~$X.XX` from `image-models.ts`. Run-rate visibility is a v1 hard requirement.

## QA plan (rule 6)

**Phase 1 (schema + types):**
- Migration up + down cleanly. Existing rows backfilled correctly (`draft=false`, `version=1`).
- `loadStyleReferences` with `excludeRejected: true` skips rejected refs.

**Phase 2 (refs API + draft lifecycle):**
- Create draft → upload 8 refs → list returns 8 ordered by position. Upload 9th rejected (cap).
- Upload SVG rejected. Upload HEIC rejected.
- Edit name → version bumps to 2.
- PATCH `{save: true}` → `draft=false`, `approved_at` stamped.
- DELETE style → refs + test renders cascade-delete; R2 objects cleaned up best-effort.
- Cross-user access: user B cannot fetch / delete user A's private style. 403.

**Phase 3 (editor UI):**
- Create + save flow uninterrupted (no test-render gate).
- Rejected ref renders with red ring + reason tooltip. "Clear rejection" menu item resets the flag.
- Model dropdown shows plain-English labels with cost inline.
- Cost on Run button matches `image-models.ts` value.

**Phase 4 (cloud i2i):**
- Generate row with style attached → request to Kie contains correct refs field; response respects refs.
- Style with refs + Grok Imagine selected → server rejects model selection at save (hard fail, not silent fallback).
- Style with all refs rejected → graceful T2I fallback with explicit user notice.
- Provider returns `content_refusal_input_image` → offending ref marked, error surfaced with regenerate offer.

**Phase 5 (test render):**
- Run, succeed, gallery thumb added.
- Run 7 → oldest evicted.
- Run with a rejected ref present → it's automatically excluded, banner explains.

**Phase 6 (production-doc integration):**
- Per-row generation honours style + refs.
- "Regenerate without rejected refs" works end-to-end.
- Cost gauge sums correctly across mixed t2i + i2i rows.

**Regressions:**
- Existing built-in styles still resolve.
- Existing T2I-only flow unchanged for any style without refs.
- Existing production-doc UI unaffected by an absent active style.

## Open questions

1. **Rejected-ref bisection** — when a provider doesn't return the offending ref index (GPT Image 2 returns generic refusal), v1 just logs "one of these was rejected" without bisecting. v2 could submit the same prompt with halves of the ref set to bisect — cost+latency trade. Defer.
2. **Style version pinning on generated images** — v1 records `style_version` on test renders but not yet on the production `media_assets` rows. v2 adds it so a doc generated against version 2 can be re-rendered if the style updates to version 3.
3. **Workspace-wide and channel-shared scope** — added in v2 once there's a second user.
4. **Multi-role refs (character / palette / composition)** — schema reserves these; UI exposes only `style` in v1. Phase 6+ adds the role pills when consistency complaints suggest they're needed.

## Alternatives rejected

- (Carried over from v1): single-ref-per-style, save-time LoRA training, base64 storage, Ideogram as default — all rejected for the same reasons.
- (v2-specific): the three-way scope model was rejected by Executor's "no second user yet" — kept the schema columns nullable but UI v1 ships private-only.
- (v2-specific): the forced test-render gate was rejected by three independent advisors as theatre that turns a free action paid.

## TL;DR

- Add 6 columns to `production_doc_styles` (`owner_id`, `draft`, `approved_at`, `version`, `style_prompt`, `preferred_cloud_model`) + 2 new tables (`style_reference_images`, `style_test_renders`) — migration 0080.
- One Style Editor page; uploads via existing R2 presigned-PUT pattern; 5–8 refs hard cap.
- 4 new Kie i2i specs in `image-models.ts`; default chosen by a Phase 0 blind-rank spike.
- Refs marked `rejected_by_provider` get a red UI ring; one-click regenerate-without-rejected on every offending render.
- No LoRA, no local ComfyUI, no team/workspace scopes, no role/weight UI in v1.
- Cost preview on every paid button. R2 presigned URLs minted at dispatch with TTL 3600s. Style version bumps on every edit.

## Sources

- [Kie.ai Flux 2 Pro Image-to-Image](https://docs.kie.ai/market/flux2/pro-image-to-image)
- [Kie.ai GPT Image 2 Image-to-Image](https://docs.kie.ai/market/gpt/gpt-image-2-image-to-image)
- [Kie.ai NanoBanana Pro](https://docs.kie.ai/market/google/pro-image-to-image)
- [Kie.ai Ideogram V3 Remix](https://docs.kie.ai/31159050e0)
- [Replicate fast-flux-trainer](https://replicate.com/replicate/fast-flux-trainer/train) (future LoRA, not v1)
- [May 20 cross-style consistency plan](2026-05-20-cross-style-consistency-and-i2v-text-protection.md)
- [May 20 ComfyUI local b-roll plan](2026-05-20-comfyui-local-broll.md) (future local i2i, not v1)
