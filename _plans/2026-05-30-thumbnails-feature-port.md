# Thumbnails feature port: Flex Icon Grid -> Topic Card Grid + N Levels Explained

**Date:** 2026-05-30
**Author:** Claude (Opus 4.7)
**Status:** Approved by user, execution started
**Option chosen:** Option 1 of the three alternatives presented in chat

---

## Goal

Port the genuinely portable parts of Flex Icon Grid's user-facing feature surface to the two other thumbnail formats we are still investing in (Topic Card Grid, N Levels Explained), while retiring Free Form. The result: users get vignette, grain, image filters, a real title bar, workspace systems (saved presets, preview zoom, copy/paste style, export/import), and richer per-cell upload controls, on top of the AI-rendered images they already get.

## Goal in user-visible language

After this lands:

- A user renders a thumbnail in Topic Card Grid or N Levels, then tweaks vignette / grain / filter / title bar / fonts without paying for an AI re-render. Every adjustment runs through the Sharp pipeline only.
- A user saves a visual preset ("my channel's house style") and applies it across formats.
- A user clicks any cell in Topic Card Grid's per-cell upload, picks Cover / Contain / Fill, and picks a filter (none / grayscale / sepia / high-contrast / low-contrast / invert).
- A user picks Free Form from the format menu and sees a friendly "this format has moved" pointer to Topic Card Grid (existing drafts still open).

## Constraints

- **Vercel 300s budget.** Every new operation runs server-side in Sharp post-render. Sharp is fast (single decode + single encode for the composite call). All additions are O(canvas pixels), no new AI calls.
- **No new external services or paid APIs.** Vignette, grain, filters, and title bar overlays are all local Sharp passes. No new env vars, no new secrets, no new third-party calls.
- **Backwards compatibility.** Existing Topic Card Grid + N Levels drafts must render byte-identical when no new fields are set. The new pipeline is a no-op when its config is empty.
- **N Levels has a baked-in title bar today.** Adding an overlay title bar means swapping prompt path: when the overlay is active, set `showBottomTitle: false` so the LLM leaves edge-to-edge slices, then we paint the overlay. When the overlay is off, fall back to current LLM-baked behavior (no breakage for existing drafts).
- **Free Form gets grandfathered, not deleted.** Existing drafts must still open and render. The format only disappears from the new-thumbnail selector. Database rows are untouched.
- **No image-model contract changes.** The list of supported models, the prompt shape, the route signatures all stay the same. Only the post-render composite step grows.

## Architecture

Two new modules, three modified existing ones.

### New: `src/lib/thumbnail-formats/shared-overlay-pipeline.ts`

The shared Sharp pipeline that runs after the image model returns. Pure-ish module (uses Sharp, no React, no Next.js). Exposes one main function plus typed inputs.

Shape:

```ts
export interface SharedOverlayInput {
  baseImage: Buffer;
  canvas: { width: number; height: number };
  postProcess?: PostProcessConfig;
  titleBar?: TitleBarConfig;
}

export interface PostProcessConfig {
  filter?: 'grayscale' | 'sepia' | 'high-contrast' | 'low-contrast' | 'invert';
  vignette?: { color: string; intensity: number; radius: number };
  grain?: { intensity: number; size: number; monochrome: boolean };
}

export interface TitleBarConfig {
  text: string;
  subtitle?: string;
  position: 'top' | 'bottom' | 'overlay-top' | 'overlay-bottom';
  heightFraction: number; // 0.05 to 0.5 of canvas height
  align: 'left' | 'center' | 'right';
  subtitleAlign?: 'left' | 'center' | 'right' | 'match-title';
  backgroundColor: string;
  backgroundOpacity: number; // 0 to 1 — for overlay positions
  textColor: string;
  subtitleColor?: string;
  fontId: string;
  subtitleFontId?: string;
  shadow?: { offsetPx: number; blurPx: number; opacity: number; color: string };
}

export async function applySharedOverlays(input: SharedOverlayInput): Promise<Buffer>;
```

Implementation order inside the function: filter first (cheapest, sets the base tone), then vignette (additive over filtered image), then grain (final grain texture on top), then title bar (always on top of post-process).

The pipeline reuses Sharp's `composite()` model: one decode of the base image, all overlays accumulate into a single `.composite([...])` call. Each overlay (vignette gradient SVG, grain noise PNG, title bar SVG/text) is built independently, then added to the array.

### New: `src/lib/thumbnail-formats/n-levels-composite.ts`

Mirrors the role of `topic-card-grid-composite.ts` for N Levels. Today N Levels has no post-render step. This module gives it one, so we can call `applySharedOverlays` from inside it.

Shape:

```ts
export interface ApplyNLevelsOverlaysInput {
  baseImage: Buffer;
  layout: NLevelsLayout;
  postProcess?: PostProcessConfig;
  titleBar?: TitleBarConfig;
}

export async function applyNLevelsOverlays(input: ApplyNLevelsOverlaysInput): Promise<Buffer>;
```

Thin module: builds canvas dims from layout, delegates to `applySharedOverlays`. Exists to keep the N Levels route's call site symmetric with Topic Card Grid's `applyCellUploads`.

### Modified: `src/lib/thumbnail-formats/topic-card-grid-composite.ts`

Adds a new optional `postProcess` and `titleBar` field to `ApplyCellUploadsInput`. After the existing composite call (cell uploads + label bands), pipe the result through `applySharedOverlays`.

### Modified: `src/app/api/thumbnails/format/topic-card-grid/image/route.ts`

Accepts the new config fields in the request body, passes them to `applyCellUploads`. No prompt changes.

### Modified: `src/app/api/thumbnails/format/n-levels/image/route.ts`

Accepts the new config fields. When `titleBar` is present and the LLM-baked bottom title is also requested, the overlay wins (set `showBottomTitle: false` in the prompt and draw our own bar on top). When `titleBar` is absent, fall back to existing behavior.

### Modified panels

- `src/components/thumbnails/TopicCardGridPanel.tsx` — add Post-Process section, Title Bar section, Upload Fit/Filter pickers on existing per-cell upload editor.
- `src/components/thumbnails/NLevelsPanel.tsx` — add Post-Process section, Title Bar overlay section (alternative to the existing LLM-baked title).

### Modified format selector

- `src/app/(app)/thumbnails/page.tsx` — hide Free Form from the new-thumbnail dropdown. Existing drafts with `format: 'free-form'` still open and render through the legacy inline UI.

---

## Phases

### Phase 1: Shared overlay pipeline module + unit tests

Build the pure-ish `shared-overlay-pipeline.ts` first, with full unit test coverage. No format wiring yet. This is the foundation everything else builds on, so it gets tested in isolation.

Deliverables:
- `src/lib/thumbnail-formats/shared-overlay-pipeline.ts` with the four operations
- `src/lib/thumbnail-formats/n-levels-composite.ts` (thin wrapper)
- `src/lib/thumbnail-formats/__tests__/shared-overlay-pipeline.test.ts` covering:
  - empty config returns byte-identical PNG (no-op guarantee)
  - filter only: grayscale produces a grayscale image (sample center pixel)
  - vignette only: corner pixels darker than center pixel for intensity 0.5
  - grain only: variance increases vs base
  - title bar only: top/bottom positions render text in the correct band
  - filter + vignette + grain + title bar combination doesn't error
  - bounds clamping (intensity > 1 clamped, negative values clamped)
  - text sanitization for title text (no Pango injection)

### Phase 2: Bucket A wired into Topic Card Grid + N Levels

UI sections in both panels, persistence to draft state, wiring through routes.

Deliverables:
- `TopicCardGridPanel.tsx` Post-Process section (vignette toggle + intensity + radius + color, grain toggle + intensity + size + mono, filter chips)
- `NLevelsPanel.tsx` Post-Process section (same controls)
- Draft state extended with `postProcess?: PostProcessConfig`
- Both image routes accept and forward `postProcess`
- localStorage personal defaults per format
- Observability: `[topic-card-grid post-process]` and `[n-levels post-process]` log namespaces

### Phase 3: Bucket B title bar overlay

UI sections, prompt swap for N Levels, route wiring.

Deliverables:
- `TopicCardGridPanel.tsx` Title Bar section (toggle, text, subtitle, position, height%, align, colors, font, shadow)
- `NLevelsPanel.tsx` Title Bar Overlay section — with a clear "Use overlay (cheap to tweak)" vs "Use LLM-baked (requires re-render)" toggle
- N Levels route prompt logic: when overlay is active, force `showBottomTitle: false` in the image prompt
- Draft state extended with `titleBar?: TitleBarConfig`
- Workspace font picker reused from Flex Icon Grid's font registry
- Observability: `[topic-card-grid title-overlay]` and `[n-levels title-overlay]`

### Phase 4: Bucket C workspace systems

Saved presets per format, preview zoom on result image, copy/paste style, export/import.

Deliverables:
- New DB tables: `topic_card_grid_saved_presets`, `n_levels_saved_presets`
- New API routes: `/api/thumbnails/format/{topic-card-grid,n-levels}/saved-presets[/:id]`
- "Saved Presets" sections in both panels (load, save, delete, mirror Flex Icon Grid's pattern)
- Preview zoom on the rendered result image (50%–300%, custom ticks) in both panels
- Copy/paste style buttons (per-draft to clipboard, paste-style applies postProcess + titleBar only)
- Export/import: serialize draft state with version envelope, paste JSON to import
- Migration script under `migrations/`
- Observability: `[topic-card-grid saved-preset]`, `[n-levels saved-preset]`, plus user-action logs for copy/paste/export/import

### Phase 5: Bucket D Topic Card Grid upload fit + filter pickers

The narrowest, cheapest win. The existing `applyCellUploads` already does a `fit: 'cover'` resize per upload. Extend it to accept per-upload `fit` and `filter`.

Deliverables:
- `topic-card-grid.ts` types: per-cell upload carries `fit?: 'cover' | 'contain' | 'fill'` and `filter?: ImageFilter`
- `topic-card-grid-composite.ts` `fitCover` becomes `fitImage(bytes, w, h, fit)` and routes to the right Sharp resize strategy; filter applied as Sharp `.grayscale()` / tone curves / negate
- `TopicCardGridPanel.tsx` per-upload editor gains Fit chips (Cover/Contain/Fill) + Filter chips (None/Grayscale/Sepia/High-contrast/Low-contrast/Invert) with live swatch previews
- Route accepts the new fields and passes them to `applyCellUploads`
- Observability: `[topic-card-grid upload-fit]` logs `card_index`, `fit`, `filter`

### Phase 6: Free Form deprecation

Gentle deprecation. Existing drafts open and render; format hidden from new-thumbnail selector.

Deliverables:
- Format dropdown in `src/app/(app)/thumbnails/page.tsx` hides Free Form unless the loaded draft is Free Form
- Migration banner shown when a Free Form draft is opened: "This format is being retired — try Topic Card Grid for new thumbnails"
- The inline Free Form UI stays untouched for grandfathered drafts (no code deletion in this phase)
- Documentation note in `AGENTS.md`: Free Form is grandfathered-only
- Observability: `[thumbnails free-form-deprecated]` log on every Free Form draft open (so we can see how many users are affected over the next 30 days)

---

## Alternatives considered and rejected

### Option 2 (full port to all three formats including Free Form)
**Rejected because** Free Form has no format module, no panel component, no auto-pipeline integration, and has not been functionally touched since the other three formats shipped. Porting Buckets B and D to Free Form means inflating an already-massive page component for a format nobody is improving. Bucket A and C could land in Free Form cheaply, but the marginal user value over redirecting to Topic Card Grid is near zero.

### Option 3 (phase-by-bucket, re-evaluate after each bucket)
**Rejected because** the shared overlay pipeline (Phase 1) is the natural shared infrastructure for both Bucket A AND Bucket B. Building it incrementally as we discover each bucket creates rework. Committing to all four buckets up front lets the pipeline have a clean shape from day one.

### Rebuilding Topic Card Grid / N Levels as deterministic compositors
**Rejected because** the value proposition of those formats IS the LLM rendering quality. Users pick them because GPT Image 2 / Grok / Flux produce nicer-looking illustrations than we could compose deterministically. Rebuilding them as deterministic compositors loses the actual differentiation and turns them into Flex Icon Grid variants.

---

## Security

- **No new attack surface.** All changes are server-side Sharp pipelines. No new env vars, no new external API calls, no new file system writes outside the existing R2 upload pipeline.
- **User-controlled overlay text.** Title bar text and subtitle pass through Pango via Sharp. We reuse `escapePangoText` from `topic-card-grid-composite.ts` to escape `&`, `<`, `>` so a label like "AT&T" or "<3" renders as literal text instead of triggering Pango's parser. Length cap: 200 chars per line (matches existing label caps).
- **Font handling.** Title bar font picker reuses Flex Icon Grid's existing workspace font registry, which already validates uploads (TTF/OTF/WOFF/WOFF2 only, size cap, virus scan via existing pipeline). No new font upload surface.
- **Color inputs.** Hex color inputs go through existing color validation (`#[0-9a-fA-F]{6}` or `#[0-9a-fA-F]{8}`). Invalid colors fall back to a documented default (white for text, black for background), not unhandled errors.
- **Numeric inputs.** Vignette intensity, grain intensity, font size multiplier all clamped to documented ranges server-side. The UI clamps too, but server-side validation is authoritative.
- **Saved preset payloads.** Validated against JSON schemas (mirror Flex Icon Grid's `flex-icon-grid-saved-templates-validate.ts` pattern). Pre-stored preset payload size cap: 16KB per preset. Per-workspace preset count cap: 50 (matches Flex Icon Grid template cap).
- **Export/import JSON.** Versioned envelope. Imports validate against the current schema version; older versions trigger a migration step before applying.

---

## Observability

Per the global rule 14 standard. Every new operation gets a namespaced log with actual parameter values. Grep targets:

- `[shared-overlay filter]` — filter applied, before/after sizes, ms elapsed
- `[shared-overlay vignette]` — color, intensity, radius, ms elapsed
- `[shared-overlay grain]` — intensity, size, monochrome flag, ms elapsed
- `[shared-overlay title-bar]` — text length, subtitle length, position, height fraction, font_id, font_path_used, ms elapsed
- `[topic-card-grid post-process]` — postProcess config summary at route entry
- `[n-levels post-process]` — same
- `[topic-card-grid title-overlay]` — titleBar config summary at route entry
- `[n-levels title-overlay]` — same, plus `llm_baked_title: 'enabled' | 'overridden-by-overlay'`
- `[topic-card-grid upload-fit]` — card_index, fit, filter, source dims, target dims
- `[topic-card-grid saved-preset]` — action (`load` | `save` | `delete`), preset_id, payload_bytes
- `[n-levels saved-preset]` — same
- `[thumbnails free-form-deprecated]` — draft_id, opened_at

All logs use the project's standard `console.info('[namespace step]', { ...values })` pattern. Values are real (booleans with values, not just "X happened").

---

## Settings

Per the global rule 15 audit. Every new feature ships with a Settings position.

**Personal defaults (localStorage, per-user):**
- `topic-card-grid:default-vignette-intensity` — number 0 to 1, default 0
- `topic-card-grid:default-grain-intensity` — number 0 to 1, default 0
- `topic-card-grid:default-filter` — string filter id, default `'none'`
- `topic-card-grid:default-title-bar-font-id` — string, default first bundled font
- `n-levels:default-vignette-intensity` — same shape
- `n-levels:default-grain-intensity` — same shape
- `n-levels:default-filter` — same shape
- `n-levels:default-title-bar-font-id` — same shape

**Workspace-level (DB, shared across users in workspace):**
- Saved presets per format (`topic_card_grid_saved_presets`, `n_levels_saved_presets`)
- Existing Flex Icon Grid font registry is reused as-is (already cross-format-ready)

**Intentionally NOT exposed and why:**
- Per-cell rotation, per-cell shape — these are deterministic-render features that don't apply when the cell content is rasterized by the image model.
- Cell shadow / cell outer stroke / ring — same reason.
- Brightness / detail / style controls remain format-specific (already present in Topic Card Grid and N Levels). We don't unify them across formats because they tune the image-model prompt, not a post-render step.

---

## Testing

Per the global rule 18 standard. Every code change ships with unit tests; run the full relevant suite before any phase is called done.

**Unit (Vitest):**
- `shared-overlay-pipeline.test.ts` — see Phase 1 deliverables
- `n-levels-composite.test.ts` — thin wrapper smoke test (passes config through correctly)
- Extensions to `topic-card-grid-composite.test.ts` covering new `fit` strategies and filter chain
- Title bar overlay layout math test (alignment, multi-line wrap, height clamping)
- Pango escape test for title bar text (covers `&`, `<`, `>`, and combinations)
- Bounds clamping tests (intensity > 1, negative values, empty strings)

**Integration:**
- Topic Card Grid image route: post-render new config produces a different PNG hash than no-config; no-config produces byte-identical PNG to the pre-change behavior (regression guard)
- N Levels image route: with `titleBar` set, prompt is rebuilt with `showBottomTitle: false` (snapshot test)
- N Levels image route: without `titleBar`, prompt behavior is unchanged (regression guard)

**Visual regression (manual, documented in phase PRs):**
- Render a Topic Card Grid sample with each new feature toggled on/off and eyeball the result vs. a baseline
- Render an N Levels sample with overlay title bar vs. LLM-baked title bar; verify both look sensible
- Repeat for upload fit modes (cover/contain/fill) and filters

**Untestable scope flagged in advance:**
- The exact pixel output of vignette + grain is deterministic but visually subjective; we test the math (corner darker than center for vignette, variance increase for grain) not the aesthetic.
- The image-model output itself is non-deterministic; we test our pipeline assuming the model returns whatever it returns.

---

## UX Walk-through (per the lazy user lens, rule 10)

**Scenario 1: User wants to add a vignette to an existing Topic Card Grid render.**
1. User opens the thumbnail draft. Render already exists.
2. User scrolls the panel to "Post-Process" section. Sees three controls: Filter chips, Vignette toggle, Grain toggle.
3. User clicks Vignette toggle. A sub-section appears with three sliders (intensity, radius, color picker).
4. User drags the intensity slider. The result image updates within ~500ms (Sharp pipeline only, no AI re-render).
5. User is happy. The change is auto-persisted in the draft.

**Scenario 2: User wants a title bar over their N Levels render.**
1. User opens an N Levels draft. The bottom 30% of the image has the existing LLM-baked title bar.
2. User scrolls to the new "Title Bar Overlay" section.
3. User sees a callout: "Adding an overlay title bar will re-render without the LLM's bottom title bar. The slices will fill the whole canvas, and your overlay text will be drawn on top. This requires one AI re-render."
4. User clicks "Use overlay". Toggle flips, the render goes through. After the re-render, the LLM-baked title bar is gone and the slices fill the canvas.
5. User now tweaks overlay text, font, position, color, shadow. Each tweak runs through Sharp only (cheap).

**Scenario 3: User wants to switch back from overlay to LLM-baked title bar.**
1. User clicks "Use LLM-baked". Toggle flips back.
2. The result image becomes stale (the cached LLM render has no title bar). Panel shows a "Re-render needed" affordance with a button.
3. User clicks "Re-render". Pays for one AI call, gets the baked-in title back.

**Scenario 4: User opens an old Free Form draft.**
1. User opens a saved Free Form thumbnail. It loads through the existing inline UI.
2. A banner at the top says "Free Form is being retired. Try Topic Card Grid for new thumbnails." with a "Don't show again" dismissal.
3. User can still tweak and re-render the existing draft.
4. When the user creates a new thumbnail from the dropdown, Free Form is not an option.

---

## Open questions

These are checkpoints I'll surface as I hit them, not blockers to start:

1. **Should saved presets be per-format or unified across formats?** My current pick: per-format. A "house style" preset for Topic Card Grid wouldn't sensibly map onto N Levels (different layout). User can confirm or override when we hit Phase 4.
2. **Should Free Form's deprecation banner be dismissible permanently or per-session?** Per-session is the safer default; permanent dismissal risks the user forgetting they're on a deprecated format. User can override.
3. **Title bar font upload limit.** Flex Icon Grid's workspace font registry has a per-workspace font count cap. Reusing it means the cap is shared. If a user hits the cap from Topic Card Grid uploads, do they get a clear "you're at the workspace cap of N fonts" message? Will verify and surface in Phase 3.
4. **Vercel cold-start impact of Sharp's expanded pipeline.** Sharp is already loaded for `applyCellUploads`. Adding `applySharedOverlays` doesn't add new native deps. Should still measure cold-start time before and after Phase 2 in production logs.
5. **Migration of existing Topic Card Grid drafts.** None needed — new fields are optional, no defaults are applied retroactively. Verified by Phase 2's "empty config = no-op" test.

---

## Rollback plan

Every phase is independently revertable:

- **Phase 1** ships only a new module + tests. No format wiring. Revert = delete the module. No user-visible change to roll back.
- **Phase 2-5** each add UI sections + route fields. Routes treat new fields as optional and default to no-op. Reverting a phase = remove UI section + remove route handling. Existing drafts continue working because the route still ignores the field.
- **Phase 6** can be reverted by un-hiding Free Form from the dropdown. Existing inline UI was never touched.

If any phase produces a regression we can't quickly fix: the format's image route's post-render call to `applySharedOverlays` is a one-line `if (input.postProcess || input.titleBar)` guard. Setting it to `if (false)` immediately disables the new pipeline without a code revert.

---

## Notes for future Claude sessions

This plan was approved on 2026-05-30 after a thorough gap analysis showed that roughly half of Flex Icon Grid's feature surface is deterministic-SVG-only and cannot port to LLM-driven formats. The portable subset is grouped into four buckets (A through D in the plan above). The non-portable subset is intentionally out of scope and should stay out of scope unless we rebuild Topic Card Grid or N Levels as deterministic compositors (which is a different, much larger project).

The shared overlay pipeline is the keystone. Every other phase builds on its config shape. If you need to extend it (e.g. add a new post-process effect), add to the `PostProcessConfig` interface and the `applySharedOverlays` switch, then propagate the new field through the two route signatures and both panel UI sections. Logs go in at the operation level so we can see exactly what was applied per request.

The Free Form deprecation in Phase 6 is deliberately gentle. Existing drafts still open and render. If a user pushes back, we can un-hide the format with a one-line change.
