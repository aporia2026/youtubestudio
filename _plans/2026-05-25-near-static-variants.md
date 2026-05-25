# Plan: Near-static variant animation (Phase 3 of Doodle Explainer 2)

**Date:** 2026-05-25
**Status:** Draft — awaiting user approval
**Phase:** 3 of 3 in the Doodle Explainer 2 series
- Phase 1: `_plans/2026-05-25-doodle-explainer-2-built-in.md` (shipped + tuned)
- Phase 2: `_plans/2026-05-25-style-aware-overlay-text.md` (shipped)
- Phase 2.1: section title vs on-screen text slot separation (shipped in same commit)
- **Phase 3: this plan**

## Goal

Reproduce the "near-static animation" pattern from the reference videos: one base illustration plus 2–4 micro-edited variants of that same composition (eyebrow shift, mouth open/close, hand raise) that play in sequence over the voiceover. Generates the perception of subtle character movement without true animation, at roughly $0.011 extra per variant via Atlas GPT Image 2 Edit.

The user-selected architecture (decided 2026-05-25): **variants are SEPARATE production-doc rows that share a `group_id`**. Each row keeps its own timecode, duration, narration. The row with `variant_index = 0` is the BASE (generated normally). Rows with `variant_index > 0` are derived from the base image via Atlas Edit using a per-variant edit prompt.

## Constraints

- **No SQL migration.** The doc is JSONB on `pipeline_stage_artefacts.metadata_jsonb`. Adding fields to `ProductionRow` is back-compat — old rows simply have `group_id = undefined`.
- **Atlas Edit already exists** at `src/lib/atlas-cloud-images.ts:160` (`generateAtlasEdit({ prompt, images })`) and is exposed via `/api/generate/production-doc/image/edit`. Phase 3 builds on top, doesn't introduce a new model integration.
- **No Remotion changes needed for playback.** Because each variant row keeps its own timecode + narration + image URL, the existing composition tree renders variants as independent shots. The "flipbook" effect emerges naturally from the script generator placing several short-duration rows in the same group with the same composition.
- **Per-row override behavior preserved.** A row with `group_id = undefined` continues to work exactly as today. Phase 3 is purely additive.
- **Cost ceiling.** Cap variants per group at 4 (1 base + 3 edits). 3 variants × $0.011 = $0.033 extra per group. For a typical 1-min video with 30 rows where 1 in 5 rows is a 3-variant group, that's 6 × $0.033 = $0.20 extra per video over baseline. Reasonable.

## Requirements

### Schema additions (`ProductionRow`)

Add three optional fields:

```ts
interface ProductionRow {
  // ...existing 30+ fields...
  /** Group id — all rows in a variant group share this UUID. When set,
   *  `variant_index` is also set. Absence = standalone row (today's behavior). */
  group_id?: string;
  /** 0-based index within the group. 0 = base image (generated normally).
   *  1..N = edited variants derived from the base via Atlas Edit. */
  variant_index?: number;
  /** Edit instruction for this variant. Only meaningful when variant_index > 0.
   *  Examples: "shift the eyebrows up to look surprised", "open the mouth
   *  slightly", "raise the right arm a few pixels". Kept short — the edit
   *  model is good at deltas, bad at re-describing the whole scene. */
  variant_edit_prompt?: string;
}
```

Three rules enforced at runtime (not via DB constraints since it's JSONB):

1. Within a group, exactly one row has `variant_index = 0` (the base).
2. Variants must be contiguous in the row list (UX requirement — they render together visually).
3. Cap at 4 rows per group.

### Image generation dispatcher

A new path inside `/api/generate/production-doc/image` (or a sibling route) that:

1. Detects when the request is for a row where `variant_index > 0`.
2. Looks up the base row in the same group (`group_id` match, `variant_index = 0`).
3. Verifies the base has a generated `image_url`. If not, return a 409 telling the editor "generate the base first."
4. Calls `generateAtlasEdit({ prompt: baseRow.ai_image_prompt + variant.variant_edit_prompt, images: [baseRow.image_url] })`.
5. Saves the result as the variant row's `image_url`.

The edit prompt strategy: prepend the base prompt so the model has the full scene context, then append the variant edit instruction. This keeps the model from drifting away from the base composition.

### Editor UI

Three additions to the existing editor:

1. **"+ Add variant" button** on every base/standalone row. Click → creates a sibling row immediately after, with:
   - `group_id` set (auto-generates a UUID if the source row didn't have one yet — also stamps the source row with that same `group_id` and sets its `variant_index = 0`)
   - `variant_index` = max(existing in group) + 1
   - `ai_image_prompt`, `visual_type`, `visual_description` cloned from base
   - `variant_edit_prompt` empty (user fills in)
   - `script_text`, `on_screen_text`, `timecode`, `duration_*` empty/defaulted (each variant has its own narration)
2. **Variant chip + edit prompt field** on variant rows. Visual indicator that the row is `variant 2 of 3` in group `<short id>`. The `variant_edit_prompt` field appears inline below the standard fields.
3. **Visual grouping in the row list.** Variant rows render with a left border in the section's accent color and a `≪ variant of #N` chip. Optional small "regenerate from base" button per variant.

Reordering within a group via drag is **out of scope for v1** (cheaper to support reorder via delete+re-add for now; revisit if it bites).

### Mixing rules update for `doodle_explainer_2`

Add a paragraph telling the script generator when to create variant groups vs standalone rows:

```
VARIANT GROUPS — when to use:

Use a variant group (multiple rows sharing the same composition but
with subtle expression changes) when the script has a sequence of
short narration beats that all happen WITHIN ONE VISUAL MOMENT —
e.g. "She paused. Her eyes widened. Then she smiled." That's one
visual moment (a character reacting) with three narration beats.
Create 3 rows in a group: base = the character at rest, variant 1
= eyes widened, variant 2 = smile. Each row gets its own narration
chunk.

Do NOT use a variant group when the script moves between distinct
scenes (different subjects, different settings, different actions).
Those are standalone rows.

Per row in a variant group:
  - The BASE row (variant_index 0) gets the full ai_image_prompt
    describing the scene as it should be at rest.
  - Variant rows (variant_index 1..N) leave ai_image_prompt empty
    and instead populate `variant_edit_prompt` with the smallest
    possible edit instruction. Example: "raise the right eyebrow
    slightly" or "open the mouth into an O shape".
  - Each variant has its own short script_text (one beat of
    narration) and its own short duration (typically 0.5–1.5 s).
```

## Chosen approach (sub-phase breakdown)

### Phase 3.1 — types + back-compat

- Add `group_id`, `variant_index`, `variant_edit_prompt` to `ProductionRow` in [src/remotion/utils.ts](src/remotion/utils.ts).
- Mirror to the page-level `ProductionDoc` interface in [src/app/(app)/production-doc/page.tsx](src/app/(app)/production-doc/page.tsx) if it has its own copy (some pages do; need to check).
- Add a helper `getVariantGroup(doc, groupId): ProductionRow[]` returning rows ordered by `variant_index`.
- Add a helper `getBaseRow(doc, groupId): ProductionRow | undefined`.

Files: [src/remotion/utils.ts](src/remotion/utils.ts), maybe [src/app/(app)/production-doc/page.tsx](src/app/(app)/production-doc/page.tsx)
Risk: low. ~50 LOC.

### Phase 3.2 — image-gen dispatcher: variant path

- Modify [src/app/api/generate/production-doc/image/route.ts](src/app/api/generate/production-doc/image/route.ts) (or add a sibling route) to detect `variant_index > 0` and route through Atlas Edit.
- Use `generateAtlasEdit({ prompt: <combined>, images: [baseRow.image_url] })`.
- Cost-preview header / response field that surfaces the $0.011 Atlas Edit cost so the editor can display it on the variant's "Generate" button (per global rule 8).
- 409 with `{ code: 'BASE_NOT_GENERATED' }` when the base doesn't have an image yet.
- Logging: new `[image-gen variant-edit]` log line with `group_id`, `variant_index`, `base_image_r2_key`.

Files: [src/app/api/generate/production-doc/image/route.ts](src/app/api/generate/production-doc/image/route.ts), [src/lib/atlas-cloud-images.ts:160](src/lib/atlas-cloud-images.ts#L160) (used as-is).
Risk: medium. Touches the live image-gen route — need to be careful not to break standalone-row generation. ~150 LOC.

### Phase 3.3 — editor UI

- Modify [src/components/production-doc/editor/SectionStrip.tsx](src/components/production-doc/editor/SectionStrip.tsx) to render variant rows with a visual group chip + indent.
- Modify [src/components/production-doc/editor/Inspector.tsx](src/components/production-doc/editor/Inspector.tsx) (the active-row accordion) to show the variant-edit-prompt input on variant rows, and to show the "+ Add variant" button on base/standalone rows.
- New writer in [src/components/production-doc/editor/types.ts](src/components/production-doc/editor/types.ts): `addVariantRow(baseRowIndex: number): void` which:
  - Auto-promotes the base row to have `group_id` + `variant_index = 0` if it doesn't yet
  - Inserts a new row right after the last variant in the group
  - Sets the new row's `group_id`, `variant_index`, and clones the relevant fields from the base
- Wire `addVariantRow` through to the page-level handler that owns the doc + autosave.

Files: [src/components/production-doc/editor/SectionStrip.tsx](src/components/production-doc/editor/SectionStrip.tsx), [src/components/production-doc/editor/Inspector.tsx](src/components/production-doc/editor/Inspector.tsx), [src/components/production-doc/editor/types.ts](src/components/production-doc/editor/types.ts), the page handler.
Risk: medium. Cleanest if done with the editor running locally so we can iterate. ~250 LOC.

### Phase 3.4 — mixing rules update

- Add the "VARIANT GROUPS — when to use" paragraph to `doodle_explainer_2` mixing rules in [src/lib/production-doc-styles.ts](src/lib/production-doc-styles.ts).

Files: [src/lib/production-doc-styles.ts](src/lib/production-doc-styles.ts)
Risk: trivial. ~30 LOC.

### Phase 3.5 — script-generator schema awareness

- The script-generator (the Anthropic Claude call that builds the doc JSON) needs to know about `group_id` / `variant_index` / `variant_edit_prompt` so it can emit valid variant groups.
- Audit [src/lib/auto-pipeline/stages/generate-production-doc.ts](src/lib/auto-pipeline/stages/generate-production-doc.ts) for the prompt + JSON-schema given to Claude. Add the new fields with a one-line description each.

Files: [src/lib/auto-pipeline/stages/generate-production-doc.ts](src/lib/auto-pipeline/stages/generate-production-doc.ts)
Risk: low. ~20 LOC.

### Phase 3.6 — QA end-to-end

- Manual test: generate a fresh doc with `doodle_explainer_2`, find a reactive moment, verify the auto-pipeline produces a variant group.
- Click each variant in editor, click Generate, confirm each derived image matches the base composition with the requested edit.
- Render a preview and confirm playback feels right (variants visibly shift the character without re-drawing the scene).
- Regression: non-doodle_explainer_2 docs continue to render exactly as today.

## Alternatives rejected

1. **Inline variants on a single row** (`variants[]` array). Rejected by user — picked separate rows + group_id instead.
2. **Variants share one timecode + one narration**. Rejected: each variant gets its own narration beat in the reference videos. Forcing one timecode would break voiceover alignment.
3. **Atlas Edit at render time, not at editor time**. Rejected: would block render on N Atlas calls per group; would be impossible to manually QA the edits before render. Generate at editor time means user sees + approves each variant.
4. **Use the Edit model for the BASE image too**. Rejected: the base is the anchor for the whole group's appearance. It should use the regular i2i path (nano-banana-2-i2i) for full style-ref weight. Atlas Edit is best at minor deltas.
5. **Server-side video composition that bakes variants into one MP4 segment**. Rejected: adds an ffmpeg/encoder dependency, undermines per-row timing flexibility, makes the variants invisible in the editor.

## Open questions

1. **Drag-to-reorder within a group.** Not in v1 scope per "Chosen approach" — confirm we're OK leaving this for follow-up?
2. **What's the right cap on variants per group?** I picked 4 (1 base + 3 edits) based on cost + the source videos' typical pattern. Adjustable.
3. **Edit prompt composition strategy.** I'm planning to prepend the base's `ai_image_prompt` to each variant's `variant_edit_prompt` so the model has the full scene context. Alternative: send only the edit instruction and trust Atlas Edit to read the input image. Cheaper to iterate via empirical test renders during Phase 3.6 QA.
4. **What happens when the user changes the base after variants exist?** Should the variants auto-regenerate? Show a stale-warning? For v1 I'd show a "base changed — regenerate variants?" banner and leave the user in control.

## Cost analysis (per global rule 8)

| Item | Cost | Source |
|---|---|---|
| Base image (existing) | $0.04 | nano-banana-2-i2i, 14 refs (current default) |
| Each variant | $0.011 | Atlas GPT Image 2 Edit, single input image |
| 3-variant group (1 base + 3 edits) | $0.04 + 3×$0.011 = **$0.073** | combined |
| Same beat as 4 standalone rows | 4×$0.04 = **$0.16** | baseline today |
| Savings per 3-variant group | **~$0.087 (55%)** | by using Edit for the deltas |

Net effect: variants are CHEAPER than rendering 4 standalone rows that happen to share a composition. The cost story is a positive for this approach, not a negative.

R2 storage: ~50 KB per variant image, trivial.

## QA checklist

- [ ] `tsc --noEmit` clean
- [ ] Existing standalone-row image gen unchanged (regression check)
- [ ] New variant row generation produces an edited image consistent with the base
- [ ] Editor shows variant chip + edit-prompt input on variant rows
- [ ] "+ Add variant" button creates a sibling row with the right fields
- [ ] Auto-pipeline output for a doodle_explainer_2 doc with a reactive script beat emits a variant group
- [ ] Render preview plays variants in sequence and feels like the reference videos' near-static animation
- [ ] Doc with no variant groups renders byte-identically to before Phase 3

## Sub-phase shipping order

Recommend shipping in this order so each push is self-contained and reversible:

1. **3.1 + 3.2** as one commit: types + dispatcher. No UI yet, but verifiable via direct API calls.
2. **3.3** as one commit: editor UI on top of the working backend.
3. **3.4 + 3.5** as one commit: mixing rules + script-generator schema. Auto-pipeline now produces variant groups.
4. **3.6** as a final tuning commit if needed.
