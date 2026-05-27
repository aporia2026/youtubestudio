# Pipeline script-style preset + ScriptGate dead-end fix

**Date**: 2026-05-27
**Branch**: `claude/video-creation-ui-pqXzS`

## Goals

Two related fixes at the auto-pipeline's script-generation step:

1. **Script style preset on pipeline presets.** Today the auto-pipeline's
   `generate_script` stage ignores style presets — it only reads
   `script_rules_jsonb` (tone/style/audience strings). The standalone
   Script Generator at `/generator` already supports picking a style
   preset (resolved via `resolveStyle`) and injecting it into the prompt
   as a STYLE PRESET block. We want the pipeline to use the same
   mechanism so batched scripts match the style preset the user picked.
2. **ScriptGate dead-end on empty `script_content`.** When the script
   gate fires but the underlying `scripts.content` row is null/empty
   (e.g., from a stream error that pre-dates the `187fe51` fix), the
   gate component returns a static "Script not loaded." with no
   Regenerate / Kill buttons. The user can't escape without going to
   the database. Both buttons should remain reachable.

## Constraints

- No new tables. Reuse `production_doc_styles` — already exists, already
  resolves via `resolveStyle` for built-ins + workspace-saved rows.
- One small migration: add a nullable FK column on `pipeline_presets`.
  Migrations run automatically on `vercel-build` per AGENTS.md.
- No new paid-API calls. Style preset injection is a prompt-building
  change; token cost on the script-gen call goes up by the bytes the
  STYLE PRESET block adds (tens of tokens, not hundreds).
- Workspace-scoped at every read. `resolveStyle(id, workspaceId)`
  already enforces this.

## Requirements

- The pipeline preset editor (`/pipeline/presets`) gets a **Script style
  preset** dropdown and a **Visual style preset** dropdown. Both list
  the same `/api/production-doc/styles` catalogue (built-ins + saved
  rows).
- If `script_style_preset_id` is null, fall back to
  `production_doc_style_id` so existing presets that only set the
  visual style automatically benefit. Either column null = no preset =
  current behavior, byte-identical.
- The `generate_script` handler loads the resolved style via
  `resolveStyle()` and passes it as the `stylePreset` arg of
  `scriptGenerationPrompt`, exactly like the standalone Script
  Generator at `/api/generate/script` does.
- The ScriptGate component, when `scriptContent` is null/empty, shows a
  clear explanation plus the **Regenerate script** and **Kill** buttons
  (no **Keep** button — there's nothing to keep). The Keep button only
  appears when there's actual script text to keep.

## Chosen approach

### Schema (migration 0093)

```sql
ALTER TABLE pipeline_presets
  ADD COLUMN IF NOT EXISTS script_style_preset_id UUID
    REFERENCES production_doc_styles(id) ON DELETE SET NULL;
```

Nullable, no backfill. Mirrors the existing `production_doc_style_id`
column on the same table (added in migration 0052, line 88).

### Types + DB layer

- Extend `PipelinePreset` in `src/lib/auto-pipeline/types.ts` with
  `script_style_preset_id: string | null`.
- Update the SELECT lists in `src/lib/auto-pipeline/db.ts` (two places —
  the per-preset lookup and the per-run lookup) to include the new
  column.
- Update the INSERT in `src/lib/auto-pipeline/db.ts` for run creation
  (`createPipelineRun`) if it touches presets; verify which write paths
  set this column.

### API

- `GET /api/auto-pipeline/presets` (list) — verify the SELECT includes
  the new column; add if missing.
- `GET /api/auto-pipeline/presets/[id]` — add the column to the SELECT
  and the response type.
- `POST /api/auto-pipeline/presets` — accept the new field (UUID or
  null) in the body, INSERT it.
- `PATCH /api/auto-pipeline/presets/[id]` — accept it in the patch body
  with the same null/undefined semantics as `production_doc_style_id`.

### UI (`PresetForm.tsx`)

- Add `script_style_preset_id` + `production_doc_style_id` to
  `FullPreset` interface and to the form's state.
- Load the style catalogue from `/api/production-doc/styles` on mount.
- Render two `<select>` dropdowns under a new **Style presets** section:
  - "Script style preset" — applies to the script-generation stage.
    Hint: *"Picks the producer-curated style that shapes the writing
    voice. Falls back to the Visual style preset when blank."*
  - "Visual style preset" — applies to production-doc + thumbnail.
    Hint: *"Picks the style profile that drives shot composition and
    image generation."*
- Both options include an `— None —` option plus the workspace's
  built-ins and saved styles.

### Script stage (`generate-script.ts`)

After loading the idea, resolve the effective style preset:

```ts
const effectiveStyleId =
  preset.script_style_preset_id ?? preset.production_doc_style_id;
const resolvedStyle = effectiveStyleId
  ? await resolveStyle(effectiveStyleId, video.workspace_id)
  : null;
```

Pass to `scriptGenerationPrompt` via the existing `stylePreset` arg:

```ts
stylePreset: resolvedStyle
  ? {
      label: resolvedStyle.label,
      description: resolvedStyle.description,
      mixing_rules: resolvedStyle.mixing_rules,
    }
  : null,
```

When `resolvedStyle` is null, the prompt is byte-identical to today.

### ScriptGate fix (`VideoCard.tsx`)

Replace the early-return when `scriptContent` is missing with a
clearer block that still surfaces the action buttons:

```tsx
if (!scriptContent) {
  return (
    <div className="rounded-lg p-4" style={{ ...redCard }}>
      <div className="font-semibold text-sm mb-1">Script row is empty</div>
      <p className="text-xs mb-3">
        The script record exists but has no content — usually a stream
        that failed mid-generation. Regenerate to retry, or Kill to drop
        this video from the run.
      </p>
      <div className="flex gap-2">
        <button onClick={onRegenerate} disabled={!!busyAction}>Regenerate script</button>
        <button onClick={onKill} disabled={!!busyAction}>Kill</button>
      </div>
    </div>
  );
}
```

No Keep button — there's nothing to keep.

## Alternatives rejected

1. **Single shared `style_preset_id` (no decoupling)**: simpler but
   loses the ability to write Story-driven prose while rendering
   Doodle-Explainer visuals. The user explicitly picked decoupling
   with fallback (2026-05-27 question round).
2. **Bigger refactor — unify style picking across all stages via a
   `resolveStageStyle(stage, preset)` helper**: tempting but premature.
   Two stages don't justify a helper yet; revisit when the third one
   (e.g., voiceover) needs the same logic.
3. **Migrate existing empty-content scripts on apply**: out of scope.
   The UI fix makes them recoverable; data cleanup is a separate task.

## Security / safety

- Authorization: `resolveStyle(id, workspaceId)` returns null for
  cross-workspace ids, which the stage handler will treat as "no style
  preset" rather than crash. Same null-tolerance the rest of the code
  already exhibits.
- Input validation: API routes coerce the new field through
  `asUuidOrThrow` (same helper `production_doc_style_id` uses) so a
  malformed id is rejected with 400, not stored.
- No new logging surface for PII. The stage handler's existing
  `logger.info` calls don't need to log the style id (it's not
  sensitive but it's not informative either).

## Open questions

None — design fully specified after the 2026-05-27 clarifying round.

## Verification plan

After implementation:

1. **Migration**: run `npm run db:migrate` locally; confirm the column
   exists. `npm run db:status` shows 0093 applied.
2. **PresetForm**: load `/pipeline/presets`, edit a preset, pick a
   script style + visual style, save, reload — both selections persist.
3. **Script generation in pipeline**: start a fresh batch with a preset
   that has a `script_style_preset_id` set. Tail logs for
   `[command-center ...]` and watch the script gate appear with a
   script body that reflects the picked style's `mixing_rules`. (Visual
   inspection — the prompt block is hard to assert programmatically.)
4. **Fallback**: clear `script_style_preset_id` on a preset, leave
   `production_doc_style_id` set, run a batch — script generation should
   still pick up the style.
5. **ScriptGate dead-end**: simulate by `UPDATE scripts SET content =
   NULL WHERE id = '<id>'` on a row that's in `awaiting_script_gate`.
   Refresh `/pipeline/[id]`. The expanded card now shows Regenerate +
   Kill buttons even though content is empty.
