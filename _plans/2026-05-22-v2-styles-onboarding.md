# v2 User-defined styles — onboarding + forward work

**Date:** 2026-05-22
**Status:** v2 cloud + local i2i shipped. Polish landed. Open items below.
**Predecessor plan:** [_plans/2026-05-21-user-defined-styles-with-reference-images.md](2026-05-21-user-defined-styles-with-reference-images.md)

A short read for the next session (human or Claude) picking this up.

## What v2 user-defined styles is

A style now carries more than a prompt suffix. It can carry:

- **A plain-English descriptor** — what the look is supposed to be.
- **Up to 8 reference images** — actual examples of the aesthetic.
- **A preferred i2i model** — cloud (Kie) or local (ComfyUI).

When a row in a production doc generates an image and the active style has refs + a preferred i2i model, the dispatcher routes through that model with refs attached. When refs are empty (or the style is a built-in), the legacy text-to-image path runs unchanged.

## How to create a style

1. Open the production-doc page → click **Visual Styles**
2. Click **+ Create new style**
3. Fill in name + descriptor (plain English)
4. Drop 1–8 reference images
5. Pick a model from the dropdown — see [Picking a model](#picking-a-model) below
6. Click **Run test** to preview (cloud: ~$0.05, ~90s; local: free, ~30–90s)
7. **Save style**

## Picking a model

| Model | Refs | Cost | Speed | Notes |
|---|---|---|---|---|
| **NanoBanana Pro** *(cloud default)* | 8 | ~$0.05 | ~90s | Won Phase 0 spike, never refused doodle prompts |
| GPT Image 2 (cloud) | 16 | ~$0.05 | ~170s | Highest ref capacity, slowest |
| Flux 2 Pro (cloud) | 8 | ~$0.05 | ~35s | Fast but biased toward polished aesthetics |
| **Qwen-Image (local single-ref)** | 1 | free | ~60s | Won 2026-05-22 local spike, single anchor via VAE-encode |
| **Qwen-Image-Edit 2509 (local multi-ref)** | 3 | free | ~60–120s | Cross-attention multi-ref, requires `qwen_image_edit_2509_fp8_e4m3fn.safetensors` checkpoint |

Local models require `LOCAL_STUDIO=1` + ComfyUI running on `localhost:8188`. The route returns a clear 503 with a code (`LOCAL_STUDIO_DISABLED` or `COMFYUI_UNREACHABLE`) when local can't run.

## How it flows under the hood

```
production-doc page                            shot-graph editor
  │                                              │
  ├─ stylePreset state ───── doc.style_preset ──┤
  │                                              │
  └──> POST /api/generate/production-doc/image  ─┘
       body: { styleId, prompt, ... }
              │
              ▼
       resolveStyle + loadStyleReferences
              │
              ▼
       generateImageWithRefs (dispatcher)
        │
        ├─ provider=kie       → generateImageWithRefsCloud
        │     (createKieTask + pollKieResult + R2 mirror)
        │
        └─ provider=comfyui-local → generateImageWithRefsLocal
              (upload refs to ComfyUI/input/ +
               workflow swap + result mirror)
```

Provider rejection (Kie refuses a ref for content reasons) → server marks the ref `rejected_by_provider=true`, returns 409 `REFERENCE_REJECTED` with the offending ref ids. Both the production-doc page and the ShotInspector regenerate button surface this as a toast with a one-click "Regenerate" action that excludes the rejected refs.

## Where the code lives

| Concern | File |
|---|---|
| i2i registry (cloud + local) | [src/lib/image-models-i2i.ts](../src/lib/image-models-i2i.ts) |
| i2i dispatcher (provider branch) | [src/lib/image-gen-i2i.ts](../src/lib/image-gen-i2i.ts) |
| Style + refs persistence | [src/lib/production-doc-styles.ts](../src/lib/production-doc-styles.ts) + [src/lib/production-doc-styles-refs.ts](../src/lib/production-doc-styles-refs.ts) |
| Style/refs API | [src/app/api/production-doc/styles/](../src/app/api/production-doc/styles/) |
| Test-render endpoint | [src/app/api/production-doc/styles/[id]/test-render/route.ts](../src/app/api/production-doc/styles/%5Bid%5D/test-render/route.ts) |
| Style editor UI | [src/app/(app)/production-doc/StyleManagerDialog.tsx](../src/app/(app)/production-doc/StyleManagerDialog.tsx) |
| Per-row image route | [src/app/api/generate/production-doc/image/route.ts](../src/app/api/generate/production-doc/image/route.ts) |
| Qwen workflows | [src/lib/comfyui/workflows/qwen-image-i2i.json](../src/lib/comfyui/workflows/qwen-image-i2i.json) + [qwen-image-edit-2509-i2i.json](../src/lib/comfyui/workflows/qwen-image-edit-2509-i2i.json) |
| Schema | migration [0080_extend_production_doc_styles_with_refs.ts](../src/lib/migrations/0080_extend_production_doc_styles_with_refs.ts) |

## Forward work

### 1. R2 orphan sweeper

**Why:** Today, when a style is deleted, refs cascade-delete in DB but R2 cleanup is best-effort fire-and-forget. Same for test-render eviction past the 6-cap. A flaky R2 PUT/DELETE can orphan blobs. They cost pennies but accumulate.

**Sketch:**
- Periodic cron at `scripts/sweep-orphan-style-refs.ts`, scheduled via `vercel.ts` cron entry.
- List R2 objects under `style-refs/`, `style-test-renders/`, `prodoc-images-i2i*/`.
- For each, check if the corresponding row exists in `style_reference_images` / `style_test_renders` / (per-doc media join when wired).
- Delete orphans after a 30-day grace window (last-modified > 30 days + no DB row).
- Log totals; surface counts in admin dashboard.

**Cost / time:** 1 day of focused work. R2 list-objects API is paginated; need to walk multi-MB key sets carefully on large workspaces.

### 2. Cost preview on per-row Generate button

**Why:** Rule 8 — paid actions should preview cost. The dialog's Run test already shows "(~$0.05)". The per-row Generate button on the production-doc page currently doesn't.

**Sketch:**
- Use `formatI2ICostHint(modelValue)` from `image-models-i2i.ts` to get the cost string.
- Resolve `modelValue` from `stylePreset → resolved style → preferred_cloud_model` (or fall back to caller's t2i model).
- Surface either inline next to the Generate button or as a tooltip.

**Cost / time:** ~30 min. Field already exists on the spec; just needs UI wiring.

### 3. Style versioning on generated images

**Why:** `style_test_renders` pins `style_version` but production rows don't. Editing a style mid-doc doesn't trigger re-render or warning. User can end up with a mixed-version video.

**Sketch:**
- Add `style_version int NULL` column to `media_assets` (the per-row image storage).
- Image route writes `style.version` onto the row at generation time.
- Editor surfaces "this scene was generated with v2 of the style; current is v4 — regenerate?" affordance.

**Cost / time:** ~1 day. Schema + 1 column + 2 UI surfaces.

### 4. v2 styles documentation in-app

**Why:** Users discover the style system via the dialog, but the dialog doesn't explain WHY refs matter vs the descriptor, the local vs cloud trade-off, or what "preferred model" means in practice. First-time onboarding is opaque.

**Sketch:**
- Add a small "?" help icon next to each major section in StyleManagerDialog (descriptor, refs, model picker) that pops a tooltip with 2-3 sentences of explanation.
- First-time-only popover when the dialog opens for the first time, summarizing the v2 flow.

**Cost / time:** ~½ day. Pure copy + tooltip wiring.

### 5. Multi-ref provider-rejection bisection

**Why:** When NanoBanana refuses one specific ref, it sometimes returns the index. When it doesn't (or returns a generic refusal), we currently flag ALL refs in the dispatched call. False positives.

**Sketch:**
- On generic refusal, fire 2 follow-up calls in parallel: refs[0..N/2] and refs[N/2..N].
- Whichever side fails contains the offender; recurse.
- Cap at log2(8) = 3 recursion levels (~$0.30 worst-case per ambiguous rejection).

**Cost / time:** ~½ day. Adds real spend so should be opt-in via a setting.

### 6. ShotInspector cost preview parity

The ShotInspector's regenerate button has the same paid-action UX gap as the per-row Generate button on the production-doc page. Same fix shape as #2.

## QA scenarios worth running after any v2 change

1. Create a private style, upload 5 refs, save → style appears in picker as `[Just me] My Style`.
2. Run test render with NanoBanana → result appears in gallery in ~90s with `v1` badge.
3. Edit the style (rename, swap a ref) → version bumps to v2. Old test render still shows v1.
4. Switch to Qwen-Image (local single-ref). Without LOCAL_STUDIO=1: clear 503. With LOCAL_STUDIO=1 + ComfyUI down: clear 503. With both: result in ~60s.
5. Switch to Qwen-Image-Edit 2509 (local 3-ref). Same negative paths. With everything running: result uses up to 3 refs.
6. Generate from production-doc page with style picked → per-row image lands with that style. `doc.style_preset` saved on entry.
7. Open the saved doc in the shot-graph editor → `state.doc.style_preset` resolves. ShotInspector regenerate uses the same style.
8. Open a history entry from production-doc sidebar → `setStylePreset` restores from `entry.doc.style_preset` (v2 entries) or `entry.stylePreset` (legacy).
9. Force a ref rejection (upload a copyrighted character) → both production-doc page and ShotInspector show toast with Regenerate action. Server-side flag is set.
10. Style with all refs rejected → falls back to legacy T2I with clear notice.
