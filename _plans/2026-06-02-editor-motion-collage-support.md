# Editor motion-collage support (full parity with production-doc)

**Date:** 2026-06-02
**Status:** awaiting sign-off
**Owner:** Claude + user

## 1. Goal

When a user opens the shot-graph editor at `/edit/[projectId]` for a `doodle_explainer_2` production-doc, every `shot_kind === 'motion_collage'` row must look and edit the same way it does in the production-doc page. Today it silently collapses to a regular static shot in the editor UI — the data is preserved end-to-end and the renderer plays the collage correctly, but the editor surface (left rail, timeline, inspector) was built before motion collages existed and has zero awareness of them. Users can't tell that the next render will animate, and they can't edit panels without bouncing back to production-doc.

## 2. Why now

The user filed this verbatim: *"when opening the editor from production-doc, all motion collages are gone! It must support that as well! with all option and features!"* The fact that the data is intact and the renderer is fine doesn't matter — the editor is the surface they spend time in, and a 250-shot video full of "broken-looking" collages erodes trust in the whole editor.

This is a Rule 10 problem (build for a lazy user): a feature that's technically correct but invisibly broken at the UI level is worse than a feature that's missing. A user looking at a single-image thumbnail has no reason to believe a collage will animate on render.

## 3. Scope

**In scope — `shot_kind === 'motion_collage'` (doodle_explainer_2):**

- Left-rail Shots tab: per-row thumbnail shows the panel grid like production-doc's `ImageCell` does.
- Timeline strip thumbnails: same.
- Right-panel Shot inspector: gates on `shot_kind`. For motion_collage shots, replace the static-shot UI ("Replace image", "Animate this shot — Kling") with a motion-collage panel editor (grid picker, per-panel prompts, per-panel regenerate, per-panel upload, per-panel lightbox, "Generate all panels", "Revert to regular row").
- Doc-level motion-collage settings (`doodle_explainer_2_motion_collage_settings`) editable from the inspector kebab menu — same fields production-doc exposes.
- Convert-to-motion-collage: from a regular Animation row, let the user flip it to motion_collage and pick a grid (same affordance production-doc has). This was implicit in "all options and features."
- Lightbox preview: clicking the grid thumbnail opens the same `ImageLightbox` (panel scrubber) used in production-doc.

**Out of scope (explicitly deferred — separate ticket):**

- `shot_kind === 'motion'` (paint_explainer_v1 motion beats). The user picked "doodle_explainer_2 (motion_collage)" in alignment, so I'm scoping this PR to motion_collage only. We'll write a follow-up plan for paint_explainer_v1 once this lands and gets a real-doc QA pass — same architecture, different inspector content.
- New features beyond production-doc parity. If production-doc doesn't have it, the editor doesn't get it here either. Parity is the contract.

## 4. Constraints

- **No regression on static shots.** The current inspector behavior for `shot_kind === undefined` / `'static'` / `'hard_cut'` must stay byte-identical. Every change is additive, gated on `shot.shot_kind === 'motion_collage'`.
- **No new persistence path.** Every field already round-trips through `ProjectPayload` (the doc JSONB is preserved verbatim). Edits dispatch through the existing `PATCH_ROW` and `PATCH_DOC` commands; no new endpoint, no new column.
- **Image generation calls the existing endpoint.** `POST /api/generate/production-doc/motion-collage` already exists, accepts `grid` + `panelPrompts` + `motionCollageSettings`, returns `{ imageUrl, panelUrls, collageImageUrl, costUsd }`. The editor calls it the same way production-doc does. No new server code.
- **Renderer untouched.** `SceneRouter` at `src/remotion/compositions/YouTubeVideo.tsx:521` already routes motion_collage to `<MotionCollageScene>`. Nothing in `src/remotion/**` changes.
- **Lift, don't duplicate.** `MotionCollageRowEditor` and `DoodleExplainer2MotionCollageSettingsPanel` already exist as standalone components under `src/components/production-doc/`. The editor imports them as-is. No fork.

## 5. Requirements (user-facing)

UX walkthrough for the lazy user (Rule 10):

1. User opens a doodle_explainer_2 doc in the editor. **First glance:** any motion-collage shot in the left rail shows a 2×2 / 3×2 / 3×3 mini grid of its keyframes, exactly like production-doc. No more single-thumbnail disguise.
2. **Timeline strip:** same grid. The shot pill still spans its duration, but the thumbnail inside is the grid, not one panel.
3. **Click a motion-collage shot.** The Shot inspector swaps the "Replace image / Animate this shot / Generate animation" block for a motion-collage panel editor:
   - Grid picker (2×2 / 3×2 / 2×3 / 3×3 / 4×3 / 4×4), highlighted-current.
   - N panel rows below, each with: panel label ("top-left", "row 2, col 1", etc.), prompt textarea, current thumbnail, per-panel "↻ Regenerate", "✎ Edit", "⬆ Upload".
   - "Generate all panels" button at the top — fires the full grid regen.
   - "← Revert to regular row" link at the bottom — flips back to a static Animation row.
4. **Doc-level settings (kebab menu):** "Motion collage settings" entry opens the existing panel — frame duration min/max, max panels, allow toggle.
5. **Click a static shot:** unchanged. The static-shot UI shows exactly as before.
6. **Empty state — panels not yet generated:** the grid cell shows a placeholder ("Panel 1 — not generated") with a "Generate this panel" button. The Player preview falls back to single image (MotionCollageScene already handles this).
7. **Convert a regular Animation row to motion_collage:** the inspector's `InspectorShotTypePanel` gets a new entry under "Visual type" → "Animation" → "Motion collage (N panels)" sub-picker. Picking it flips `shot_kind` and seeds a default 2×2 grid with empty prompts. Mirror production-doc's flow.
8. **Refresh / leave and come back:** every edit auto-saves through `useEditorStore` → debounced `/api/edit/[id]` PATCH. Same path as every other edit in the editor today.

## 6. Approach (chosen)

### 6.1 Components — lift the existing production-doc components

Two components already exist and are well-tested:

- `src/components/production-doc/MotionCollageRowEditor.tsx` — grid picker + N panel-prompt textareas + revert. 208 lines.
- `src/components/production-doc/DoodleExplainer2MotionCollageSettingsPanel.tsx` — doc-level settings. 233 lines.

The editor imports both verbatim. No code duplication, no fork. The components are already presentation-only and take props (no hidden coupling to production-doc page state).

### 6.2 New components — only one wrapper

`src/components/editor/inspector/InspectorMotionCollagePanel.tsx`:
- Top-level wrapper that branches on `shot.shotKind === 'motion_collage'`.
- Composes `MotionCollageRowEditor` + a panels list (each cell with thumbnail + actions).
- Wires the per-panel actions to the editor's `mutate()` helper (same one the existing inspector uses for image regenerate).
- Wires grid / prompt changes to `dispatch({ type: 'PATCH_ROW', rowIndex, patch: { motion_collage_grid, motion_collage_panel_prompts, image_url: undefined, motion_collage_panel_urls: undefined } })`. Clearing image_url + panel_urls matches the production-doc behavior on grid/prompt edit (next generate is fresh).

`src/components/editor/MotionCollageThumb.tsx`:
- Tiny presentation component. Props: `panelUrls: readonly string[] | undefined`, `grid: { cols, rows } | undefined`, `fallbackImageUrl: string | undefined`, plus size knobs.
- Renders the N-panel CSS grid when `panelUrls.length > 1`, otherwise falls back to a single `<img>`. Same logic as ImageCell, extracted into a reusable shape.
- Used by `ShotsTab` (left rail) AND the Timeline strip thumbnails AND inside the inspector preview.

### 6.3 Edits to existing files

- **`src/components/editor/leftrail/ShotsTab.tsx`** — swap the `<img src={thumb}>` block (lines 117-136) for `<MotionCollageThumb panelUrls={row.motion_collage_panel_urls} grid={row.motion_collage_grid} fallbackImageUrl={thumb} />`. Same dimensions, same lazy-loading.
- **`src/components/editor/Timeline.tsx` + `src/components/editor/timeline-v2/TimelineV2.tsx`** — same swap wherever they render per-shot thumbnails from `rowImages[i]`.
- **`src/components/editor/ShotInspector.tsx`** — add the motion-collage branch near the top of the body: `if (shot.shotKind === 'motion_collage') return <InspectorMotionCollagePanel ... />`. The existing static-shot body stays under the else.
- **`src/components/editor/inspector/InspectorShotTypePanel.tsx`** — add "Motion collage" sub-option under "Animation" (mirroring production-doc).
- **`src/app/(app)/edit/[projectId]/EditorClient.tsx`** — wire the new inspector panel (props pass-through + per-panel API call helper), and add the kebab menu entry for doc-level motion-collage settings.

### 6.4 Image-generation endpoints (no new code)

- **Full grid regenerate:** `POST /api/generate/production-doc/motion-collage` with the row's grid + panelPrompts + the doc's settings. Returns panel URLs.
- **Single-panel regenerate:** there's no current per-panel endpoint. We need ONE of:
  - **Option A (preferred):** extend the existing endpoint to accept an optional `panelIndices: number[]` filter — server regenerates only those panels and merges into the existing array. Small server change, additive.
  - **Option B:** call the full-grid endpoint and discard untouched panels client-side. Wasteful but no server work.
  - **Recommendation:** Option A. The user said "all options and features"; per-panel regen is one of the obvious features production-doc users want but currently can't get. The change is ~30 lines in the route handler + the underlying `generateMotionCollage` helper.
  - **Open question for user — see §11.**

### 6.5 Undo / redo

Existing `PATCH_ROW` already supports arbitrary row patches with inverse-snapshot. Every motion-collage edit (grid change, prompt edit, panel-url update after gen) flows through it. No new commands; undo / redo "just works."

## 7. Alternatives considered & rejected

**Alt A — duplicate the production-doc UI inside the editor.**
Copy the `MotionCollageRowEditor` body into `ShotInspector.tsx`. Rejected: violates Rule 2 (clean / ordered), introduces drift the first time production-doc's editor evolves, doubles the bug surface. The existing component is already a standalone presentation component with a clean props interface; lifting it costs us nothing.

**Alt B — read-only display in the editor, "Edit panels in production-doc" link.**
Show the grid thumbnails everywhere, but for editing, link back to production-doc. Rejected: violates the user's explicit ask ("all option and features"), bad UX (forces page-jump for a common edit), and the editor's whole reason for being is that it's the unified working surface. Read-only is a step down.

**Alt C — write a new shared `MotionCollageEditor` package.**
Extract a tiny package that both production-doc and the editor consume. Rejected as over-engineering for v1: the existing component already IS the shared dependency once we import it from `src/components/production-doc/`. If a third consumer ever shows up we can promote the path later. Premature abstractions (rule from the system prompt) are a tax we don't need.

**Alt D — defer until paint_explainer_v1 motion support is also ready.**
Build both together. Rejected: shipping motion_collage now solves the user's actual reported problem (the screenshot was a doodle_explainer_2 doc), and motion (paint_explainer_v1) has its own surface area that's bigger and not yet fully baked. Pairing them doubles the risk; shipping them in two passes lets each get its own QA.

**Recommendation: ship 6.x as described. Defer A/C/D outright. Decide A vs B on per-panel regen — see §11.**

## 8. Security & safety (Rule 13)

- **Auth boundary:** existing `/api/generate/production-doc/motion-collage` route already requires the user's session and matches `historyEntryId` against their workspace. No new boundary.
- **Input validation:** the route already validates grid bounds (cols × rows ≤ 16 via `MAX_COLLAGE_CELLS`), panel-prompts length === cols × rows, settings bounds clamped by `resolveDoodleExplainer2MotionCollageSettings`. We piggyback — no new client-trusted inputs.
- **URL safety:** every generated panel URL goes through R2 / Vercel Blob; the existing `isSafeAssetUrl` boundary check in `ProjectPayload.migratePayload` already strips `javascript:` / `data:` / `vbscript:` schemes before they reach state. Per-panel URLs flow through the same migrator field (`doc.rows[i].motion_collage_panel_urls`) — they're part of the doc JSONB, validated implicitly when the row is migrated.
- **Defense in depth:** the per-panel regenerate endpoint (Option A) MUST validate `panelIndices` is an integer array, every index `0 <= idx < cols * rows`, and length <= cols * rows. Reject otherwise with 400. Same code path as the full-grid regen's grid validation. Add the check before the function decides what to regenerate.
- **No PII / no secret leakage in logs.** Panel prompts may contain user-authored creative text but that's the same surface as the existing AI prompt field; treated the same way.

## 9. Observability (Rule 14)

Every step gets a namespaced log. Grep target: `[editor motion-collage]`.

Client-side:
- `[editor motion-collage thumb]` — fired once per render when MotionCollageThumb decides grid vs fallback. Log `{ shotIndex, panelCount, gridCols, gridRows, fallbackToSingle: bool }`. Capped to first 10 shots per session.
- `[editor motion-collage convert]` — `{ shotIndex, from: 'static'|'animation'|..., grid }` when user flips a row to motion_collage.
- `[editor motion-collage panels patch]` — `{ shotIndex, changed: 'grid'|'prompts'|'both', newPanelCount, clearedFields: ['image_url', 'motion_collage_panel_urls'] }` on grid/prompt change.
- `[editor motion-collage gen kickoff]` — `{ shotIndex, mode: 'all'|'one', panelIndex?, grid, settings }` on Generate.
- `[editor motion-collage gen result]` — `{ shotIndex, success: bool, panelUrlCount, costUsd, errorMessage? }`.
- `[editor motion-collage revert]` — `{ shotIndex, hadPanelUrls }` when revert-to-regular is clicked.
- `[editor motion-collage settings]` — `{ field, oldValue, newValue }` per setting change in the kebab panel.

Server-side: the existing route already logs `[production-doc motion-collage]`. We add `[production-doc motion-collage partial]` for the per-panel branch (Option A) with `{ panelIndices, regeneratedCount }`.

Bar: when a user reports "regen failed", they paste their console, and I can point at the exact step that broke. Today the editor has no motion-collage logs at all.

## 10. Testing (Rule 18)

Test framework: Vitest is already wired (per `tests/script-titles-heuristic.test.ts`). New tests go in `tests/` mirroring existing structure.

**Unit tests:**
- `tests/editor-motion-collage-thumb.test.tsx` — `MotionCollageThumb` renders an N-cell grid when `panelUrls.length > 1`; renders a single `<img>` when length === 1 or undefined; renders the fallback when both are missing; respects grid prop; derives a square-ish grid when grid is absent.
- `tests/inspector-motion-collage-panel.test.tsx` — branches on `shot.shotKind === 'motion_collage'`; grid change dispatches `PATCH_ROW` with cleared image_url + panel_urls; prompt change patches without clearing if grid unchanged; revert dispatches PATCH_ROW that zeros every motion_collage_* field AND shot_kind; per-panel regen calls the endpoint with the right panelIndices (Option A) or full grid (Option B).
- `tests/editor-shot-kind-inspector-routing.test.tsx` — given `shotKind === 'motion_collage'`, ShotInspector mounts InspectorMotionCollagePanel and NOT the static-shot replace/animate UI. Given undefined / 'static' / 'hard_cut', the static-shot UI mounts as before.
- `tests/production-doc-image-gen-partial.test.ts` (Option A only) — `generateMotionCollage` with `panelIndices` regenerates only those indices and merges them into the prior array.
- **Regression — bug fix test:** `tests/editor-shots-tab-motion-collage.test.tsx` — a row with `motion_collage_panel_urls.length === 4` renders a 2×2 grid (proves the bug-fix path).

**Integration / E2E (deferred, manual QA acceptable):**
- Open a real doodle_explainer_2 history entry in the editor. Verify thumbnails, inspector, generate, undo / redo, save, refresh, open the rendered MP4. The user signs off on this manually before merge.

**Coverage explicitly out of scope:**
- Visual regression on the grid layout — relies on real images. Manual.
- The renderer's MotionCollageScene — unchanged, already covered.

## 11. Cost implications (Rule 8)

Image-gen cost matters. The motion_collage endpoint hits an image model per panel, billed by panel count (cols × rows). Per-panel regen lets users pay for one panel instead of N, which is a meaningful cost win for "I just need to fix this one cell."

**Need to verify current pricing before implementing.** Image-models prices change. Per Rule 1 + 8, I'll fetch current pricing for the default image model (`atlas-cloud-image-provider` looks current from plans dir) before I write the per-panel branch. Numbers will land in the PR description, not this plan.

User decision needed (§13 Q1): per-panel regen, yes/no?

## 12. Settings audit (Rule 15)

What's newly user-facing, and where does it live in the settings layer?

- **Per-row settings** (already exist on row): grid, panel prompts. Surfaced inline in the inspector — no global setting needed.
- **Doc-level settings** (`doc.doodle_explainer_2_motion_collage_settings`): allow toggle, max panels, min/max per-frame ms. These already exist in production-doc's kebab panel. We mount the SAME panel from the editor's inspector kebab → "Motion collage settings".
- **Workspace-level settings**: none required. Defaults are already coded into `resolveDoodleExplainer2MotionCollageSettings`. Adding workspace defaults for these is a follow-up if a user asks.
- **Default grid on convert**: hardcoded 2×2. Decided not to expose as a setting — the inspector lets the user change it in one click. Three clever knobs would beat one obvious one (Rule 15: prefer one obvious knob).

## 13. Open questions — RESOLVED 2026-06-02

**Q1. Per-panel regenerate — RESOLVED: Option A.**
Server extends `/api/generate/production-doc/motion-collage` to accept optional `panelIndices: number[]`. When present, regenerate only those panels and merge into the row's existing `motion_collage_panel_urls`. Same `MAX_COLLAGE_CELLS` bound, each index validated as `0 <= idx < cols*rows`.

**Q2. Convert-to-motion-collage entry point — RESOLVED: explicit button in inspector body.**
Not via `InspectorShotTypePanel`. The inspector body gets a "Convert to motion collage" button on rows where `shot_kind` is undefined / `'static'`. Click → seeds a 2×2 grid with empty prompts, sets `shot_kind = 'motion_collage'`, sets `visual_type = 'Animation'`, clears `image_url`. Then the inspector re-routes to the motion-collage panel via the §6.3 ShotInspector branch. Symmetric "Revert to regular row" already lives inside `MotionCollageRowEditor`.

**Q3. Lightbox — RESOLVED: editor-native, shows ALL panel images PLUS the composed collage image.**
New component `src/components/editor/MotionCollageLightbox.tsx`. Layout: grid of all N panel thumbnails on the left, the composed collage (`row.motion_collage_image_url` — the N×M stitched image the pipeline already saves) prominent on the right, click a thumb to enlarge it in place. Arrow keys cycle through panels. Esc closes. Don't reuse production-doc's `ImageLightbox` — the editor needs the composed-collage view too, which `ImageLightbox` doesn't show.

## 14. Implementation order (PR breakdown)

Each PR self-contained, mergeable, doesn't regress on the previous one. After each PR I run the test suite + manual smoke on a real doc before opening the next.

1. **PR 1 — thumbnails.** `MotionCollageThumb` component + plug into `ShotsTab`, `Timeline`, `TimelineV2`. Unit tests. No behavior change in the inspector; this is the visual-only fix that makes the screenshot stop lying. ⭐ smallest, highest-leverage.
2. **PR 2 — server per-panel regen (Option A).** Extend `/api/generate/production-doc/motion-collage` to accept `panelIndices?: number[]` and extend `generateMotionCollage` likewise. Server unit tests. Lands before the inspector so the inspector can wire to the final endpoint shape on first try.
3. **PR 3 — inspector branch.** `InspectorMotionCollagePanel` + `MotionCollageLightbox` (editor-native, shows all panels + composed collage). Wires grid edits, prompt edits, full-grid generate, per-panel generate, revert. Mounts via the `shot.shotKind === 'motion_collage'` branch in `ShotInspector`. Tests.
4. **PR 4 — convert-to-motion-collage button.** Add the explicit "Convert to motion collage" button in the inspector body for static / undefined shot_kind rows. Tests.
5. **PR 5 — doc-level settings in editor kebab.** Mount `DoodleExplainer2MotionCollageSettingsPanel` from the inspector kebab. Tests.
6. **Follow-up plan — paint_explainer_v1 (`shot_kind === 'motion'`).** Separate document. Same architecture.

## 15. Acceptance — done means

- Every motion_collage thumbnail in the editor shows its panel grid (left rail + timeline).
- Inspector for a motion_collage shot lets the user: change grid, edit prompts, generate all, generate one (if Q1=A), revert.
- Doc-level motion-collage settings editable from the inspector kebab.
- Convert a regular Animation row → motion_collage in one click from the inspector.
- Render an MP4 from the editor on a real doodle_explainer_2 doc → output plays the collage exactly as if rendered from production-doc.
- Undo/redo round-trips every motion-collage edit.
- `npm test` is green; all new unit tests pass; no regression in existing tests.
- A user opening a 250-shot doodle_explainer_2 doc cannot tell from the UI alone that the editor was ever motion-collage-blind.
