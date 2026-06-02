# Editor on-screen-text: bake→overlay flip, yellow styling, mode control, drag-and-drop multi-block

**Date:** 2026-06-02
**Status:** awaiting sign-off — see §16 cost gate
**Owner:** Claude + user

## 1. Goal

After diagnosis (2026-06-02), the actual problem is **broader than the original brief**. Confirmed findings:

- The "FATAL ERROR" lower-third in your screenshot is **baked into the AI image pixels**, not overlaid by Remotion. Confirmed: no `[lower-third variant resolved]` log appears in the browser console for that shot, which means `<LowerThird>` was never mounted — the text came from the image-generation model.
- The editor's inspector has **no OST mode control at all** today. Users cannot pick between `'bake'` / `'overlay'` / `'none'` from the editor — only from production-doc. So even after the renderer is fixed, the editor can't drive the choice.
- The auto-flip from `bake` to `overlay` for doodle_explainer_2 docs only fires when `doc.style_preset === 'doodle_explainer_2'` (literal slug) AND it only runs on the production-doc page ([production-doc/page.tsx:2629-2636](src/app/(app)/production-doc/page.tsx#L2629-L2636)). Saved styles with `based_on_built_in = 'doodle_explainer_2'` (UUID, not slug) silently fall through to `'bake'`.
- The `<LowerThird>` yellow-variant resolver in SceneRouter ([YouTubeVideo.tsx:473-476](src/remotion/compositions/YouTubeVideo.tsx#L473-L476)) has the same hardcoded-slug bug. Same root cause as the OST-mode auto-flip.
- The user wants **multiple OST blocks per shot, drag-and-drop anywhere**. Today there's exactly one OST text per shot, anchored to a few preset zones via `overlay_zone`.

So the work has FIVE parts, not two:

- **Part A — fix the upstream slug check** so saved-style UUIDs derived from doodle / paint resolve to their built-in parent. Unblocks every other downstream check.
- **Part B — editor OST mode control.** Inspector picker for `bake / overlay / none` per row + doc-level default toggle. This is the "I don't even have an option to choose a mode" gap.
- **Part C — "Flip doc to overlay" action** that batch-regenerates every row whose current mode resolves to `'bake'` AND carries `on_screen_text`. Costs real image-gen money (§16). After regen, images come back clean and the renderer mounts the yellow `<LowerThird>` overlay on top.
- **Part D — multi-block, drag-and-drop OST.** Multiple text blocks per shot, each independently placeable via drag on the Player surface.
- **Part E — observability + tests** so the next instance of this class of bug self-reports.

## 2. Why now

The "FATAL ERROR" screenshot shows a yellow-doodle-style video using the wrong text treatment — visible from frame one. Rule 16 (UI must look clean, intentional, polished): a video that markets itself as hand-drawn doodle and then mounts a corporate red-accent news-ticker bar reads as broken. The user is on a 250-shot project; they can't ship until this is fixed.

The drag-and-drop ask isn't urgent in the same way, but the user has been hitting the OST-position ceiling in production-doc for a while (overlay_zone is N preset positions, no fine control). Solving it once, properly, in the editor unlocks every project going forward.

## 3. Scope

### 3.1 Part A — yellow-variant bug fix

**In scope:**
- Find the actual reason `config.styleId` isn't matching `'doodle_explainer_2'` (or `'paint_explainer_v1'`) in the rendered editor preview.
- Fix the wiring so saved styles derived from a yellow-OST built-in also resolve to the yellow variant.
- Cover the same fix in the production-doc preview path so both surfaces stay consistent.
- Add a deliberate diagnostic surface so this class of bug self-reports next time.

**Out of scope:**
- Designing new lower-third variants (e.g. a third "neon" or "subtitle" style). One bug, one fix.

### 3.2 Part B — multi-block, drag-and-drop OST

**In scope:**
- New per-row data shape: `row.text_overlays?: TextOverlay[]`. Each entry has its own text, x/y position (as percentages of the 1920×1080 canvas), font scale, color/variant, and rotation. Legacy `row.on_screen_text` still works as the first overlay (zero-migration).
- Editor UI on the Remotion player surface: drag any text block with the mouse; arrow keys nudge; Shift+drag constrains to one axis; Alt+drag rotates. Selection / focus state lives in the editor store; positions persist on pointer-up.
- Right-panel inspector gains a "Text blocks" section: per-block text input, variant picker, color, scale, rotation, anchor presets (top-left, top-center, …, bottom-right) for one-click placement; "Add text block" button; per-block delete.
- Renderer changes: replace the single `<LowerThird>` mount with an iteration over `shot.textOverlays`. Each block renders as its own `<LowerThird>` with `customX` / `customY` props (the LowerThird component already supports `bottomOffset`; we'll add `leftOffset` plus an x/y absolute mode).
- Backwards compatibility: existing rows with only `on_screen_text` migrate on read into a single-element `text_overlays` array on first edit; never silently rewritten on read otherwise (avoid spurious dirty state).
- Auto-shift collision avoidance ([computeAutoShiftYPct](src/remotion/utils.ts)) is bypassed for any overlay with an explicit x/y; preserved as the default for the legacy single-OST path so existing projects don't visually shift.

**Out of scope:**
- Text animations beyond the existing enter/exit envelope. A separate ticket.
- Font picker per text block (uses the brand kit's body/heading fonts for v1).
- Per-block timing inside the shot ("appear at 1.2s, disappear at 2.7s"). v1 keeps the existing shot-level entry/exit envelope.

## 4. Constraints

- **No regression on existing rendered videos.** Every doc that doesn't opt in to multiple overlays MUST render byte-for-byte identical to today. The migration is read-side only, on edit-side actually persisting the new shape.
- **No new server endpoints.** Both parts use existing PATCH paths (`PATCH_DOC` / `PATCH_ROW` / debounced `/api/edit/[id]`).
- **Renderer stays Lambda-renderable.** No DOM-only APIs in the LowerThird path; everything is Remotion-friendly (already true, just calling it out).
- **Drag-and-drop integrates with the existing `TransformOverlay`.** The editor already has [TransformOverlay.tsx](src/components/editor/TransformOverlay.tsx) for free-transforming images. We extend its pattern for text blocks rather than building a parallel system — one DOM-on-canvas overlay paradigm, not two.

## 5. Requirements (UX walkthrough — Rule 10)

### 5.1 Part A — bug fix

A user opens a doodle_explainer_2 doc in the editor → first frame paints with the yellow variant. Same when they open the same doc in production-doc preview. Same when they render the MP4. If a user creates a SAVED style derived from `doodle_explainer_2`, same yellow treatment. Nothing in the UI changes; the bar simply renders yellow instead of red/black.

### 5.2 Part B — drag-and-drop

User selects a shot in the editor. Player preview shows the shot. **Visible affordance:** any text block on that shot has a thin dashed selection border on hover; click-drag moves it. While dragging, a guideline appears at the center axes (snap-to-center). Release sets the new x/y. Cmd+Z undoes.

To add a second block: inspector's "Text blocks" section → "+ Add text block" button. New block lands center-canvas with placeholder text "Text". User clicks the block in the preview, presses Enter (or double-clicks) to edit text inline.

To pick a preset position fast (lazy user — Rule 10): click one of the 9 anchor presets in the inspector (3×3 grid: top-left, top-center, top-right, …). The block snaps to that anchor. Drag still works to fine-tune.

Mobile is out of scope for the editor (drag affordances on touch are a separate problem); the editor is desktop-first.

## 6. Approach

### 6.1 Part A — diagnostic + fix

**Step 1 — confirm the root cause.** The diagnostic log already exists at [YouTubeVideo.tsx:486-495](src/remotion/compositions/YouTubeVideo.tsx#L486-L495):

```js
console.info('[lower-third variant resolved]', {
  shotIndex, sceneType, shotKind, styleId, resolvedVariant,
  hasOnScreenText, suppressLowerThird,
});
```

I need the user to open their editor's browser console, grep `lower-third variant resolved`, and paste one line. From `styleId` we'll know:

- **Case 1**: `styleId === 'doodle_explainer_2'` but variant resolves to `'default'`. Unlikely — the check is direct. Would point to an import/identity bug.
- **Case 2**: `styleId === '(undefined)'`. The doc has no `style_preset` set. Fix is to backfill style_preset when the doc was created from a style picker that didn't persist it.
- **Case 3**: `styleId === '<some-uuid>'`. The doc uses a saved style derived from `doodle_explainer_2`. The check `=== 'doodle_explainer_2'` is too strict. **This is the most likely case** given the screenshot.

**Step 2 — fix Case 3 (saved styles derived from a yellow built-in).**

The editor already calls `/api/production-doc/styles` to load the styles list (see [EditorClient.tsx:1361](src/app/(app)/edit/[projectId]/EditorClient.tsx#L1361)) and matches the current `doc.style_preset` against it. Today it only stores `preferred_cloud_model` from the match. Extend that to also pull `based_on_built_in`.

Then thread an `effectiveStyleSlug?: string` field into `productionDocToVideoConfig`'s options, with `styleId` resolved as: `opts.effectiveStyleSlug || doc.style_preset`. The editor passes `effectiveStyleSlug = activeStyleMatch.based_on_built_in ?? undefined`.

Production-doc page has the same styles list cached (it's the source of truth for the picker). Mirror the same logic there.

**Step 3 — handle Case 2 (undefined).** If `doc.style_preset` is undefined on a doc that should be doodle, the issue is upstream — the doc generator didn't stamp it. That's not the renderer's job to guess at. The fix would be in the doc-generation path. We'll know if this is the case after the user shares the log line.

**Step 4 — diagnostic improvements.** Add a server-side log `[doc render styleId resolved]` that prints `{ rawStylePreset, effectiveStyleSlug, resolvedVariant }` once per render so future cases of the same class of bug self-report from the server logs too.

### 6.2 Part B — multi-block drag-and-drop

**Data shape.** New type in [src/remotion/utils.ts](src/remotion/utils.ts) (and mirror in the inline `ProductionDoc` in [production-doc/page.tsx](src/app/(app)/production-doc/page.tsx) per AGENTS.md):

```ts
type TextOverlay = {
  id: string;                    // stable; uuid generated on add
  text: string;
  /** Position as percentage of the 1920×1080 canvas. 0,0 is top-left;
   *  100,100 is bottom-right. Renderer multiplies by config.width/height. */
  x_pct: number;
  y_pct: number;
  /** Multiplier on the variant's default fontSize. 1.0 = default. Clamped
   *  to [0.4, 3.0] to keep readable. */
  scale: number;
  /** Glyph variant for THIS block. Inherits the doc's style default
   *  when undefined (covers Part A's yellow fix). */
  variant?: LowerThirdVariant;
  /** Rotation in degrees, [-45, 45]. Default 0. */
  rotation_deg?: number;
  /** Anchor for positioning math: which point of the block sits at (x_pct, y_pct).
   *  Defaults to 'center'. Enables clean anchor-snap UX without trigonometry. */
  anchor?: 'top-left' | 'top-center' | 'top-right'
         | 'center-left' | 'center' | 'center-right'
         | 'bottom-left' | 'bottom-center' | 'bottom-right';
};

interface ProductionRow {
  // … existing fields …
  text_overlays?: TextOverlay[];
}
```

**Renderer changes.** `<LowerThird>` already supports `bottomOffset`. Add `leftOffset?: number` plus a "free placement" branch that uses absolute x/y instead of bottom-anchored layout, and respects `rotation_deg` via `transform: rotate(...)`. The scene components ([BRollScene.tsx](src/remotion/scenes/BRollScene.tsx), [MotionScene.tsx](src/remotion/scenes/MotionScene.tsx), etc.) iterate `shot.textOverlays?.length > 0 ? shot.textOverlays.map(o => <LowerThird .../>)` instead of a single mount. Legacy `shot.onScreenText` becomes a one-element synthetic overlay if `text_overlays` is empty so existing docs continue rendering unchanged.

**Editor UI changes.**

- New component `src/components/editor/TextOverlayDraggable.tsx`. Wraps each overlay's preview rendering inside the editor's Player overlay (the same plane `TransformOverlay` already uses). Click → select; drag → move; arrow → nudge; double-click → edit text inline.
- New inspector subpanel `src/components/editor/inspector/InspectorTextOverlaysPanel.tsx`. Lists every overlay on the selected shot with: text input, variant picker (default / doodle-yellow / future variants), 3×3 anchor preset grid, scale slider [0.4, 3.0], rotation slider [-45, 45], delete. Top-of-list "+ Add text block".
- Wire into `EditorCommand` store: new `PATCH_TEXT_OVERLAY`, `ADD_TEXT_OVERLAY`, `REMOVE_TEXT_OVERLAY` commands (each with an inverse for undo). For the live-drag path, the same `transient: true` pattern `PATCH_ROW` already uses keeps the undo stack clean (one entry per release).

**Drag math.** The Player renders at the workspace zoom level (`scale = playerWidth / 1920`). The overlay drag handler converts pointer deltas through `1 / scale` to keep cursor lock with the block. Snap to center axes at ±2% of canvas. Snap to other overlays' edges at ±1.5% of canvas (the same snap behavior most editors have — Figma etc.).

**Production-doc parity.** Same data shape on the doc. The picker in production-doc already supports `overlay_zone` for the legacy single OST; we keep that as a back-compat field and add a small "open in editor for free placement" affordance on the production-doc row that has more-than-one overlay. The full drag-and-drop UI is editor-only for v1 — production-doc keeps the simpler zone picker. (We could port it later if the user asks; v1 stays focused.)

## 7. Alternatives considered & rejected

**Alt A — fix Part A only, defer Part B.**
Smallest scope. Rejected because the user explicitly asked for both in the same message, and the data-shape decision (Part B's `text_overlays[]`) influences how Part A's variant field gets applied (per-block variant override vs doc-level). Building Part A in a way that doesn't anticipate Part B costs us a second migration. Better to lock the shape once.

**Alt B — implement only "free drag for the single OST" (no multiplicity).**
Smaller scope: one OST per shot but draggable anywhere. Rejected because user explicitly said "multiple areas that I choose on the screen". And the data shape is the same work either way — adding multi at v1 costs ~one inspector list and one renderer loop. Cheap.

**Alt C — implement only anchor presets (no free drag).**
Pick from a 3×3 or larger preset grid. Rejected because the user explicitly said "drag and drop anywhere". Anchor presets are still in scope as a quick-snap affordance, but they're additive on top of free drag.

**Alt D — build a separate canvas overlay layer (Konva, fabric.js, custom DnD).**
Tempting because canvas libs make drag-rotate-scale "free." Rejected: adds a heavy dependency for one feature, divorces the overlay rendering from the Remotion render path (we'd have to re-implement rendering twice), and the existing `TransformOverlay` already proves DOM-on-Player-canvas works. Stay inside the editor's existing pattern.

**Recommendation: ship Part A + Part B per §6. Reject A-D.**

## 8. Security & safety (Rule 13)

- **Text content** is user-authored. The renderer puts it through `<span>{text}</span>` (React text node), which is XSS-safe by default. No `dangerouslySetInnerHTML` anywhere in this path. Validate at the route boundary as plain string with a max length cap (1024 chars per block — long enough for any legitimate use, short enough to bound DoS via massive payloads). Defense in depth — `validatePayload` already gates the editor's PATCH path.
- **Numeric fields** (x_pct, y_pct, scale, rotation_deg) get strict bounds validation in `migratePayload` / `validatePayload`: x/y_pct ∈ [-50, 150] (allow slight off-canvas for animation-in tricks), scale ∈ [0.4, 3.0], rotation_deg ∈ [-45, 45]. Out-of-range values dropped silently per the migrator's existing pattern.
- **Block-count cap.** Refuse to mount more than 16 overlays per row server-side. Above that is almost certainly a malformed payload or a runaway script. Logged as `[text-overlays cap exceeded]`.
- **No new auth surface** — all writes flow through the existing editor PATCH that already enforces session + workspace ownership.

## 9. Observability (Rule 14)

All logs namespaced `[editor text-overlay …]` (and `[doc render styleId resolved]` for Part A's server diagnostic).

**Part A:**
- `[doc render styleId resolved]` — `{ rawStylePreset, effectiveStyleSlug, resolvedVariant }` on every render route call. Server-side, so it's in the Vercel function logs.

**Part B — client:**
- `[editor text-overlay add]` — `{ shotIndex, newBlockId, defaultPosition }`
- `[editor text-overlay drag-start]` — `{ shotIndex, blockId, startPosition }`
- `[editor text-overlay drag-end]` — `{ shotIndex, blockId, finalPosition, dragDurationMs }` (the `transient: true` interim moves don't log to avoid flooding).
- `[editor text-overlay edit]` — `{ shotIndex, blockId, field: 'text'|'scale'|'rotation'|..., oldValue, newValue }`
- `[editor text-overlay remove]` — `{ shotIndex, blockId, hadText: bool }`

**Part B — renderer:**
- `[text-overlay layer mount]` once per shot — `{ shotIndex, count, ids }`.

## 10. Testing (Rule 18)

**Part A:**
- `tests/scene-router-style-variant.test.tsx` — given config with `effectiveStyleSlug = 'doodle_explainer_2'` and a saved-style UUID styleId, SceneRouter resolves variant to `'doodle-yellow'`. Given `effectiveStyleSlug` undefined and `styleId === 'doodle_explainer_2'`, same result (back-compat). Given neither matches, `'default'`. The bug-fix test: a styleId that's a saved-style UUID derived from `paint_explainer_v1` must resolve to yellow once `effectiveStyleSlug` is wired.

**Part B:**
- `tests/text-overlay-types.test.ts` — `migratePayload` clamps out-of-range values, drops malformed entries, caps at 16. Validation rejects non-string text.
- `tests/text-overlay-renderer.test.tsx` — `<TextOverlayLayer>` mounts N overlays at the right absolute positions for given anchors; rotation transforms render; legacy `onScreenText`-only rows render a single overlay.
- `tests/text-overlay-store.test.ts` — `ADD_TEXT_OVERLAY` / `PATCH_TEXT_OVERLAY` / `REMOVE_TEXT_OVERLAY` reducers; `transient: true` doesn't push to undo stack; final pointerup commit does.
- `tests/text-overlay-drag-math.test.ts` — pointer-delta to canvas-percent conversion at non-1.0 scale; snap-to-center; snap-to-other-overlay edges.

**Manual / E2E (signed off by user before merge):**
- Open a real doodle_explainer_2 doc → yellow renders ✓
- Add three text blocks, drag each to a different corner → render MP4 → all three present in output
- Undo/redo each interaction → state matches
- Refresh → state persists

## 11. Cost implications (Rule 8)

Parts A, B, D, E are cost-free (pure UI / wiring / data shape).

**Part C — "Flip to overlay + regenerate" — has real per-image cost.** The doc in your screenshot uses GPT Image 2 (Atlas, cheaper) — see right-panel "Default — GPT Image 2 (Atlas, cheaper)" in your image. Per-image cost from [image-models.ts:137](src/lib/image-models.ts#L137):

> "Default GPT Image 2. Native 16:9 at 2K, **~$0.011/image**, no upscale needed."

**Estimated regen scope for your 250-shot doc**: I don't know exactly how many rows carry `on_screen_text`, but for a typical doodle_explainer_2 video that ratio is ~40-70% of rows. So:

| Scenario | Rows with OST | Cost @ $0.011/image |
|----------|---------------|---------------------|
| Conservative (40%) | ~100 rows | **~$1.10** |
| Likely (55%) | ~138 rows | **~$1.52** |
| High (70%) | ~175 rows | **~$1.93** |

Order of magnitude: **$1–$2 per affected doc**. Roughly. The confirmation modal will show the actual row count + exact cost before the user clicks Run.

The auto-pipeline already handles batching — Vercel function timeouts won't be exceeded (`MAX_*_PER_TICK` caps in the pipeline split the work across ticks). Total wall-clock time depends on row count but estimate ~10-30 minutes for 100-175 rows at GPT Image 2 latency.

**Pricing verification (Rule 1 + 8):** the in-code hint reflects pricing as of 2026-05-25 (per the plan reference in image-models.ts). Before kicking off a real regen, I'll re-verify current Atlas pricing at the OpenAI / Vercel-Atlas billing page so the modal's cost estimate is current, not stale.

## 12. Settings audit (Rule 15)

Does anything in this feature warrant a settings knob?

- **Default new-block variant** — when a user adds a new text block, which variant gets seeded? Defaults to the doc's `style_preset` mapping (yellow on doodle, default elsewhere). No setting needed — the doc context picks it.
- **Drag snap distance** — could be configurable (some users want tighter snap, some want none). Defer; pick a sensible default and surface only if a user asks.
- **Default new-block position** — center-canvas. Could be "wherever was last used" or "bottom-center" but center is the safest default.
- **Show/hide drag affordances on hover** — already implicit (no overlay when not selected). No setting needed.

Verdict: **no new settings** in v1. Picker for default block variant can come later if users actually want it.

## 13. PR breakdown

1. **PR 1 (Part A) — upstream slug resolution.** Extend EditorClient styles fetch to capture `based_on_built_in` from the styles list. Mirror in production-doc page (it already loads the styles list). Thread `effectiveStyleSlug` into `productionDocToVideoConfig` options, populate `config.styleId` from `effectiveStyleSlug ?? doc.style_preset`. Update the production-doc auto-flip useEffect ([page.tsx:2629-2636](src/app/(app)/production-doc/page.tsx#L2629-L2636)) to check `effectiveStyleSlug === 'doodle_explainer_2'` instead of the literal slug. Tests. **No image regen yet** — purely wiring.
2. **PR 2 (Part B) — editor OST mode control.** Add the OST mode picker to the Shot inspector: row-level `bake / overlay / none`, with "Use doc default (overlay)" as the default. Add doc-level mode default toggle to the inspector kebab. Both surface the same control production-doc has. Tests.
3. **PR 3 (Part C) — "Flip to overlay + regenerate" action.** New button in the inspector kebab → opens a confirmation modal listing affected rows (count + estimated cost). On confirm: sets `on_screen_text_mode_default = 'overlay'`, marks every affected row for regeneration, kicks off the auto-pipeline. Modal shows progress as ticks complete. Per-tick caps match the existing pipeline (`MAX_IMAGE_GEN_PER_TICK`). Tests.
4. **PR 4 (Part D foundation) — multi-block data shape + migration.** New `TextOverlay` type, migration, validation. Renderer reads `shot.textOverlays` falling back to a synthetic single-element array from `shot.onScreenText`. Backwards-compat-only change; no new UI. Tests.
5. **PR 5 (Part D — editor UI, no drag yet).** Add "Text blocks" subpanel to the Shot inspector. Add / edit / delete blocks, anchor presets (3×3 grid), per-block variant picker, scale, rotation. Tests.
6. **PR 6 (Part D — drag-and-drop).** `TextOverlayDraggable` on the Player surface. Pointer math with player-zoom scale, snap-to-center, snap-to-other-edges, arrow-key nudge, transient PATCH integration. Tests.
7. **PR 7 (Part E) — observability + animation parity polish.** Server-side `[doc render styleId resolved]` log. Renderer log per overlay layer mount. Verify enter/exit envelope per block. Final manual QA pass.

## 14. Open questions — RESOLVED 2026-06-02

**Q1. Diagnostic log line — STILL NEEDED.** Before PR 1 implementation, the user pastes the `[lower-third variant resolved]` log from the browser console for the affected doc. That confirms which case (§6.1 step 1) we're in. The fix architecture is the same either way (thread `effectiveStyleSlug`), but the test cases and any upstream fix depend on knowing the exact `styleId` value.

**Q2. Legacy on_screen_text auto-migration — RESOLVED: stay untouched until edited.**
Old docs read unchanged. Renderer treats a row with `on_screen_text` set and no `text_overlays` as a synthetic single-element overlay array internally (for renderer code unification) without persisting the conversion. Only an explicit user action that touches OST (drag, add second block, edit via new inspector panel) promotes the row to `text_overlays[]` and marks dirty. No spurious diffs.

**Q3. Per-block timing — RESOLVED: shared shot envelope for v1.**
Every block enters at shot start, exits at shot end. Same envelope `<LowerThird>` already uses. Per-block in/out timing is a follow-up; not v1 scope.

**Q4. New-block variant default — RESOLVED: inherit from doc style.**
On a doodle / paint doc, new blocks default to `doodle-yellow`. On a regular doc, new blocks default to `default`. The doc's style is the contract; new blocks follow it. Inspector picker still lets the user override per block.

## 16. Cost gate — explicit confirmation before regen

Before kicking off Part C (regen) on your 250-shot doc:

1. PR 1 lands — verifies the wiring is right. The doodle-yellow `<LowerThird>` mounts correctly on a fresh test row (you can preview without regenerating anything).
2. PR 2 lands — you have the OST mode control. You can spot-check one row by setting mode to `'overlay'` manually, regenerating just that row, and previewing.
3. PR 3 lands the "Flip to overlay + regenerate" action behind a confirmation modal that shows:
   - Exact count of rows that will be regenerated
   - Current per-image price (verified live before the modal opens)
   - Estimated total cost
   - "I understand this will cost ~$X — Run" button
4. You click Run only if the number is acceptable.

I will NOT kick off mass regen without you explicitly clicking through that modal. If at any point during PR 1/2 the per-row dry-run reveals the cost is materially higher than $2, I'll pause and report before continuing.

## 15. Acceptance — done means

- Part A: every doodle_explainer_2 doc — built-in OR saved-style-derived — renders the yellow variant. Production-doc preview and editor preview match. Render-MP4 matches.
- Part B: user opens a shot in the editor → preview shows existing OST as a draggable block. Add a second block from the inspector. Drag both to chosen positions. Refresh page → positions persist. Render MP4 → both blocks render at chosen positions with chosen variant / scale / rotation. Undo/redo round-trips every operation.
- All new unit tests pass; existing tests still pass.
- No regression: a doc without `text_overlays` renders byte-for-byte identical to today.
- A user who picks one of the 9 anchor presets in the inspector gets a clean one-click placement without ever touching the canvas.
