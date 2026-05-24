# Per-shot image model picker (editor Shot Inspector)

**Date:** 2026-05-24
**Status:** Approved, ready to implement
**Owner:** info@flexelent.com

## Goal

Let the user pick the image model on a per-shot basis from the editor's
Shot Inspector, with a project-level default that all shots inherit
until overridden. Today the inspector's Regenerate button is silently
hardcoded to whatever `DEFAULT_IMAGE_MODEL` is in `src/lib/image-models.ts`
(Grok Imagine).

## Constraints / requirements

- Per-shot override stored on the row (must survive reload).
- Project-level default stored on the doc (survives reload).
- No DB migration — the doc is already serialised as JSON in
  `user_history.production_doc`. Adding optional TypeScript fields slots
  into the existing auto-save path.
- Match the precedent set by `broll_model_id` (per-row) +
  `ProductionDoc.broll_model_id` (doc-level). Use the same naming
  convention, the same dropdown shape, the same "Default — XYZ
  (doc setting / workspace setting)" label resolution.
- Local-studio models (`provider === 'comfyui-local'`) gated behind
  `useLocalStudioEnabled()` exactly like the existing pickers.
- API route `/api/generate/production-doc/image` already accepts `model`
  in the body and falls back to `DEFAULT_IMAGE_MODEL` server-side. No
  route changes needed.

## Approach

Mirror the existing `broll_model_id` two-tier pattern 1:1. That keeps the
new code lined up with what's already in the file, satisfies rule 2
(extreme order), and makes the surface obvious to a lazy user (rule 10)
because it lives right next to the Regenerate button it affects.

### 1. Types (no migration)

- `src/remotion/utils.ts:344` — add `image_model?: string` to
  `ProductionRow`, sitting next to `broll_model_id` (~line 525).
- `src/remotion/utils.ts:568` — add `image_model_default?: string` to
  `ProductionDoc`, sitting next to the doc-level `broll_model_id`
  (~line 638).

### 2. Shot Inspector

- New `docImageModelDefault?: string` prop alongside `docBrollModelId`.
- New `ShotImageModelPicker` component at the bottom of the file
  (mirrors `ShotBrollModelPicker`). Reads `IMAGE_MODELS` from
  `@/lib/image-models`, filters local-only models behind
  `useLocalStudioEnabled()`, resolves the "Default — …" label from
  `docImageModelDefault → DEFAULT_IMAGE_MODEL`.
- Place the picker inside the existing "Replace image" section, just
  above the Regenerate button (~line 781). Visual rationale:
  the picker controls what Regenerate does, so they sit together.
- `handleRegenerate` passes `model: row.image_model ?? docImageModelDefault`
  in the fetch body. (Undefined falls through to server-side default.)

### 3. EditorClient

- Add a doc-level Image-model `<select>` next to the existing Animation
  model picker in the doc-defaults panel (`EditorClient.tsx:~3074`).
  Writes via `apply({ type: 'PATCH_DOC', patch: { image_model_default } })`.
- Pass `docImageModelDefault={state.doc.image_model_default}` into
  `<ShotInspector />` (~line 3235).

### 4. Production-doc generation page

When the user generates a new doc with model X selected in the existing
top-of-page Image Model picker, persist X to `doc.image_model_default`
so the editor opens with that choice already populated. This is the
lazy-user win: the model the user picked at gen-time is the one the
editor's per-shot Regenerate will use by default. Find where the
generated doc is produced and stamp the field before save.

### 5. Observability (rule 14)

- `[editor row-image-model] changed { from, to, shotIndex }`
- `[editor doc-settings image-model] changed { from, to }`
- `[editor inspector] regenerate model resolved { rowModel, docDefault, sent }`

### 6. Settings audit (rule 15)

This feature *is* the settings audit — both knobs (per-shot + project
default) are exposed. No additional surfaces.

## Alternatives rejected

- **Workspace-level default** — over-scoped. Users in this codebase
  pick a model per video, not per workspace. The existing prod-doc
  picker is already per-project, so per-workspace would just add a
  third tier nobody asked for.
- **Persist on a new DB column on `user_history`** — pointless: the doc
  is already JSON and the auto-save path covers it.
- **Settings page entry** — over-reach for this task. Adding a setting
  with no obvious surface is worse than the inline picker we already
  have on the prod-doc generation page.

## Security

- The picker writes a `model` string into the row. The API route
  validates the value against `IMAGE_MODELS` and returns 400 on unknown
  values (`route.ts:329-333`), so a tampered request can't smuggle
  arbitrary model ids. Same defense in depth as today.
- Rate limits + workspace scoping unchanged.
- Cost (rule 8): models range $0–$0.05/image; dropdown surfaces the
  same `hint` strings the production-doc page already shows, so the
  user sees cost before clicking Regenerate.

## QA checklist (rule 6)

- Open editor → select blank shot → picker reads "Default — Grok Imagine".
- Change picker to Flux 2 Pro → click Regenerate → fetch body has
  `model: 'flux2-pro-t2i'` → image lands → reload → picker still on
  Flux 2 Pro.
- Change doc-level default → all rows without their own override read
  "Default — Flux 2 Pro (doc setting)".
- Local model gated when LOCAL_STUDIO unset.
- Generate a fresh doc with Ideogram v3 Quality picked → open in
  editor → doc default reads Ideogram v3 Quality.
- Type check passes.
