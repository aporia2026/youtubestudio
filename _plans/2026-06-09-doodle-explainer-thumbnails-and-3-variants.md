# Doodle Explainer thumbnail style + 3-variants for all formats

**Date**: 2026-06-09
**Status**: Draft, awaiting approval
**Owner**: yoavm7-code

## What you asked for

1. Add a **Doodle / Paint-Explainer** thumbnail style to the thumbnails page (modelled on the YouTube channel you showed me: simple hand-drawn doodle character + big yellow bold hook word + clean background).
2. Change every thumbnail generation to produce **3 variants** instead of 1, so you can pick one.

## Decisions you already made

| Decision | Choice |
|---|---|
| How the new style is exposed | **Both**: new "Doodle Explainer" format AND a reusable thumbnail-style registry |
| How variants are generated | **3 different prompts from the LLM** (real creative alternatives, not seed re-rolls) |
| Scope of 3-variants | **All formats at once** (free-form, topic-card-grid, n-levels, flex-icon-grid, new doodle) |
| Default image model | **Kie GPT Image 2 t2i** (`gpt-image-2-t2i`) |

## Brutal honesty — what's worth pushing back on before we start

1. **"All formats at once" triples per-thumbnail image cost.** Today: 1 image per generate click. After: 3 images. At Kie GPT Image 2 ~$0.02/image (estimate — see open question Q1), a user who generates 10 thumbnails/day goes from ~$0.20/day to ~$0.60/day in image cost. Not huge per user, but multiplied across active users it stacks. **You're OK with this — but the plan ships with a Settings toggle for variant count (1 / 2 / 3) so it's reversible per user.**

2. **Doodle-style refs were tuned for Atlas i2i, not GPT Image 2 t2i.** The `paint_explainer_v1` production-doc style works by giving Atlas a curated ref bundle and letting i2i anchor on them. Kie GPT Image 2 t2i can't take refs — style has to live entirely in the text prompt. We'll lose some on-style fidelity. Mitigation: bake a strong "doodle paint-explainer suffix" into the new style entry that mirrors the production-doc suffix at `src/lib/production-doc-styles.ts:1196-1227`. Acceptable trade for the simpler t2i flow; we can add an i2i fallback later if the t2i output drifts.

3. **3 LLM prompts per format means 1 LLM call returning 3 structured variations, not 3 separate LLM calls.** This is what I recommend below (one call with structured-output schema asking for an array of 3 variations). Saves you ~2x LLM cost vs. naive parallel calls and the variations are forced to be genuinely distinct because the LLM sees the other two when writing each.

## Goals

- A new "Doodle Explainer" format in the thumbnails page picker that ships YouTube-doodle-style thumbnails out of the box, with hook text, character expression, optional background scene.
- A reusable thumbnail-style registry (`src/lib/thumbnail-styles.ts`) so other formats can later opt into a style without bolting one in ad hoc. First entry is the doodle one.
- Every thumbnail generation across every format returns 3 variants. The page shows a 3-up picker; the user picks one and that becomes the "selected" thumbnail.
- History/restoration round-trips the full 3-variant payload AND the user's selection, so a restored entry shows the same 3 with the same one pre-selected.
- A Settings toggle to choose variant count (1, 2, 3) — default 3.

## Out of scope

- Sharing the doodle style with production-doc rendering. The thumbnail style registry and the production-doc style registry stay separate (rationale: different consumers, different model providers, different prompt shapes). When a doodle thumbnail reads on-screen as a sibling of a doodle video row, that's by design — same look, two registries.
- "Variant scoring" / auto-pick. The user picks. We don't run a CTR predictor on the 3 variants.
- New image models. We use what's already in `IMAGE_MODELS` at [src/app/(app)/thumbnails/page.tsx:47-73](src/app/(app)/thumbnails/page.tsx#L47-L73).
- Backwards retrofit of old history entries to look like they have 3 variants. Old entries (single `imageUrl`) keep rendering single-variant; new entries get the 3-variant UI.

## Approach (with alternatives)

### Alternative A — Format-scoped variants (recommended)

Each format's history payload (`TopicCardGridHistoryPayload`, `NLevelsHistoryPayload`, `FlexIconGridHistoryPayload`, new `DoodleExplainerHistoryPayload`) gets a `variants: ThumbnailVariant[]` field plus `selectedVariantIndex: number`. The existing `imageUrl` becomes a derived getter (= `variants[selectedVariantIndex].imageUrl`) for old-code compatibility during the transition; it can be removed in a follow-up.

**Pros**: Per-format payload owns its own variant shape (each format can store format-specific metadata per variant — e.g. which card layout, which level order). Clean discriminated union.
**Cons**: Three payload types to update (and the new one), plus the free-form `generatedImages` Record needs its own variant treatment.

### Alternative B — Top-level format-agnostic variants on `ThumbnailHistoryEntry`

One `variants: ThumbnailVariant[]` array at the top level of `ThumbnailHistoryEntry`, mirroring `selectedVariantIndex`. Format payloads stay untouched.

**Pros**: Single point of change. No discriminated-union work.
**Cons**: Loses the per-format-per-variant metadata (e.g. which card layout produced this variant). When the user picks variant #2, we'd have to re-derive the cards/levels/regions from somewhere — which means the per-variant LLM output (cards array, level array) has to live somewhere, and that "somewhere" ends up being per-format anyway. So this collapses into Alternative A with extra hops.

### Alternative C — Generate 1 variant up-front + "regenerate" button

Keep the existing 1-variant flow, but add a "🎲 More variants" button that generates 2 more on demand. User only pays for variants 2 and 3 when they actually want them.

**Pros**: Cheapest. Familiar UX (it's the existing "regenerate" pattern).
**Cons**: Defeats the user-stated goal of seeing 3 side-by-side to pick from. You said "we will create 3 variants, not just one" — that's 3 up-front. Listed for completeness; not the path.

### Recommendation — **Alternative A**

Per-format payloads carry variants. The new shared `ThumbnailVariant` type is the unit; per-format `VariantMetadata` extensions describe what was different between variants (cards layout for grid, levels order for n-levels, character expression for doodle).

## Architecture

### 1. Thumbnail style registry — `src/lib/thumbnail-styles.ts` (new)

Modelled on `src/lib/production-doc-styles.ts`. Smaller because thumbnails are simpler:

```ts
export interface ThumbnailStyle {
  id: string;
  label: string;
  description: string;
  /** Prompt suffix glued onto every image-gen prompt under this style. */
  ai_image_suffix: string;
  /** Optional ref bundle for i2i models (Atlas, Flux2-i2i, etc). Empty for t2i-only styles. */
  built_in_refs?: Array<{ filename: string; mime_type: string }>;
  /** Default image model when this style is selected. */
  preferred_image_model: string;
  /** Default text-overlay style preset (matches STYLE_PRESETS ids on the page). */
  preferred_text_style_preset?: string;
  /** Hook expressions the doodle style offers. Other styles ignore. */
  supported_character_expressions?: string[];
}

export const THUMBNAIL_STYLES: ThumbnailStyle[] = [
  {
    id: 'paint_explainer_v1_doodle',
    label: 'Doodle Explainer',
    description: 'Hand-drawn doodle character + big bold yellow hook word on clean background. Modelled on the Paint Explainer YouTube genre.',
    ai_image_suffix: '...', // see §1.1 below
    preferred_image_model: 'gpt-image-2-t2i',
    preferred_text_style_preset: 'bold-impact',
    supported_character_expressions: ['confused', 'worried', 'deadpan', 'surprised', 'angry', 'curious', 'shocked'],
  },
];

export function resolveThumbnailStyle(id: string | undefined): ThumbnailStyle | undefined { ... }
```

**1.1 The doodle style's `ai_image_suffix`** — mirror the `paint_explainer_v1` suffix at [src/lib/production-doc-styles.ts:1196-1227](src/lib/production-doc-styles.ts#L1196-L1227) but tuned for thumbnails (16:9, hook text as the focal element, character must show one clear emotion). Include the "yellow comic-bold typography" block verbatim — that's the visual signature.

**1.2 Where this lives** — `src/lib/thumbnail-styles.ts`, server-safe (no React imports, no Next runtime). Symmetry with `production-doc-styles.ts`.

### 2. `ThumbnailVariant` type — `src/lib/thumbnail-variants.ts` (new)

```ts
export interface ThumbnailVariant {
  /** Stable id within the entry — `v0`, `v1`, `v2`. */
  id: string;
  imageUrl: string;
  /** Full prompt sent to the image model. Saved so user can see what differed. */
  promptUsed: string;
  /** Short human-readable label, e.g. "Character on left, text right" — comes from the LLM step. */
  conceptLabel?: string;
  /** Token count + cost, for telemetry. Filled by the route, not the LLM. */
  costEstimateUsd?: number;
}
```

### 3. History schema changes — `src/lib/history.ts`

Add to **each** existing format payload:
- `variants?: ThumbnailVariant[]`
- `selectedVariantIndex?: number`

Keep the existing `imageUrl: string` field. On read, code that wants "the chosen image" reads `payload.variants[payload.selectedVariantIndex ?? 0]?.imageUrl ?? payload.imageUrl`. Old entries (variants undefined) keep working via the fallback.

Add new payload:
```ts
export interface DoodleExplainerHistoryPayload {
  hookText: string;
  characterExpression: string;
  backgroundScene?: string; // 'plain-white' | 'cave' | 'underwater' | 'sky' | 'space' | 'custom' | etc.
  customBackground?: string; // free text when backgroundScene === 'custom'
  textStylePreset: string; // matches STYLE_PRESETS ids
  styleId: string; // from THUMBNAIL_STYLES
  imageModel: string;
  variants: ThumbnailVariant[];
  selectedVariantIndex: number;
}
```

Add to `ThumbnailHistoryEntry.format` union: `'doodle-explainer'`.

### 4. Image generation routes — fan-out to 3

Touch points:
- [src/app/api/thumbnails/image/route.ts](src/app/api/thumbnails/image/route.ts) — free-form single-image route
- `src/app/api/thumbnails/format/topic-card-grid/image/route.ts`
- `src/app/api/thumbnails/format/n-levels/image/route.ts`
- `src/app/api/thumbnails/format/flex-icon-grid/image/route.ts`
- **NEW** `src/app/api/thumbnails/format/doodle-explainer/concepts/route.ts` (LLM: 3 concept variations)
- **NEW** `src/app/api/thumbnails/format/doodle-explainer/image/route.ts` (image gen + fan-out)

**Single-route pattern** (used by all 5 image routes after the change):

```ts
const variantCount = Math.min(Math.max(body.variantCount ?? 3, 1), 3); // user can force 1 from Settings
// `body.prompts` is ThumbnailVariant[]-shaped input; the LLM step already produced N prompts.
const tasks = body.prompts.map((p, idx) => generateSingleImage({ prompt: p.promptUsed, model, refUrl }));
const results = await Promise.allSettled(tasks);
const variants: ThumbnailVariant[] = results.map((r, idx) => ({
  id: `v${idx}`,
  imageUrl: r.status === 'fulfilled' ? r.value.imageUrl : '',
  promptUsed: body.prompts[idx].promptUsed,
  conceptLabel: body.prompts[idx].conceptLabel,
  costEstimateUsd: r.status === 'fulfilled' ? r.value.cost : undefined,
}));
// Partial success: if at least 1 succeeded, return 200 with `failedCount`. If 0 succeeded, 500.
```

**Why `allSettled`**: if one of three image calls fails (Kie 503, OpenAI rate limit), the user still gets 2 variants instead of zero. Failed slots come back empty with `failedCount` in the response so the UI can show "1 of 3 failed — try again?"

**LLM step** for formats that have one (topic-card-grid Step 1, n-levels Step 1, doodle Step 1): structured-output call returning an array of 3 variations. Single LLM call, 3 distinct concepts.

### 5. Page UI

#### Format picker — add 5th format

[src/app/(app)/thumbnails/page.tsx](src/app/(app)/thumbnails/page.tsx) gets a `DoodleExplainerPanel` alongside `TopicCardGridPanel`, `NLevelsPanel`, `FlexIconGridPanel`. Lives at [src/components/thumbnails/DoodleExplainerPanel.tsx](src/components/thumbnails/DoodleExplainerPanel.tsx).

#### `VariantPicker` component — `src/components/thumbnails/VariantPicker.tsx` (new)

3-up grid (responsive: 3 columns on desktop, 1 column on mobile). Each variant card shows:
- The image (lazy-loaded, click to enlarge)
- The `conceptLabel` underneath
- Click anywhere on the card to select. Selected card gets a thick yellow border (mirroring the doodle style).
- "Regenerate this slot" button — replaces variant N without touching the others (rare path).
- Empty slot if generation failed: "Generation failed — Try again" button.

Reused by all five panels. Each panel renders `<VariantPicker variants={...} selectedIndex={...} onSelect={...} />` underneath its format-specific controls.

#### Save & restore

When the user picks a variant, the panel calls `updateThumbnailEntry({ formatPayload: { ...payload, selectedVariantIndex: idx } })`. Restoration reads `selectedVariantIndex` and shows the same picker with the same selection.

### 6. Settings (rule 15)

New section "Thumbnail variants" under existing thumbnails settings (or new section if none exists; check `src/lib/user-settings.ts` for the right home).

| Control | Default | Why |
|---|---|---|
| Variant count | 3 | The whole point of this feature |
| Default image model | Kie GPT Image 2 t2i (`gpt-image-2-t2i`) | Your choice |
| Default thumbnail style | (none) | Don't force a style on every generation |

Settings live in user settings, not in the doc — variant preference is a user habit, not a per-thumbnail setting.

### 7. Cost & rate limiting (rule 8, 13)

- Existing route rate limit (free-form): 5 req/min per IP at [src/app/api/thumbnails/image/route.ts:88](src/app/api/thumbnails/image/route.ts#L88). Keep as-is. 5 requests × 3 variants = 15 images/min/IP max. That's fine.
- Add per-route cost telemetry log: `console.info('[thumb-doodle image] cost', { variantCount, costPerImageEstimate, totalCostEstimate })`. Lets us notice cost overruns from logs.
- **Pre-implementation step**: verify Kie GPT Image 2 t2i price/image in the Kie console (Atlas comment says ~$0.009; Kie likely ~$0.02). If it's >$0.05/image we should reconsider the default to keep 3-variant cost reasonable.

### 8. Security (rule 13)

- All new routes go through the existing rate-limit + session middleware (proxy gate).
- LLM step accepts `hookText` and `customBackground` as user input. Treat both as **untrusted strings**:
  - Strip control chars
  - Cap length: hookText ≤ 60 chars (it's a 2-3 word hook), customBackground ≤ 200 chars
  - Refuse if they contain prompt-injection-shaped sequences (e.g. "ignore previous", "system:"). Soft check; reject with 400.
- Image route validates `prompts[].promptUsed` length ≤ 4000 chars (current code path's implicit limit).
- No new secrets. No new external services.

### 9. Observability (rule 14)

New log namespaces, following the existing `[thumb-*]` pattern:

- `[thumb-doodle concepts]` — LLM step: prompts requested, variants returned, token cost
- `[thumb-doodle image]` — fan-out: variantCount, per-variant success/fail/cost
- `[thumb-doodle variant-pick]` — user selected variant N
- `[thumb-format-grid image variants]` — variant fan-out logging on the existing grid route
- `[thumb-format-n-levels image variants]` — same for n-levels
- `[thumb-format-flex image variants]` — same for flex-icon
- `[thumb-variant-picker]` — client-side: render, select, regenerate-slot

Every log includes the variant count, the model id, and the failed-count where relevant.

### 10. Testing (rule 18)

New unit tests under `tests/`:

| File | What it covers |
|---|---|
| `tests/thumbnail-styles-registry.test.ts` | `resolveThumbnailStyle` returns correct entry, unknown id returns undefined, `paint_explainer_v1_doodle` exists with required fields |
| `tests/thumbnail-variants-shape.test.ts` | `ThumbnailVariant` round-trip through history payload serialization |
| `tests/doodle-explainer-prompt-builder.test.ts` | Hook text + expression + background → prompt contains the style suffix, contains the expression word, contains the hook |
| `tests/thumbnail-history-variants-restore.test.ts` | Old single-image entries restore with variants=undefined; new entries restore with full variants array and selectedVariantIndex respected |
| `tests/doodle-concepts-route.test.ts` | `/api/thumbnails/format/doodle-explainer/concepts` returns exactly 3 distinct concepts, schema-validates |
| `tests/thumbnail-image-variants-route.test.ts` | Fan-out: 3 successes → 3 variants; 1 failure → 2 variants + failedCount=1; 0 successes → 500 |
| `tests/variant-picker.test.tsx` | Renders 3 variants, click selects, selectedIndex updates, regenerate-slot fires the right callback |

For routes that hit external services, follow the existing test pattern — check `tests/thumbnail-saved-presets-validate.test.ts` for the project's preferred mocking shape.

## Files touched (full list)

**New**
- `src/lib/thumbnail-styles.ts`
- `src/lib/thumbnail-variants.ts`
- `src/components/thumbnails/DoodleExplainerPanel.tsx`
- `src/components/thumbnails/VariantPicker.tsx`
- `src/app/api/thumbnails/format/doodle-explainer/concepts/route.ts`
- `src/app/api/thumbnails/format/doodle-explainer/image/route.ts`
- `public/style-refs/Paint-explainer-thumbnails/` — copies of the 4 chosen refs from `Paint-explainer/`, kept separate so editing one doesn't disturb the production-doc style
- Seven test files (see §10)

**Modified**
- `src/lib/history.ts` — add `variants`/`selectedVariantIndex` to the three format payloads + new `DoodleExplainerHistoryPayload` + `'doodle-explainer'` in the format union
- `src/app/api/thumbnails/image/route.ts` — fan-out for free-form
- `src/app/api/thumbnails/format/topic-card-grid/image/route.ts` — fan-out
- `src/app/api/thumbnails/format/topic-card-grid/cards/route.ts` — LLM returns 3 card-layout variations (structured output)
- `src/app/api/thumbnails/format/n-levels/image/route.ts` — fan-out
- `src/app/api/thumbnails/format/n-levels/...` — LLM step returns 3 level variations
- `src/app/api/thumbnails/format/flex-icon-grid/image/route.ts` — fan-out
- `src/app/(app)/thumbnails/page.tsx` — wire `DoodleExplainerPanel`, mount `VariantPicker` underneath each format's render area
- `src/components/thumbnails/TopicCardGridPanel.tsx` — adopt `VariantPicker`
- `src/components/thumbnails/NLevelsPanel.tsx` — adopt `VariantPicker`
- `src/components/thumbnails/FlexIconGridPanel.tsx` — adopt `VariantPicker`
- `src/lib/user-settings.ts` — add `thumbnailVariantCount` + `thumbnailDefaultImageModel` + `thumbnailDefaultStyle`

## Rollout phasing

1. **Phase 1 (foundation, ships behind flag)**: registry + variants type + history schema changes + free-form route fan-out + `VariantPicker` component. No new format yet. Feature flag: `thumbnail_variants_enabled` defaulting off. Tests for everything in this phase pass before moving on.
2. **Phase 2 (doodle format)**: new concepts route + image route + panel + page integration. Doodle format gated behind same flag.
3. **Phase 3 (other formats adopt variants)**: topic-card-grid, n-levels, flex-icon-grid LLM steps return 3, image routes fan out, panels adopt `VariantPicker`.
4. **Phase 4 (flag flip)**: turn the flag on globally after manual QA across all formats. Keep flag in code for 2 weeks then remove.

Reason for the flag: rule 6 (extreme QA) — this touches every thumbnail flow at once. If any format breaks I want a one-line revert, not a multi-file rollback.

## QA pass (rule 6, applied at the end of each phase)

For each format:
- **Golden path**: generate → see 3 variants → pick one → save to history → restore → still shows 3, same one selected
- **Partial failure**: simulate 1-of-3 image fail → UI shows 2 variants + retry slot
- **Total failure**: all 3 fail → user sees the error, gets a Retry button, no partial entry saved
- **Re-pick after save**: open old entry, pick a different variant → entry updates → reload → new pick persists
- **Variant count = 1 (Settings)**: page renders 1 image (no picker), spends 1x cost
- **Old single-image entry**: opens correctly, no picker, still has download/regenerate
- **Mobile**: 3 variants stack vertically, picker still selectable

## Open questions — RESOLVED 2026-06-09

| # | Question | Answer |
|---|---|---|
| Q1 | Image model | **Kie GPT Image 2 (`gpt-image-2-t2i`)**, not Atlas. Confirmed. Working cost estimate ~$0.02/image until Kie console pricing is pulled at Phase 1 kickoff. |
| Q2 | Reference image bundle | **Fresh bundle curated from the YouTube channel referenced in chat.** Bundle lives at `public/style-refs/Paint-explainer-thumbnails/`. User to provide source thumbnails (10–15 candidates → curated down to 4–6 canonical refs). Used today as visual reference for the prompt-suffix author and for any future i2i fallback; t2i path doesn't pass them to the model. |
| Q3 | How distinct should the 3 LLM variations be | **All three**: different labels (hook phrasing), different palettes (within the style's accent set), AND different compositions (character placement, framing, prop choice). The LLM structured-output schema enforces a `variation_axes` field listing what each variant changes from the others. |
| Q4 | Where does the selected variant flow | **Both**: stays in the picker for re-selection AND feeds downstream into the schedule/post flow. Any code today that reads `formatPayload.imageUrl` switches to reading the helper `getSelectedVariantUrl(payload)` which prefers `variants[selectedIndex].imageUrl` and falls back to legacy `imageUrl`. |

### Follow-up tied to resolved answers

- **Q2 action item**: user provides source thumbnails (high-res JPG/PNG, ideally not screenshots) before Phase 2 kickoff. Drop into `public/style-refs/Paint-explainer-thumbnails/_raw/`; I curate down to 4–6 keepers in the parent folder. Off-style candidates go to `_review-not-paint-thumbs/` per project convention.
- **Q3 action item**: the LLM concept-generator schema gets a `variation_axes: { label_axis, palette_axis, composition_axis }` object per variant. Every variant must differ from every other on all 3 axes — schema-validated.
- **Q4 action item**: add `src/lib/thumbnail-variants.ts` helper `getSelectedVariantUrl(payload)` and migrate every existing `imageUrl` read site to it in Phase 1, so by the time Phase 4 lands, no consumer reads the raw `imageUrl` field directly.

## What success looks like

- Open the thumbnails page → see 5 formats (was 4) including "Doodle Explainer"
- Pick "Doodle Explainer" → type a hook ("ROTTEN MEAT?"), pick an expression (worried), pick a background (cave), generate
- 3 variants come back side-by-side, visibly distinct (different framings/poses)
- Click one → it gets a yellow border, the "Use this" download/post flow uses that one
- Generate on any other format → also see 3 variants
- Restart the page, open the history entry → see the same 3 with the same one pre-selected
- Toggle Settings → variants = 1 → next generation produces 1 image, no picker
