# 2026-06-07 — Bulk-variations endpoint + channel-clone title-card emission

Two editor bugs, fixed together because they were filed in the same report
and share the editor's data path.

## Goals

1. **Bug 1.** Make "Generate all Variations" produce the same output as
   clicking the per-row "Generate variant" button on each variant row.
   Today it routes through the base-image text-to-image endpoint with
   only `prompt + styleId`, dropping the base image and the style-
   preservation hint. Result: variants come out as realistic photos
   even on a doodle-style doc.

2. **Bug 2.** Make channel-clone projects emit `visual_type === 'Title Card'`
   rows wherever the script has a section divider. Today channel-clone's
   script-runner explicitly forbids markdown headings and its
   rowify-runner uses a three-value `visual_type` enum (`ai_image | stock |
   overlay`) with no Title Card option. The editor's TITLE badge + Titles
   filter chip already render correctly for `visual_type === 'Title Card'` —
   they just never get any rows to show.

## Non-goals

- **No retroactive promotion** of the user's existing 274-row channel-clone
  doc. Existing rows stay how they are; users can promote individual rows
  via Inspector → Shot type → Title Card. Migrating live data is a
  separate, opt-in feature.
- **No editor-side filter chip "always show" change.** The chip-hides-
  when-count-is-0 behaviour is correct UX (keeps the strip tight); the
  fix is to make sure the count is > 0 when it should be.
- **No change to the main `auto-pipeline` production-doc stage.** Its
  title-card pipeline already works (it's the model channel-clone needs
  to mirror).

## Bug 1 — fix

### Root cause

`runFillBlanks` ([EditorClient.tsx:711](src/app/(app)/edit/[projectId]/EditorClient.tsx#L711))
dispatches every blank row through `generateOne`
([EditorClient.tsx:938](src/app/(app)/edit/[projectId]/EditorClient.tsx#L938)).
`generateOne` always POSTs to `/api/generate/production-doc/image` (the
t2i base endpoint) with `{ prompt, model, onScreenText, sectionTitle,
styleId }`. For variant rows this is wrong — variants need the i2i
edit semantics that the per-row button uses
([EditorClient.tsx:2778](src/app/(app)/edit/[projectId]/EditorClient.tsx#L2778)):

```ts
const prepared = composeVariantEditRequest(liveDoc, variantRow, sourceImageUrl, editPrimary);
// → POST /api/generate/production-doc/image/edit
//   { originalImageUrl: base, prompt: "<edit instruction>. <style-preservation hint>", optionId }
```

Secondary issue: `runFillBlanks` chunks 4 consecutive blanks into collage
units when `doc.collage_mode === true` (the default). For variants this
would batch them through the multi-cell t2i collage endpoint — also
wrong. Variants must always stay as single units.

### Fix shape

Two-layer in `EditorClient.tsx`:

1. **Work-unit builder** — extract the inline collage-vs-single chunker
   out of `runFillBlanks` into a pure helper
   `src/lib/editor/fill-blanks-units.ts` so it's unit-testable. The
   helper takes the blank indices + the rows + `collageOn` and returns
   the work-unit array. Inside: variant rows (`(row.variant_index ?? 0)
   > 0`) are always emitted as single units, never bundled into a
   collage chunk.

2. **`generateOne` variant branch** — detect variant rows and dispatch
   them through `composeVariantEditRequest` + `/api/generate/production-doc/image/edit`,
   mirroring the per-row path. Variants without a generated base
   image fail with the same `BASE_NOT_GENERATED` error the per-row
   path returns. Variants without `variant_edit_prompt` fail with
   `MISSING_EDIT_PROMPT`. Both increment `failed` so the toast shows
   them.

### Tests

`tests/fill-blanks-units.test.ts`:
- Collage off → every blank is a single unit, in order.
- Collage on + 4 consecutive non-variant blanks → one collage unit.
- Collage on + 4 consecutive variant blanks → 4 single units.
- Collage on + mix (2 base, 2 variant, 4 base) → 2 singles, 2 singles,
  1 collage of 4.
- Per-row `image_model` override breaks the chunk (existing behaviour
  carried over from the inline implementation — pin it).

## Bug 2 — fix

### Root cause

Three independent gaps in the channel-clone path:

1. **`script-runner.ts:41`** — the output schema forbids headings:
   `"plain text (no markdown, no headings, no stage directions)"`.
   The repair pipeline `extractScriptTitles` looks for `## Heading`
   lines and finds zero in channel-clone scripts.

2. **`rowify-runner.ts:46`** — the schema's `visual_type` enum is
   `'ai_image' | 'stock' | 'overlay'` only. No `'Title Card'` value,
   even if the LLM wanted to emit one.

3. **`rowify-runner.ts:177`** — `buildRowifyUserPrompt` feeds the raw
   approved script to the LLM. No sentinel replacement, no
   instruction to emit Title Cards, and `normalizeTitleCards` is not
   called on the parsed output.

### Fix shape

Mirror the main pipeline's title-card mechanism inside channel-clone:

1. **`script-runner.ts`** — loosen the "no headings" constraint to
   "may use `## Heading` lines on their own line to mark major topic
   shifts". Add one sentence on what counts as a topic shift (an
   "act break" / shift to a new chapter / a clear "next, …" pivot —
   not every paragraph). The narrator never speaks the heading text;
   `extractScriptTitles` strips them before TTS sees them.

2. **`rowify-runner.ts`** — widen `ChannelCloneProductionRow.visual_type`
   to include `'Title Card'`. Update `ROWIFY_OUTPUT_SCHEMA` to:
   - Mention `'Title Card'` as a valid value with the same guardrail
     wording as `prompts.ts:2304` ("RESERVED EXCLUSIVELY for the title-
     sentinel rows described below").
   - Add a "Title card sentinels" section, mirroring `prompts.ts:2319-2330`,
     instructing the LLM to emit one Title Card row per `<<TITLE_N>>`
     sentinel found in the input script.
   - Loosen the `script_text` "EXACT excerpt" rule to "EXACT excerpt
     OR the heading text from the matching `<<TITLE_N>>` sentinel".
   - Loosen `parseRowifyResponse` to accept `'Title Card'`, and skip
     the `ai_image_prompt` / `stock_search_terms` non-emptiness
     checks for Title Card rows (their `ai_image_prompt` must be
     empty — they render as typography).

3. **`rowify-runner.ts:runRowify`** — wire the pipeline:
   ```ts
   const extracted = extractScriptTitles(approvedScript.text);
   const userPrompt = buildRowifyUserPrompt(analysis, visualProfile, {
     ...approvedScript,
     text: extracted.stripped,
   }, extracted.titles);
   // ... LLM call ...
   const parsed = parseRowifyResponse(raw);
   const normalized = normalizeTitleCards(parsed, extracted.titles, extracted.stripped, { allowOverlay: false });
   ```
   `buildRowifyUserPrompt` grows a 4th arg (`titles: ExtractedTitle[]`)
   and the LLM gets a "Title card sentinels in this script:" block
   listing each sentinel + its text (matching `prompts.ts:2319-2330`).

4. **Handoff** — no change. `handoff-runner.ts` already passes
   `visual_type` through verbatim, so `'Title Card'` makes it onto
   the production-doc artefact and the editor reads it correctly.

### Tests

`tests/channel-clone-rowify.test.ts` (extend existing):
- `parseRowifyResponse` accepts a Title Card row with empty
  `ai_image_prompt` + empty `stock_search_terms`.
- `parseRowifyResponse` still rejects an `ai_image` row with empty
  `ai_image_prompt` (carry-over).

`tests/channel-clone-title-cards.test.ts` (new):
- A script with `## Heading` → headings are extracted, sentinels
  replace them in the stripped script, the rowify schema instructs
  on Title Card emission. (Tests the pure helpers + the prompt
  builder shape, not the LLM call.)
- After parse + normalize: an LLM that drops a Title Card sentinel
  → `normalizeTitleCards` synthesizes the missing row at the right
  position.
- After parse + normalize: an LLM that mistags a regular row as
  Title Card → `normalizeTitleCards` demotes it.

## Observability

New log namespaces:

- `[editor fill-blanks variant-dispatch]` — once per variant row
  routed through the edit endpoint, with `{ shotIndex, baseRowIndex,
  hasEditPrompt, chained }`.
- `[channel-clone rowify titles-extracted]` — once per rowify run,
  with `{ jobId, titleCount, sentinelPositions }`.
- `[channel-clone rowify title-cards-normalized]` — once per rowify
  run, with `{ jobId, demotedCount, insertedCount, insertedTitles }`
  (matches the main pipeline's existing log shape).

Carry over the existing namespaces; this just adds new ones on the
new branches.

## Settings

No new editor settings. The Inspector → Shot type dropdown already
lets the user promote any row to Title Card manually, and the editor's
filter chip + badge already render correctly. The fix is upstream.

Channel-clone's script-runner is internal — no user-facing knob for
"allow headings". The prompt change applies to every channel-clone
run.

## Security

No new attack surface. Both fixes operate on existing trusted
internal data flows. The variant-edit endpoint already validates
`originalImageUrl` server-side. The script-titles extractor runs on
trusted internal output from a sandboxed LLM call.

## Out of scope

- Migrating the user's existing 274-row doc to include Title Cards.
  Future work if the user wants a "scan this doc for slate-style
  shots and promote them" tool.
- Title cards in non-channel-clone paths (the main pipeline already
  does this correctly).
- Changing the editor's Title chip to render at count = 0.
