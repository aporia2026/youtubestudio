# 2026-05-21 — Phase 7: per-doc style sheet (visual consistency v2)

**Status:** Approved (i2i-chain approach picked over Redux + multimodal LLM). Closes the cross-shot consistency gap (palette, line-weight, protagonist appearance) using existing i2i workflows — no new model downloads, no per-shot LLM calls.

## Goal

Every shot in a long-form YouTube video should look like it's from the same world: same protagonist, same palette, same render style. Today the `production_doc_styles` table appends a style-suffix string to every prompt — that fixes palette and roughly the render style, but diffusion models still give "Bob" a different face in every shot.

Fix: generate **one** "style sheet" image at doc init. Every per-row generation chains against it via **img-to-img at denoise 0.7** — the same primitive that already powers the "use as reference" feature in `/local-studio`.

## Scope decisions (decided, not open)

- **Generator**: Flux schnell (Apache 2.0, ~10s warm) as the default; Qwen-Image as a picker option. Flux dev rejected — its non-commercial license is poison for a monetized YouTube creator app since every derivative chain becomes NC-tainted. HiDream-I1 stays in the picker but bricked on 16 GB.
- **Chaining**: i2i with the sheet at denoise 0.7. Reuses `flux-schnell-i2i.json` / `qwen-image-i2i.json`. No new downloads.
- **Storage**: JSONB fields on the production-doc and per-row. **No DB migration** — production_doc rows live inside `user_history.doc`.
- **Triggers**: explicit "Generate style sheet" button + auto-pipeline pre-gen. Per-row Generate suggests "Generate sheet first?" if missing — never silently generates.
- **Sheet layout**: adaptive — `has_protagonist=true` → 2×2 grid (front / ¾ / profile / palette tile) at 1024×1024; `false` → single 1920×1080 scene showing palette + level-of-detail. Both stored in R2 as PNG.

## What's NOT in scope

- **Flux Redux** (image-embedding chaining) — listed in original plan; deferred. We'll only adopt it if i2i-chain ships and character drift is unacceptable in real use.
- **Multimodal LLM prompt-writer** — deferred. Per-shot LLM calls add token cost without proven necessity once i2i chaining is in place.
- **Cloud Kie chaining** — Kie models don't accept arbitrary reference images for style-only conditioning. v1: the doc carries a `style_sheet_description` text string; cloud generations append it to the prompt (cheap, weak, but better than nothing). True image-reference chaining for Kie is out of scope.
- **Per-style preset `has_protagonist`** — original plan put this on `production_doc_styles`; that's the wrong scope (a style preset gets reused across docs with different protagonists). Lives on the doc instead.
- **Sheet regeneration on style-suffix change** — user re-rolls manually. Mode mismatch is a future polish item, same shape as the Phase 5 mode-mismatch flagging.

## New TypeScript fields

```ts
// ProductionDoc (page.tsx + remotion/utils.ts copies)
style_sheet_url?: string;             // R2 URL of the saved sheet
style_sheet_model?: string;           // 'flux-schnell-local' | 'qwen-image-local' (for re-roll fidelity)
style_sheet_has_protagonist?: boolean;
style_sheet_prompt?: string;          // prompt used (for re-roll + UI display)
style_sheet_description?: string;     // short text description for cloud-Kie prompt augmentation

// ProductionRow
style_sheet_skip?: boolean;           // true → this row generates without chaining (cutaways, landscapes)
```

No migration — JSONB.

## New routes / files

### `src/app/api/generate/style-sheet/route.ts` (NEW)

`POST` body: `{ prompt, model, hasProtagonist }`. Returns `{ imageUrl, model, prompt }`. Implementation:
1. Build the sheet-specific prompt: prepend a layout directive (`"2x2 reference sheet: [protagonist front], [protagonist 3/4], [protagonist profile], [palette swatch]"` when `hasProtagonist`; full-scene otherwise).
2. Dispatch to local generator (Flux schnell default at 1024×1024 for protagonist; 1920×1080 for no-protagonist). Cloud Kie path can come later; for v1 local only.
3. Upload result to R2 under `style-sheets/<docId>-<timestamp>.png`.
4. Return the public URL.

Auth: `apiRoute.authed`. Rate limit: same as `/api/generate/production-doc/image`.

### `src/lib/style-sheet.ts` (NEW)

Pure helpers:
- `buildSheetPrompt(stylePrompt: string, hasProtagonist: boolean): string`
- `resolveSheetReference(row: ProductionRow, doc: ProductionDoc): string | undefined` — returns the sheet URL when this row should chain, or `undefined` when `style_sheet_skip` is true or no sheet exists.

Unit-tested.

## Modifications

### `src/app/api/generate/production-doc/image/route.ts`

- Accept `referenceImageUrl?: string` in the body.
- When the local-ComfyUI path is taken AND `referenceImageUrl` is provided, fetch it (R2) and upload to ComfyUI's `input/` folder using the same `fetchToComfyInput` helper as `local-broll.ts`. Pass the resulting filename + `denoise: 0.7` into the generator. The generator already swaps to the i2i variant on `refImageFilename`.
- When the cloud-Kie path is taken AND `styleSheetDescription` is provided, append the description to the prompt as a "in the same style as: [desc]" clause (after the OST/safe-top directives). Cheap text-only chaining for cloud.
- Log the resolved chaining state in the existing `[prodoc image-gen] canvas resolved` info line.

### `src/lib/visual-generator/comfyui-local.ts`

Already accepts `refImageFilename` and `denoise`. No changes — the i2i variant swap is automatic.

### `src/lib/auto-pipeline/stages/generate-production-doc.ts`

After persisting the parsed doc, fire-and-forget a style-sheet pre-gen using:
- The doc's resolved style prompt (from `production_doc_styles`)
- `hasProtagonist: true` (the auto-pipeline assumes a protagonist by default; user can re-roll without one later)
- Default model: `flux-schnell-local`

Best-effort: failure does NOT block the auto-pipeline. The button on the doc page handles the user-initiated path.

### `src/app/(app)/production-doc/page.tsx`

Three additions, mirroring Phase 0/5's plumbing pattern:

1. **Doc header strip** — small "Style sheet" panel near the existing doc controls. Shows the current sheet thumbnail, a "Re-roll" button, and a `has_protagonist` toggle. When no sheet exists, shows "Generate style sheet" CTA. Lazy-user-friendly (rule 10): one prominent button, clear preview.

2. **Per-row skip toggle** — small "Chain to sheet" indicator beside the per-row generate button. Clicking flips `style_sheet_skip`. Visual default: chained.

3. **Image-gen call sites** — the 7 existing call sites already touched by Phase 0/5 each get one more field threaded through:
   ```ts
   referenceImageUrl: row.style_sheet_skip ? undefined : doc.style_sheet_url,
   styleSheetDescription: row.style_sheet_skip ? undefined : doc.style_sheet_description,
   ```

### `src/components/production-doc/StyleSheetPanel.tsx` (NEW)

Reusable component for the doc header strip. Props:
- `sheetUrl: string | undefined`
- `hasProtagonist: boolean`
- `onGenerate(opts: { hasProtagonist: boolean }): void`
- `onClear(): void`
- `generating: boolean`

Single panel that doubles as both the "empty / generate" and "preview / re-roll" states.

## UI placement

The doc page already has a top area with doc-level controls (the title, niche, total duration display, brand-kit override panel, etc.). The Style Sheet Panel slots in after the brand-kit override panel — same visual rhythm.

## Settings audit (rule 15)

Exposed:
- Doc-level: Generate / Re-roll / Clear style sheet; toggle `has_protagonist`.
- Per-row: Chain to sheet (default on) / Skip (off).

Not exposed in v1 (intentionally):
- Custom denoise per row (default 0.7).
- Custom sheet model per row (uses the doc's `style_sheet_model`).
- Multiple sheets per doc (cutaway sheet vs. main sheet) — interesting future feature.

## Observability (rule 14)

- `[style-sheet gen] start` + `[style-sheet gen] done` logs with `{ doc_id, model, has_protagonist, ms }`.
- `[prodoc image-gen] canvas resolved` adds `{ ref_image: 'sheet' | 'none', denoise }` for chained generations.
- The doc header panel surfaces a stale-sheet warning if the doc's style preset changed after the sheet was generated.

## Security + safety (rule 13)

- R2 upload uses the existing `getImagesBucket()` + `uploadToBucket()` plumbing — no new bucket, no new credentials.
- The R2 URL is hosted under the existing public-image prefix; same exposure as currently-generated row images.
- Sheet URLs are not sensitive (they're meant to be public references).
- `referenceImageUrl` server-side is constrained: when fetched, the route uploads to ComfyUI's `input/` only when the URL is `https://` and the fetch response is an image content-type. No file:// / SSRF risk because the fetch is `globalThis.fetch` with no special headers.

## Test plan

### Unit tests
- `buildSheetPrompt`: protagonist + scene variants, style-suffix injection, length cap.
- `resolveSheetReference`: row-skip respected; missing sheet → undefined; doc with sheet + no row override → sheet URL.

### Manual smoke
1. Open a fresh production-doc. Click "Generate style sheet" with a protagonist. → 2×2 grid PNG appears in the doc header.
2. Click "Re-roll". → New sheet appears.
3. Click Generate on any row. → Image generates via i2i with the sheet, character/palette consistent with sheet.
4. Toggle "Skip" on a cutaway row, regenerate. → Image generates without chaining (t2i), composition free.
5. Toggle `has_protagonist` off, re-roll. → Sheet now shows full-scene swatch without character.
6. Auto-pipeline: kick off a fresh end-to-end run. → Sheet appears on the doc automatically.

## Out-of-scope follow-ups

- Flux Redux upgrade (better embedding-based continuity) — only if i2i-chain quality proves insufficient in real use.
- Multimodal LLM per-shot prompt enrichment — same trigger as above.
- Cloud Kie image-reference chaining — waiting on Kie API features.
- Sheet versioning + history (re-roll #2 doesn't blow away the previous sheet).
- Multi-sheet docs (separate sheet for cutaway scenes).
