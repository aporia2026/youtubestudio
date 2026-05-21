# 2026-05-21 — Phase 6 v2: smart local still-model selection in batch

**Status:** Approved (scope tightened — see "What I'm NOT doing"). Targets the one remaining gap from the model-comparison evidence: the local stills batch always uses Flux schnell, but the comparison showed Qwen-Image is the right pick for styled docs and for any row whose OST text gets baked into the image.

## What changed in scope

Original Phase 6 v2 idea was a big "batch clips + auto-render handoff" feature. Discovery during implementation:

- **"Animate all" already routes cloud + local clip rows correctly per row.** It uses each row's `userDefaultModelId` and the Phase 8.1 local-clip dispatch table (Wan + Hunyuan) just works. No new batch button needed.
- **Auto-render handoff** is also already covered — the existing "Render" affordance in the doc header lives next to the player. Adding a notification toast is a polish nit, not a real gap.
- **The real gap** is: the comparison evidence showed Flux schnell is wrong for styled docs (anchors too hard to the sheet at denoise 0.7, ignores scene prompts) and for baked-text rows (garbles glyphs). Yet the bulk button hardcodes it.

Keeping this phase tight: just fix the picker. Auto-render handoff stays as a future polish item.

## What ships

### 1. `src/lib/local-still-picker.ts` — pure helper (NEW)

```ts
export type LocalStillModel = 'flux-schnell-local' | 'qwen-image-local';

export interface PickInput {
  /** Row state needed for the decision. */
  row: {
    on_screen_text?: string | null;
    on_screen_text_mode?: 'bake' | 'overlay' | 'none';
  };
  /** Doc state. */
  doc: {
    style_sheet_url?: string | null;
    on_screen_text_mode_default?: 'bake' | 'overlay' | 'none';
  };
}

export function pickLocalStillModel(input: PickInput): LocalStillModel;
```

Resolution rules (priority order — first match wins):

1. **Row has baked-text OST** (`on_screen_text_mode === 'bake'` after doc-default resolution AND non-empty trimmed text) → **`qwen-image-local`**. Flux schnell garbles glyphs (verified BREAKING NEWS test); Qwen renders text cleanly. The 9× speed penalty is justified for the few rows that actually need it.
2. **Doc has a style sheet** (`style_sheet_url` is set) → **`qwen-image-local`**. The Phase 7 i2i chain works at denoise 0.7; at that denoise Flux anchors too hard to the reference (verified on doodle comparison — Flux outputs ≈ copy of the reference image). Qwen actually follows the scene prompt while keeping the style.
3. **Default** → **`flux-schnell-local`**. ~9× faster than Qwen. Good enough quality for unstyled / fast-iteration cases.

Pure function. No I/O. Trivially unit-testable.

### 2. `runGenerateAllStillsLocal` — use the picker

Three concrete changes in `src/app/(app)/production-doc/page.tsx`:

- Replace the hardcoded `model: 'flux-schnell-local'` with a per-iteration `pickLocalStillModel({ row, doc })`.
- Update the confirm dialog to surface the per-model breakdown: `"Generate N stills locally? 12 × Flux schnell (~4 min), 3 × Qwen-Image (~9 min)."` so the user knows the projected runtime before clicking.
- Add `[prodoc batch-stills] picked-model` debug log per-row so a future "why did this row use schnell?" question is answerable from the console.

### 3. Cloud (Kie) path unchanged

Per the user's explicit ask: "Qwen-as-default-for-styled-docs just for local not production." The Kie cloud path keeps its existing `DEFAULT_IMAGE_MODEL = 'grok-imagine-t2i'` selection. No change to `src/lib/image-models.ts`. No change to any cloud-routing logic.

The picker is only consulted in `runGenerateAllStillsLocal` (the local Flux/Qwen batch button). Per-row per-cell generation (the right-click "Generate" menu, the retry buttons, etc.) all use whatever model the row already names — no change there either.

## What I'm NOT doing

- **Auto-render handoff toast** — defer. Existing "Render" affordance is one click away once stills+clips are done.
- **New "⚡ Clips (local)" batch button** — "Animate all" already does this work for local rows via the Phase 8.1 dispatch table.
- **Combined "Build everything" superbutton** — three separate buttons (stills, clips, render) is the right shape for now. A super-button hides state from the user; the current shape lets them see what's happening at each stage.
- **Doc-level "preferred local still model" setting** — adding a fourth knob when the picker rule is "smart" by default would muddy the UX. If the auto-pick is wrong, the user can override per-row via the existing model picker.

## Settings audit (rule 15)

Nothing new exposed. The picker rule is implicit — it uses fields the user already controls (`style_sheet_url`, `on_screen_text_mode`). The button label + confirm dialog tells the user what model each row will use.

## Observability (rule 14)

- `[prodoc batch-stills] picked-model` info log per-row with `{ row_index, picked: 'flux-schnell-local' | 'qwen-image-local', reason: 'baked_text' | 'style_sheet' | 'default' }`.
- Existing `[prodoc image-gen] canvas resolved` already logs model + canvas state; nothing else needed.

## Security + safety (rule 13)

No new attack surface. The picker is a pure function over already-validated row + doc state. No new env vars, no new external calls, no new persistence.

## Test plan

Unit:
- 6 truth-table tests for `pickLocalStillModel`:
  - Baked text + no sheet → Qwen.
  - Baked text + sheet → Qwen.
  - Overlay text + no sheet → Schnell.
  - Overlay text + sheet → Qwen (sheet wins).
  - No text + no sheet → Schnell.
  - No text + sheet → Qwen.
  - Empty/whitespace-only baked text → defaults (text-presence check matters).

Manual:
- Open a doc, generate a style sheet, click "Generate stills". Confirm dialog shows the breakdown with Qwen rows. After completion, rows have Qwen-quality outputs that follow the prompt + style.
- Clear the sheet, regenerate one row. Confirm dialog defaults to Schnell.
- Add an OST in bake mode to a row, regenerate. That single row uses Qwen even on an unstyled doc.

## Out of scope follow-ups

- Auto-render handoff toast after batch completion.
- Per-row "force model" picker in the bulk-button preview (preview only — overrides happen via the existing row-level picker).
- Multi-model concurrency optimisation (ComfyUI is single-prompt regardless, so this is moot until a second GPU enters the chat).
