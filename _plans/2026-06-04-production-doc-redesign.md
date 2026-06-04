# Production Doc — Full UI/UX Redesign

**Status:** Draft, awaiting approval. Code MUST NOT start until the user signs off on the layout in this file.

**One-line summary:** Replace the current "two clashing views" (cluttered grid + Phase-3 multi-pane editor) with a single, coherent page that runs as a calm, top-to-bottom **Brief Notebook** before generation and transforms into a focused, preview-hero **Studio Workspace** after. Every existing feature is mapped to a new home; nothing is removed.

---

## 0 · Hard constraint (the user said this six times)

> ALL FEATURES MUST EXIST. NO REMOVING OF ANY FEATURE.

This plan treats the §3 Feature-Mapping table as a contract: every row of that table must resolve to a concrete location in the new design. If during implementation a feature has no home, that is a bug in the plan, not a license to drop the feature. We pause, update the plan, get re-approval.

---

## 1 · Goals & non-goals

### Goals (in priority order)
1. **Surface every feature without clutter** — the cataloged ~120 controls all stay reachable, but no single screen shows more than what is relevant to the user's current intent.
2. **Match the natural workflow order** — Brief → Style → Script → Generate → Edit Rows → Voiceover → Render. The page reads top-to-bottom in that order.
3. **Make the row editor under the preview not awkward anymore** — replace the 13-column horizontal table as the primary edit surface with a hero-preview + scene-strip + contextual right-inspector pattern. Keep the table available as a "Bulk Grid" toggle for power use.
4. **Be visibly beautiful, deliberate, and human** (rule 5, rule 16) — calm color, generous whitespace, real typographic hierarchy, no generic gradient/glassmorphism AI tells.
5. **One coherent view, not two competing views** — unify the existing `?view=grid` and `?view=editor` modes. The redesign IS the unification.

### Non-goals
- No new features, no scope creep. Variants stay capped at `MAX_VARIANTS_PER_GROUP`, rethink stays capped at `RETHINK_MAX_ATTEMPTS`, overlay edit history stays capped at `OVERLAY_EDIT_HISTORY_CAP`, etc.
- No backend schema changes. Same `ProductionDoc` JSONB shape, same `useProject` persistence sink, same `/api/edit/[projectId]/row-asset` atomic saves.
- No change to the Remotion render pipeline, Lambda bundle, or any AI provider integration.
- No change to keyboard shortcuts (they are already coherent — we preserve them and add a discoverability surface via `CheatSheet`).
- No change to URL params, localStorage keys, or user-prefs keys. Persistence contracts stay identical so saved sessions, handoffs from `/schedule` and `/analyze`, and back-links from `/edit/[projectId]` keep working untouched.

---

## 2 · User-stated constraints (from this session)

- **Pain points to fix:** features are hard to find · visual clutter / not beautiful · the editor below the preview is awkward · workflow doesn't match the order of operations.
- **Visual direction:** Notebook (top-to-bottom workflow, content-first, generous whitespace) **mixed with** Studio (preview-hero, dockable/inspector panels). Neither pure.
- **Bottom row editor placement:** user wants to decide after seeing the mock. This plan proposes a concrete recommendation in §4.
- **Sacred cows:** none — redesign freely. The only sacred cow is feature preservation.

Other standing rules carried in from `CLAUDE.md`:
- Rule 1 (no hallucination): the §3 inventory came from reading the actual files, not memory.
- Rule 2 (clean code): the new components match the existing code's structure; imports grouped, naming consistent with neighbors, no drive-by re-orgs of unrelated files.
- Rule 5 (no AI-tell visuals): explicit anti-patterns called out in §5.
- Rule 7 (save plan): this file.
- Rule 10 (lazy user): each new surface walked through from cold start in §6.
- Rule 12 (brutal honesty): §11 names the risks of this redesign frankly.
- Rule 13 (security): §8.
- Rule 14 (observability): §9.
- Rule 15 (settings audit): §10.
- Rule 18 (tests): §12.

---

## 3 · Feature inventory + mapping (the contract)

This is the proof that nothing is removed. Each row is a feature that exists today; the right column is where it lands in the new design. If a row reads "same place / unchanged" the feature keeps its existing component and props, just inside a redesigned container.

Codes for "New home" column:
- `[BRIEF/<section>]` — Brief Mode card (pre-generation Notebook surface).
- `[STUDIO/top]` — Studio top command bar.
- `[STUDIO/left]` — Studio left rail (workflow nav, filters, legend).
- `[STUDIO/preview]` — Studio center column, above the scene strip.
- `[STUDIO/strip]` — Studio scene strip (the new "row editor below preview").
- `[STUDIO/inspector/<tab>]` — Studio right inspector, contextual tab.
- `[STUDIO/inspector/doc]` — Studio right inspector, default doc-level state.
- `[STUDIO/bulk]` — Studio "Bulk Grid" sub-mode (toggled from `[STUDIO/top]`).
- `[STUDIO/render]` — Studio render dock (pinned bottom).
- `[GLOBAL/drawer/<name>]` — pulled out from any mode via top-bar trigger.

### 3.1 Banners & global state

| Feature today | Component / state | New home |
|---|---|---|
| Schedule-link context banner | `ScheduleLinkBanner` | `[GLOBAL/banner]` — top of page in both modes, unchanged |
| Bulk-failure banner (auto-pipeline) | inline JSX | `[GLOBAL/banner]` — same surface |
| Save-failure banner (no_session / unauthorized / rejected / queued_offline / mid_session_error / mid_session_conflict) | `saveFailure` state | `[GLOBAL/banner]` — same surface, with the Reload-server / Continue-editing buttons preserved |
| Remote update banner (cross-tab conflict) | `useProject` `onConflict` | `[GLOBAL/banner]` — same surface |
| Image-gen throttle toast | `ImageGenThrottleToast` | mounted globally, same place, unchanged |

### 3.2 Top-of-page chrome

| Feature today | New home |
|---|---|
| Page title + description | `[BRIEF/header]` (Brief Mode) and `[STUDIO/top]` (Studio Mode, condensed) |
| New session button | `[STUDIO/top]` overflow menu + still on Brief header |
| "Try new editor view" / "Back to grid" toggle | **REMOVED AS A TOGGLE** — the redesign unifies these. But the underlying `EditorView` component is the architectural base of Studio Mode (see §7). Zero feature loss; only the toggle disappears because there's nothing to toggle to. The URL `?view=editor` still routes here and is preserved as a deep link, just resolves to the unified Studio Mode. |
| Schedule/project/video prefill (`?scheduleItemId=`, `?projectId=`, `?videoId=`, `?h=`, `?from=`, `?stylePreset=`) | unchanged — params parsed identically on mount |
| History sidebar (HistoryPanel) | `[GLOBAL/drawer/history]` — trigger lives in `[STUDIO/top]` and `[BRIEF/header]`; sidebar slides in from right |

### 3.3 Input panel (pre-generation form)

| Feature today | New home |
|---|---|
| Niche picker (`NichePicker` + autocomplete) | `[BRIEF/brief]` card, row 1 col 1 |
| Topic autocomplete (`AutocompleteInput`) | `[BRIEF/brief]` card, row 1 col 2 |
| Speaking pace selector (110–165 wpm) | `[BRIEF/brief]` card, row 2 col 1 |
| Actual voiceover duration override (mm:ss) | `[BRIEF/brief]` card, row 2 col 2 |
| Image model dropdown (`IMAGE_MODELS`) | `[BRIEF/brief]` card, row 3 col 1 + cost hint inline |
| AI / LLM model picker (`ModelSelector`) | `[BRIEF/brief]` card, row 3 col 2 |
| Overlay default toggle (`overlaysDisabledPref`) | `[BRIEF/brief]` card, row 4 |
| Style preset picker (built-in + saved + ★ default) | `[BRIEF/style]` card, top |
| ★ Set-default-style server roundtrip | unchanged — `/api/user/settings/default-style` |
| Manage styles button → `StyleManagerDialog` | `[BRIEF/style]` card, top right |
| `PaintExplainerV1SettingsPanel` (conditional) | `[BRIEF/style]` card, inline under style picker; in Studio Mode lives in `[STUDIO/inspector/doc]` Style tab |
| `DoodleExplainer2MotionCollageSettingsPanel` (conditional) | same — `[BRIEF/style]` then `[STUDIO/inspector/doc]` |
| `PacingProfilePanel` | same — `[BRIEF/style]` then `[STUDIO/inspector/doc]` |
| Creative brief textarea | `[BRIEF/style]` card |
| YouTube reference URL input + add | `[BRIEF/refs]` card |
| Screenshot upload | `[BRIEF/refs]` card |
| Visual reference tiles (with analysis spinner / Retry / ✓ analyzed) | `[BRIEF/refs]` card grid |
| `TitleReviewPanel` (collapsed by default) | `[BRIEF/script]` card, below the textarea, collapsed |
| Script textarea | `[BRIEF/script]` card, hero of the card |
| `CopyForElevenLabs` button | `[BRIEF/script]` card footer |
| Primary "Generate Production Doc" button | `[BRIEF/cta]` — full-width sticky bottom of Brief Mode |
| Generation log stream | `[BRIEF/cta]` — expands above the CTA while running |
| Stop button (AbortController) | `[BRIEF/cta]` — replaces CTA while running |

### 3.4 Main table / row editing

| Feature today | New home |
|---|---|
| `#` column (row index) | `[STUDIO/strip]` shows on each card; `[STUDIO/bulk]` still has the column |
| Time column (timecode) | `[STUDIO/strip]` card label · `[STUDIO/bulk]` column |
| Script text + inline edit (✎, Ctrl/Cmd+Enter, Esc) | `[STUDIO/inspector/content]` for selected row · still inline-editable in `[STUDIO/bulk]` |
| Visual type pill (`SlugChip`) | `[STUDIO/strip]` card · `[STUDIO/inspector/content]` editable picker |
| Visual description | `[STUDIO/inspector/content]` |
| Stock terms | `[STUDIO/inspector/content]` (read-only display) |
| `ImageCell` (Generate / Upload / Import URL / Edit / Re-gen / Undo / Lightbox / Motion Collage previews / Variant child generation) | `[STUDIO/strip]` card thumbnail with quick-actions on hover · `[STUDIO/inspector/image]` for the full editor |
| `BrollCell` (model family picker, star defaults, generate, polling, video player, Re-gen, Undo) | `[STUDIO/strip]` card video tab · `[STUDIO/inspector/video]` for the full editor |
| `OverlayCell` (terms pill, fetch status, retry, ↻ Rethink, ✎ Edit, ↶ Undo, ↺ Reset, ✕ Remove) | `[STUDIO/inspector/overlay]` |
| Overlay right-click context menu (`OverlayContextMenu`) | preserved — context menu still works in `[STUDIO/strip]` cards and `[STUDIO/inspector/overlay]` |
| AI prompt inline edit (✎) | `[STUDIO/inspector/content]` |
| On-screen text inline edit | `[STUDIO/inspector/content]` |
| `OstModeControl` (bake vs overlay vs none) | `[STUDIO/inspector/content]` |
| Notes field per row | `[STUDIO/inspector/content]` |
| `SectionThumbnailCard` (zoom-to, section title + layout, pillarbox color, transition, stripe toggle, scene zoom, region zoom padding, scene fade — each with Apply-to-all / Clear-all-overrides) | **`[STUDIO/inspector/section]`** — the single biggest consolidation win. Today these 8 control groups live in one wide card; in the new design they become a single Section tab with grouped accordions (Layout · Title · Transition · Zoom · Fade · Color) so each group's Apply-to-all and Clear-all-overrides remain present and obvious. |
| `SectionRowControls` (drag handle, lock-as-still, variant management) | `[STUDIO/strip]` drag handle on card · `[STUDIO/inspector/variants]` for variant ops |
| Variant indicators (base, child, stale, ↻ Regenerate from base, ✕ Variant, "+ Add variant", group size) | `[STUDIO/inspector/variants]` (full UI) + `[STUDIO/strip]` shows variant-group badge on cards |
| Row expand chevron (▼/▲) | gone — selecting the card in `[STUDIO/strip]` IS the expand. `[STUDIO/bulk]` still has the chevron. |
| Row reordering (drag) | `[STUDIO/strip]` drag · `[STUDIO/bulk]` drag handle in row-controls |
| Per-row delete | `[STUDIO/inspector/content]` overflow menu (⋯) |
| Visual-type filter chips | `[STUDIO/left]` Filters panel |
| Motion Collage only checkbox | `[STUDIO/left]` Filters panel |
| Search box | `[STUDIO/left]` Filters panel |
| Filter "applied" indicator (badge with hidden count) | new affordance — `[STUDIO/left]` shows "Showing X of Y rows" pill when filters are active (this is a clarity fix, not a feature add) |

### 3.5 Doc-level controls (above the current table)

| Feature today | New home |
|---|---|
| `SceneTimingControl` (min_scene_ms, tail_buffer_ms, Apply/Reset) | `[STUDIO/inspector/doc]` Timing tab |
| Doc-level overlay disable toggle | `[STUDIO/inspector/doc]` Defaults tab |
| Doc-level section thumbnail composite + default transition + zoom-to | `[STUDIO/inspector/doc]` Layout tab |
| Media status bar (image counter, video counter, Retry all failed, Animate all) | `[STUDIO/render]` dock (always pinned) — these are batch operations that benefit from being a single click away |
| Legend (visual-type color/count) | `[STUDIO/left]` Legend panel (above Filters) |
| Motion collage batch-mode toggle | `[STUDIO/inspector/doc]` Defaults tab |
| Doc-level `scene_fade_enabled`, `on_screen_text_mode_default` | `[STUDIO/inspector/doc]` Defaults tab |
| `prodoc_suppress_lower_thirds_v1` doc toggle | `[STUDIO/inspector/doc]` Defaults tab |
| `prodoc_animate_scenes_v1` doc toggle | `[STUDIO/inspector/doc]` Defaults tab |

### 3.6 Voiceover, alignment, brand, style sheet

| Feature today | New home |
|---|---|
| `VoiceoverPicker` | `[STUDIO/inspector/voiceover]` tab + a compact pill on `[STUDIO/preview]` |
| `AlignmentPill` (status + Realign) | `[STUDIO/preview]` underbar pill |
| `VideoPreviewBrandBar` (primary + bg color) | `[STUDIO/preview]` underbar — collapsible |
| `VisualBrandKitOverridePanel` (channel kit + per-doc override) | `[STUDIO/inspector/doc]` Brand tab |
| `StyleSheetPanel` (Phase 7 style sheet + protagonist description, generate / clear) | `[STUDIO/inspector/doc]` Style tab |
| `CharacterDescriptionsPanel` (character bible + tagger) | `[STUDIO/inspector/doc]` Characters tab |

### 3.7 Modals (preserved, opened from new locations)

| Modal today | Opened from (new) | Behavior |
|---|---|---|
| `EditPanel` | `[STUDIO/inspector/image]` ✎ Edit | unchanged |
| `MaskBrushEditor` | inside `EditPanel` | unchanged |
| `OverlayPositionEditor` | `[STUDIO/inspector/overlay]` Drag-to-place | unchanged |
| `OverlayEditDialog` | `[STUDIO/inspector/overlay]` ✎ Edit | unchanged |
| `OverlayContextMenu` | right-click on `[STUDIO/strip]` card overlay badge OR `[STUDIO/inspector/overlay]` | unchanged |
| `StyleManagerDialog` | `[BRIEF/style]` Manage styles · `[STUDIO/inspector/doc]` Style tab | unchanged |
| `MissingClipsModal` | render trigger in `[STUDIO/render]` | unchanged |
| `MotionCollageRowEditor` | `[STUDIO/inspector/image]` Motion-collage panels | unchanged |
| `ImageLightbox` | click thumbnail in `[STUDIO/strip]` or `[STUDIO/inspector/image]` | unchanged |
| `ThumbnailRegionEditor` | `[STUDIO/inspector/section]` zoom-to control | unchanged |

### 3.8 Editor view (existing Phase 3 multi-pane)

| Component today | New role |
|---|---|
| `EditorView` shell | becomes the architectural shell for **Studio Mode**. The redesign extends it; it is not a separate optional view anymore. |
| `Stage` | becomes `[STUDIO/preview]` — the live Remotion preview, hero of Studio Mode |
| `Inspector` | becomes `[STUDIO/inspector]` — extended with all the row tabs in §3.4 |
| `SectionStrip` | becomes `[STUDIO/strip]` — extended to be the scene editor for the whole doc, not just sections |
| `CheatSheet` | becomes `[GLOBAL/drawer/shortcuts]` — opened via ? key or top-bar icon |
| `NotesDock` | becomes `[GLOBAL/drawer/notes]` — preserved, mounted globally |
| `useEditorUndoStack` | unchanged — Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z work everywhere a row is editable |
| `useSaveIndicator` | unchanged — "Saved Xs ago" lives in `[STUDIO/top]` |

### 3.9 Render

| Feature today | New home |
|---|---|
| Voiceover & alignment block | `[STUDIO/preview]` underbar (compact) + `[STUDIO/inspector/voiceover]` (full) |
| Render button + progress bar + download link | `[STUDIO/render]` dock — pinned bottom of Studio Mode |
| Post-render survey | `[STUDIO/render]` dock, same |
| Open in Editor button (deep-link to `/edit/[projectId]`) | `[STUDIO/top]` overflow menu — gated identically by `EDITOR_V1_PUBLIC` and save state |
| Export CSV / Export to Sheets | `[STUDIO/top]` overflow menu |
| Regenerate doc | `[STUDIO/top]` overflow menu (confirms; reopens Brief Mode pre-filled) |

### 3.10 Persistence (zero change)

| Surface | Status |
|---|---|
| `prodoc_form_inputs_v1`, `prodoc_last_result`, `prodoc_image_model`, `prodoc_overlays_disabled_pref`, `prodoc_animate_scenes_v1`, `prodoc_suppress_lower_thirds_v1`, `prodoc_broll_v1`, `prodoc_handoff_consumed`, `prodoc_prefill`, `video_brand_kit` | unchanged |
| `useProject` debounced save + atomic row-asset endpoint | unchanged |
| User prefs server endpoints | unchanged |
| History entries shape | unchanged |
| All URL params | unchanged |

---

## 4 · The mock

Three ASCII mocks: Brief Mode, Studio Mode (default scene-strip layout), Studio Mode "Bulk Grid" toggle. These are intent mocks — exact pixel sizes, type ramp, and component proportions get refined in the Figma-style pass in §7, but the structure is what we're committing to here.

### 4.1 Brief Mode (pre-generation Notebook)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  [Schedule banner if from /schedule]                                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│  Production Doc                                       History  ⌘?  New session  │
│  Plan, write, and produce a video end-to-end.                                   │
│                                                                                 │
│  ┌─ 1 · Brief ──────────────────────────────────────────────────────────────┐  │
│  │                                                                          │  │
│  │   Niche                            Topic                                 │  │
│  │   [Money & finance ▾           ]   [How compound interest works ▾    ]  │  │
│  │                                                                          │  │
│  │   Speaking pace                    Actual voiceover length (optional)    │  │
│  │   [Moderate · 125 wpm ▾        ]   [m m : s s        ] × clear         │  │
│  │   Estimated duration: 6m 24s · 800 words                                 │  │
│  │                                                                          │  │
│  │   Image model                      AI model                              │  │
│  │   [Atlas Cloud · $0.012/img ▾  ]   [Opus 4.7 ▾                       ]  │  │
│  │                                                                          │  │
│  │   ☐ Disable overlays for this doc                                        │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ 2 · Style ──────────────────────────────────────────────────────────────┐  │
│  │                                                                          │  │
│  │  ┌── Style preset ────────────────────────────────────────────────────┐ │  │
│  │  │ ★ Paint Explainer V1   Doodle Explainer 2   Cinematic   Saved · MyStyle │ │  │
│  │  └────────────────────────────────────── Manage styles ─────────────┘ │  │
│  │                                                                          │  │
│  │  [conditional: Paint / Doodle settings panel inline here]                │  │
│  │                                                                          │  │
│  │  Pacing profile        [Standard ▾]                                      │  │
│  │                                                                          │  │
│  │  Creative brief                                                          │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐   │  │
│  │  │ Energetic explainer in soft pastels, hand-drawn feel, big bold   │   │  │
│  │  │ labels…                                                          │   │  │
│  │  └──────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                          │  │
│  │  ▸ Visual references (0)                                                 │  │
│  │  ▸ Style sheet (Phase 7) — protagonist + consistency reference           │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ 3 · Script ─────────────────────────────────────────────────────────────┐  │
│  │  ┌──────────────────────────────────────────────────────────────────┐   │  │
│  │  │  Welcome to the video. Today we're talking about compounding…    │   │  │
│  │  │  ## What is compound interest?                                   │   │  │
│  │  │  …                                                               │   │  │
│  │  │  ## Why time matters                                             │   │  │
│  │  │  …                                                               │   │  │
│  │  └──────────────────────────────────────────────────────────────────┘   │  │
│  │  Copy for ElevenLabs                                                     │  │
│  │  ▸ Pre-flight title review (2 detected, 0 edited)                        │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
├─── sticky CTA bar ──────────────────────────────────────────────────────────────┤
│   [generation log — appears here while running]                                 │
│   ╭──────────────────────────────────────────────────────────────────────╮     │
│   │              Generate Production Doc  (Ctrl+Enter)                   │     │
│   ╰──────────────────────────────────────────────────────────────────────╯     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Why this works (Notebook-side):
- One column, top-to-bottom, four labeled steps. A lazy user can read the numbered headings and know what to do.
- Style/Refs/Style-sheet collapse the four sub-panels that today crowd the Creative Direction card into one Style step with three nested accordion sections.
- The Generate CTA is sticky-bottom so it is always one click away even mid-scroll.
- Generation log expands up from the CTA so the button never moves out of view.

### 4.2 Studio Mode — default layout (scene-strip below preview)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Production Doc · "How compound interest works"  · Saved 3s ago                  │
│ [Brief↩]  [Bulk grid ▦]  [Open in editor]  [Export ▾]  [⌘?]  [⋯]   Render ▸   │
├──────────────┬───────────────────────────────────────────┬──────────────────────┤
│              │                                           │                      │
│  ▾ Jump to   │                                           │  Inspector           │
│   Brief      │   ┌───────────────────────────────────┐   │  ────────            │
│   Script     │   │                                   │   │   Row 04 · 0:42      │
│   Style      │   │         Live preview              │   │   Title Card         │
│   Rows  ◀    │   │           16:9                    │   │                      │
│   Voiceover  │   │                                   │   │  [Content][Image]    │
│   Render     │   └───────────────────────────────────┘   │  [Video][Overlay]    │
│              │   ▸ Brand colors · Voiceover · Alignment  │  [Section][Variants] │
│  ▾ Filters   │                                           │                      │
│   ▣ Title    │   ─── Scenes (12) ──────────────  ⌕     │   Script text         │
│   ▣ B-Roll   │                                           │   ┌────────────────┐ │
│   ▣ Anim     │   ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐    │   │ Once Bob start │ │
│   ▣ Cinem    │   │01│ │02│ │03│ │04│ │05│ │06│ │07│ →  │   │ saving at 25,  │ │
│   ☐ Motion   │   │██│ │██│ │■■│ │██│ │■■│ │··│ │··│    │   │ his money …    │ │
│   only       │   └──┘ └──┘ └──┘ └▲▲┘ └──┘ └──┘ └──┘    │   └────────────────┘ │
│   [search…]  │   t  t   broll  T  broll  ··           │                      │
│              │     ↑                                     │   AI prompt          │
│  ▾ Legend    │     selected                              │   ┌────────────────┐ │
│   ● Title 3  │                                           │   │ Hand-drawn …  │ │
│   ● B-roll 5 │                                           │   └────────────────┘ │
│   ● Anim 2   │                                           │                      │
│   ● Cinem 2  │                                           │   On-screen text     │
│              │                                           │   ┌────────────────┐ │
│   Showing    │                                           │   │ Start saving   │ │
│   12 of 12   │                                           │   └────────────────┘ │
│              │                                           │                      │
│              │                                           │   OST mode  [bake ▾] │
│              │                                           │   Notes ▸            │
│              │                                           │   ⋯ Delete row       │
│              │                                           │                      │
├──────────────┴───────────────────────────────────────────┴──────────────────────┤
│  Render dock                                                                    │
│  Images 11/12 ready · Videos 4 ready 1 generating · Retry failed · Animate all  │
│                                  Start Render →                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Card legend in the strip:
- `██` solid bar = image done · `■■` half-bar = generating · `··` empty = no image yet
- `t` small dot under card = on-screen text present
- `broll` label under card = B-roll clip present
- `▲▲` chevron between cards = selected
- Cards are draggable to reorder (drag handle reveals on hover)

Why this works (Studio-side):
- Preview is the hero, always visible, always on top — that solves "render preview buried".
- Scene strip is the new "row editor below the preview" — but it is no longer a wide 13-column table, it is a horizontal carousel of glanceable cards. Each card encodes status visually (image state, B-roll, OST, variants) so the user can scan 50 scenes in seconds. This is the answer to the user's "editor is awkward" complaint.
- The right inspector is contextual: by default it shows doc-level controls, when a card is selected it shows that row's full editor in tabs. **All 13 today-columns are reachable inside the Inspector via tabs; nothing is hidden.**
- The left rail collapses Filters + Legend + Jump-to into a quiet navigation column. Filter chips show "Showing X of Y rows" so the user always knows when filtering is hiding content (this was a pain point in §16.6 of the inventory).
- Render dock is pinned bottom with the batch operations the user does often (Retry all, Animate all) one click from any scroll position.

### 4.3 Studio Mode — Bulk Grid sub-mode

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Production Doc …                                  [Bulk grid ▦ ◀] [⋯]  Render ▸ │
├──────────────┬──────────────────────────────────────────────────────────────────┤
│              │                                                                  │
│  ▾ Jump to   │   ┌─ Preview (mini) ──────┐    Showing 12 of 12 rows            │
│   Brief      │   │                       │                                      │
│   Script     │   └───────────────────────┘                                      │
│   Style      │                                                                  │
│   Rows  ◀    │   #  Time   Script        Type    Image   Broll   Overlay  ⋯   │
│   Voiceover  │   ─────────────────────────────────────────────────────────────  │
│   Render     │   01 0:00   Welcome to…   Title   [img]   —       —        ⋯   │
│              │   02 0:08   Today we're…  B-Roll  [img]   [vid]   stocks   ⋯   │
│  ▾ Filters   │   03 0:24   What is …     Title   [img]   —       —        ⋯   │
│              │   04 0:42   Once Bob …    Title   [img]   —       —        ⋯   │
│  ▾ Legend    │   05 0:55   …             …       …       …       …        ⋯   │
│              │   …                                                              │
│              │                                                                  │
├──────────────┴──────────────────────────────────────────────────────────────────┤
│  Render dock                                                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The Bulk Grid sub-mode is the current table, kept for power users who want to bulk-scan or bulk-edit rows. Key calls:
- Same columns as today (after a cosmetic cleanup pass: consistent padding, single header row, clear column widths).
- Same inline editors as today (`script_text`, `ai_prompt`, `on_screen_text`).
- Same per-row Apply-to-all / Clear-all-overrides for section controls.
- Mini preview lives top-left so users don't lose context.
- Right inspector goes away in this sub-mode (the table IS the inspector). Selecting a row still highlights it; clicking opens a side drawer for the full inspector if desired.

This is opt-in — default is the scene-strip mode. The toggle is a single button in `[STUDIO/top]`. Toggling preserves selection.

### 4.4 Mode transition (Brief → Studio)

- User presses **Generate Production Doc** in Brief Mode.
- Generation log replaces the CTA in place; Brief sections collapse to thin labels above.
- On success, the page **does not** scroll-jump or reload. Brief sections animate up and out; the Studio shell fades in below them. The fade-out is fast (~180ms ease-out) so the user isn't waiting on chrome.
- A persistent `[Brief↩]` button in `[STUDIO/top]` re-opens Brief Mode (collapsed inputs become an editable sheet on top of Studio). This is the round-trip for tweaking and re-generating.

---

## 5 · Visual language (anti-AI-tell pass)

This is the rule-5 / rule-16 section. The redesign is opinionated about what NOT to do.

### Forbidden patterns
- No multi-stop gradient backgrounds. Solid panels only.
- No glassmorphism (no `backdrop-filter: blur`).
- No neon accent on dark surfaces (no `rgba(34,211,238,0.85)` glow accents on dark — the variant accent rail in the current grid is the only place that cyan survives, and we tone it down to a softer 0.6 alpha).
- No emoji as primary affordances. Existing emoji affordances (✎, ↶, ↻, ★, ⌐) are kept because they're load-bearing muscle memory; new affordances use icons (Lucide), not emoji.
- No em dashes in any UI copy. Hyphen-minus only. (Rule 5.)
- No rhythmic 3-item lists in UI copy. Vary length.
- No "Seamless", "Powerful", "Effortless", "Streamlined" in UI copy.

### Tokens (proposed; reuse existing where possible)
- **Surfaces:** `panel`, `panel-subtle`, `panel-elevated`. Three steps, no more.
- **Borders:** 1px solid `border-default` (no 2px, no double).
- **Spacing scale:** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. The current grid uses ad-hoc spacing; we standardize.
- **Type ramp:** display 28/700, h1 22/600, h2 18/600, body 15/400, label 13/500, mono 13/500. Mono only for timecodes and counters.
- **Color:** monochrome base (warm neutral), one accent for primary actions, one warning amber, one error red. Visual-type pills keep their existing palette because users associate them with row classification.
- **Motion:** opacity + transform only. 180ms ease-out for enter, 120ms ease-in for exit. No bounce, no spring, no parallax.
- **Shadow:** at most one elevation level above panel-elevated (a 4–8px soft shadow). Modals get a single backdrop dim, no extra shadow.

### Accessibility
- Every selectable card in the strip has a focusable wrapper with visible `:focus-visible` ring.
- Every drag handle has a keyboard alternative (arrow-key reorder when focused).
- Every modal has focus trap + Escape close + return-focus on close (already mostly true).
- Color is never the only signal for status (image generated vs failed vs generating uses shape + label, not just hue).
- Filter "Showing X of Y" is announced to screen readers when count changes (aria-live polite).

---

## 6 · Lazy-user walkthrough (rule 10)

I walk every realistic scenario from cold start and call out any place a lazy user might get stuck.

### Scenario A — "I just want to make a video"
1. Lands on `/production-doc`. Sees the title, four numbered steps. **OK.**
2. Picks niche, topic. Sees pace, model, image model. Defaults are already chosen.
3. Picks a style. Sees the active style settings panel inline. Doesn't touch it.
4. Pastes script. Sees the big Generate button sticky-bottom. Presses it.
5. Watches the log scroll. Generation finishes.
6. Page transforms. Sees preview, scenes strip, render button bottom-right. Presses **Start Render**. **Done.**

No deep navigation, no hidden controls touched. The default flow is six interactions max.

### Scenario B — "I want to tweak scene 4"
1. Already in Studio Mode.
2. Sees scene strip, clicks card 04.
3. Right inspector populates with row controls in tabs (`Content` open by default).
4. Edits script text or AI prompt. Ctrl/Cmd+Enter saves.
5. Switches to `Image` tab. Presses Re-generate. New image appears.

The inspector is contextual but the tabs are explicit, so the user never wonders "where do I edit X" — they look at the row, click it, see the tabs, find X in seconds.

### Scenario C — "I want to bulk-edit pillarbox color across all rows"
1. In Studio Mode, default sub-mode.
2. Clicks any card, opens `Section` tab in inspector.
3. Sees Color group, picks color, presses **Apply to all**. Pill confirms "Applied to 12 rows".

Same primitive as today, just discoverable in a clean inspector instead of a cramped section card.

### Scenario D — "I want to bulk-fix something — I miss the table"
1. Top bar **Bulk grid ▦** toggle.
2. Whole page switches to grid sub-mode.
3. Edits inline as today.
4. Toggles back to **Scenes ▦◀** when done.

No feature loss, full muscle-memory restoration.

### Scenario E — "I lost my work, where's the history?"
1. Top bar **History** button → right drawer opens.
2. Picks an entry. Doc restores. (Existing flow, just behind a drawer instead of a sidebar.)

### Scenario F — "I want to render now but B-roll is mid-generation"
1. Render dock shows "Videos 4 ready 1 generating".
2. Presses **Start Render**.
3. `MissingClipsModal` opens. Same flow as today (Reload clips / Continue without / Cancel).

### Scenario G — "I came from a schedule item"
1. URL has `?scheduleItemId=`.
2. `ScheduleLinkBanner` at top, voiceover auto-matched, form prefilled.
3. Same handoff as today.

### Scenario H — "I'm on mobile" — explicit non-goal
- Production-doc is desktop-first (heavy editing, multi-pane, drag-drop, brush). The plan does not promise a great mobile experience. On narrow viewports we degrade to: stacked Brief Mode (already works), and a "Studio Mode is desktop-only" notice with a button to switch to Bulk Grid which is mobile-tolerable.

### Stuck points found in the walkthrough
- **In Studio Mode, where's "Regenerate doc"?** → `[STUDIO/top]` overflow menu (⋯). The lazy user might miss it. Mitigation: when no doc is loaded (rare in Studio Mode), the Regenerate item is exposed; when a doc is loaded, the user is more likely to press `[Brief↩]` first, which gives them the form back.
- **The right inspector starts on Content tab; section / variant edits are one click away.** Acceptable.
- **Scene strip horizontal scroll on 50+ rows.** We add a "jump to scene N" input in the strip header + arrow-key navigation when a card is focused.

---

## 7 · Implementation plan

### 7.1 Architecture

The new layout is built on top of the existing `EditorView` shell (`src/components/production-doc/editor/EditorView.tsx`) and its writers in `src/components/production-doc/editor/types.ts`. We do not throw away that work; we extend it. New files live under `src/components/production-doc/editor/` so the structure stays coherent.

New top-level components:
- `BriefMode.tsx` — the four-step Notebook layout. Wraps existing input components.
- `StudioMode.tsx` — the three-column Studio layout. Wraps existing `Stage`, `SectionStrip`, `Inspector`.
- `StudioTopBar.tsx`, `StudioLeftRail.tsx`, `StudioRenderDock.tsx`, `StudioBulkGrid.tsx` — new chrome.
- `ProductionDocShell.tsx` — switches Brief / Studio based on `doc !== null` and animates the transition.

Existing components reused unchanged: `Stage`, `Inspector`, `SectionStrip`, `CheatSheet`, `NotesDock`, `BrollCell`, `OverlayCell`, `ImageCell`, `SectionThumbnailCard`, `SectionRowControls`, `PaintExplainerV1SettingsPanel`, `DoodleExplainer2MotionCollageSettingsPanel`, `PacingProfilePanel`, `StyleSheetPanel`, `VisualBrandKitOverridePanel`, `VideoPreviewBrandBar`, `VoiceoverPicker`, `AlignmentPill`, `HistoryPanel`, `StyleManagerDialog`, `MissingClipsModal`, `OverlayPositionEditor`, `OverlayEditDialog`, `OverlayContextMenu`, `TitleReviewPanel`, `MaskBrushEditor`, `MotionCollageRowEditor`, `OstModeControl`, `EditPanel`, `ImageLightbox`, `ImageGenThrottleToast`, `CharacterDescriptionsPanel`, `CopyForElevenLabs`, `NichePicker`, `AutocompleteInput`, `ModelSelector`, `SceneTimingControl`, `CollageTesterPanel`.

State stays on `page.tsx` (the giant central state container). The new shell receives that state as props. We do **not** restructure state management in this redesign — that's a separate refactor; this is purely a presentation reorganization.

### 7.2 Rollout phases

Each phase is independently shippable and can be QA'd in isolation. Behind a feature flag `PROD_DOC_REDESIGN_V1_ENABLED` (env-driven) so we can revert with a flip if a regression surfaces.

- **Phase R0 — scaffolding (1 PR).** Add the feature flag, add empty `ProductionDocShell`, `BriefMode`, `StudioMode`. When flag is off, `page.tsx` renders today's UI unchanged. When flag is on, renders the new shell which delegates to today's grid/editor under the hood (no visual change yet, just plumbing).
- **Phase R1 — Brief Mode (1–2 PRs).** Build the Notebook layout. Same inputs, same hooks, just reorganized. Visual diff but no behavior diff. QA: every single setting in the Brief still saves correctly to the doc-gen API body.
- **Phase R2 — Studio shell + top bar + left rail (1 PR).** Build chrome around the existing `Stage` / `SectionStrip` / `Inspector`. Mode switch (Brief ⇄ Studio) works. Bulk Grid sub-mode toggle works (renders the existing grid view inside the Studio shell).
- **Phase R3 — Inspector tab expansion (5 PRs).** Move every today-column control into the Inspector's tabbed structure. Biggest UI change in the plan. Sub-PR breakdown landed 2026-06-04:
  - **R3 PR1 (foundation):** `InspectorTabBar` component — 6 named tabs (Content, Image, Video, Overlay, Section, Variants) with current-tab state, no content yet. Not mounted; PR2 wires it.
  - **R3 PR2 (layout):** Three-column Studio layout. Top bar + Legend stay full-width. Below: a 200px left rail (vertical Legend, Filters placeholder) ⋄ 1fr center (children continue rendering here) ⋄ 380px right inspector mounting the empty `InspectorTabBar`. Banners and render section stay above/below the grid to avoid squashing. Requires the shell to accept a `mainContent` slot so banners can route around the grid; today's `children` becomes `mainContent`.
  - **R3 PR3 (content tab):** Wire the Content tab — script_text, ai_prompt, on_screen_text, visual_type, visual_description. Read-only first; editing in PR3b once the writers from `EditorView.types` are plumbed through.
  - **R3 PR4 (image tab — read-only preview):** First Image-tab body using `RowImageStateView`. Shows status + source + thumbnail + error message. No writers wired yet (rule 10 keeps the placeholder honest until they are). Scope refinement of the original "image + video + variants" plan because mounting today's `ImageCell` would require exporting it from page.tsx — saved for R3 PR4b.
  - **R3 PR4b (image tab — editable):** Add Generate / Re-generate / Upload / Import URL / Edit buttons. Plumbs the relevant `EditorWriters` slice through the shell.
  - **R3 PR4c (video tab):** Read-only B-roll preview using `RowVideoClipView`; then editable.
  - **R3 PR4d (variants tab):** Mount the existing `VariantPanel` from `editor/`.
  - **R3 PR5 (overlay + section tabs):** Mount `OverlayCell` + `OverlayPositionEditor` inside Overlay tab; consolidate `SectionThumbnailCard`'s 8 controls into the Section tab with grouped accordions (Layout · Title · Transition · Zoom · Fade · Color) so each group's Apply-to-all + Clear-all-overrides survive.
  - **R3 PR6 (legacy table conditional):** Hide the 13-column grid table when the flag is on and a row is selected — the inspector becomes the primary edit surface. The Bulk Grid sub-mode (top bar toggle) brings the table back for power editing. Per §15.1, the toggle is wired in this PR.
- **Phase R4 — Scene strip card redesign (1 PR).** Replace today's horizontal `SectionStrip` with the richer scene-card strip (status pills, variant badges, drag-to-reorder). Reuses existing `SectionStrip` selection model.
- **Phase R5 — Render dock + animations (1 PR).** Pinned bottom render dock with batch ops. Brief→Studio transition animation. Final polish pass.
- **Phase R6 — Flag flip (1 PR).** Default flag to on. Watch for regressions for a week. Remove the flag and the old grid-default code in a follow-up.

Each PR is small enough to review in 30 minutes. None of them are big-bang.

### 7.3 What I will NOT do (scope discipline)

- No edits to backend `/api/production-doc/*`, `/api/edit/*`, `/api/broll/*`, `/api/render/*`, `/api/user/settings/*`. The redesign is presentation only.
- No changes to `useProject`, `useEditorUndoStack`, `useSaveIndicator`. These hooks are battle-tested and their contracts stay.
- No changes to Remotion components. None.
- No changes to `productionDocToVideoConfig` or `parseTimecodeToMs`.
- No changes to the AI provider routing for image-gen / B-roll / overlay edit / forced-alignment.
- No new dependencies. Lucide icons are already used; nothing else gets added.

---

## 8 · Security (rule 13)

- No new data flows. No new endpoints, no new params, no new uploads, no new third-party calls. The redesign is reorganizing existing surfaces.
- The Brief→Studio handoff does not change auth state. Existing `useProject` auth checks, save-failure banners (no_session, unauthorized) are reused untouched.
- `EDITOR_V1_PUBLIC` flag continues to gate "Open in editor" — the redesign does not bypass it.
- Style preset star button (set as default) continues to require a PUT to `/api/user/settings/default-style` — unchanged.
- Right-click context menus do not introduce new commands; they show the same actions today's context menu does.
- File upload (Screenshot upload, Image Upload, Voiceover) flows are unchanged — all go through existing endpoints with existing validation.
- No client-side rendering of unsanitized user content. All user-provided text (creative brief, script, on-screen text, notes) flows through React's default escaping; no `dangerouslySetInnerHTML` is introduced.
- We do not log script content, creative brief content, or character descriptions to the console. We log row indexes, status codes, and counts. (See §9.)

Open: nothing security-blocking. The redesign is presentation, not policy.

---

## 9 · Observability (rule 14)

Existing namespace conventions are preserved (`[paint-explainer-v1 …]`, etc.). New namespaces for the redesign chrome:

- `[prodoc shell] mode-switch` — `{ from: 'brief' | 'studio', to, trigger: 'generate' | 'brief-button' | 'url-param' }`.
- `[prodoc shell] flag` — `{ enabled: boolean, source: 'env' | 'localstorage-override' }` (one-shot on mount).
- `[prodoc brief] step-collapsed` / `step-expanded` — `{ step: 'brief' | 'style' | 'script', collapsed: boolean }`.
- `[prodoc brief] cta-pressed` — `{ hasScript: boolean, hasNiche: boolean, styleId, modelId }` (before the generate call).
- `[prodoc studio] inspector-tab` — `{ rowIndex, tab: 'content' | 'image' | 'video' | 'overlay' | 'section' | 'variants', selectionTrigger: 'click' | 'keyboard' | 'restore' }`.
- `[prodoc studio] strip-select` — `{ rowIndex, signature, sceneCount }`.
- `[prodoc studio] strip-drag` — `{ from: number, to: number, mode: 'pointer' | 'keyboard' }` on commit only (not on every dragover).
- `[prodoc studio] sub-mode-toggle` — `{ to: 'scene-strip' | 'bulk-grid' }`.
- `[prodoc studio] filter-applied` — `{ visualTypesCount: number, motionCollageOnly: boolean, hasSearch: boolean, visibleRows, totalRows }`.
- `[prodoc render-dock] action` — `{ action: 'retry-all' | 'animate-all' | 'start-render', mediaCounts }`.

All logs use `console.info('[prodoc …] …', { … })` per the project convention. None of these logs include script content, voiceover URLs, or any user-personal data — only counts, ids, indexes, and statuses. Every namespace is greppable. Every log answers a likely "X did nothing" debug question with a concrete next step.

Plans get a dedicated test for the mode-switch log shape in §12.

---

## 10 · Settings audit (rule 15)

What should be user-controllable that the redesign introduces?

- **Default view mode** — should the page open in Studio sub-mode "Scene strip" or "Bulk grid"? Default: Scene strip. Setting lives in **Settings → Production Doc → Default Studio view**.
- **Brief Mode step defaults** — should the Style step be expanded or collapsed on open? Default: expanded only if the user hasn't picked a default style yet, else collapsed. Setting: **Settings → Production Doc → Always expand style section**.
- **Brief→Studio transition animation** — some users dislike motion. Default: animation on. Setting: **Settings → Accessibility → Reduce motion** (existing token, the redesign respects it; if `prefers-reduced-motion`, the transition is instant fade with no transform).
- **Inspector default tab** — should the inspector open on Content or last-used tab? Default: Content. Setting: **Settings → Production Doc → Remember last inspector tab**.

What is **deliberately not exposed**:
- The three-column ratios in Studio Mode (left rail / center / right inspector) are fixed at 200px / 1fr / 380px. Resizing is a feature creep risk; we'd need to persist per-user, handle keyboard accessibility, and decide on minimums. Out of scope for v1. If users ask, we add it as a tracked follow-up.
- The scene-strip card size. Fixed at 96 × 54px (16:9). One density only.
- Color of the variant accent rail. Fixed at the toned-down value in §5.

**Verified 2026-06-04:** the project has a settings page at `src/app/(app)/settings/page.tsx` with sections `editor`, `voiceover`, `qa`, `shorts` and corresponding `*Panel` components in `src/components/settings/`. There is no "production-doc" section yet. Phase R2 adds one: a new entry in the `activeSection` switcher + a new `ProductionDocPrefsPanel.tsx` that mirrors the existing `EditorPrefsPanel` structure and surfaces the four prefs above via `getPref/setPref`. This is additive — no existing setting is moved or renamed.

---

## 11 · Risks, tradeoffs, and brutal honesty (rule 12)

- **This is a big PR sequence even split into 6 phases.** Roughly 2–4k LOC of UI changes across `production-doc/**`. The risk is not architectural; it is regression by attrition. Mitigation: feature flag (R0), small PRs, full QA pass after each phase, and the §3 mapping table as the test contract.
- **The Inspector tab consolidation is the highest-risk piece.** Today, controls live in specific components (`SectionThumbnailCard`, `OverlayCell`, etc.) with their own `Apply to all` / `Clear all overrides` plumbing. Reparenting them into Inspector tabs means re-wiring callbacks. We mitigate by keeping the components themselves and just relocating their mount points — no rewriting of internals.
- **The user wanted "amazingly beautiful, smooth, intuitive."** Beautiful is subjective; this plan defines specific anti-AI-tell rules (§5) and a token system, but the actual visual quality depends on execution. We will pause after Phase R2 to do a real visual review before going further, so the user can redirect early.
- **"Bulk grid" sub-mode means the today-table sticks around as a code path.** That's a maintenance cost. Tradeoff accepted: the user explicitly said nothing is removed, and the bulk grid IS a useful editing mode for 50-scene docs. If after a month of usage telemetry shows < 5% of doc-edits happen in bulk mode, we revisit.
- **The Brief→Studio transition is animation-heavy.** Some users will find it slick, others will find it slow. Default animation duration is conservative (180ms). Respect `prefers-reduced-motion`.
- **`page.tsx` stays huge.** This redesign reorganizes the surface but does not split the central state container. That's a known tech-debt item; addressing it would be a separate refactor with its own plan. **Brutal honesty:** if we wanted to make the codebase as clean as the UI, we'd need to split `page.tsx` into a hook-based store + dumb components. That's not what the user asked for, and it would triple the PR size. We accept the surface inconsistency for v1.
- **The Phase 3 `EditorView` and its writers were built recently.** The redesign builds on top of it rather than replacing it. If `EditorView` itself has bugs (e.g., undo stack edge cases), they'll be amplified by being the new default. We add explicit Phase R3 QA for undo/redo across every inspector tab.
- **One thing I am not confident about:** whether the user will love the scene-strip card design vs prefer a vertical scene-list (Notion-row style). The mock shows horizontal because it's the most preview-friendly, but vertical scenes-as-rows with image-left + controls-right is a real alternative I considered. Calling it out explicitly so the user can flip it before Phase R4 if they want.

---

## 12 · Testing (rule 18)

Per rule 18, every code change ships with tests. Specific to this redesign:

### Unit tests
- `BriefMode.test.tsx` — every step renders, every input mutates the central state via the existing setter props, the Generate button enable/disable logic matches today's `generating || !script.trim() || !niche.trim()`.
- `StudioMode.test.tsx` — mode switch on `doc !== null`, top bar buttons fire the right handlers, sub-mode toggle preserves selection.
- `StudioInspector.test.tsx` — every tab renders the right child component for a selected row, the default doc-level state renders the right doc-level controls, switching tabs preserves form state when the same row stays selected.
- `StudioSceneStrip.test.tsx` — cards render with correct status pills given mock `rowImages` / `rowVideoClips` / `rowOverlays`, click → onSelect, drag → onReorder with correct indices, keyboard arrow nav works.
- `StudioBulkGrid.test.tsx` — same row rendering as today, same inline-edit behaviors, toggling out preserves selection.
- `mode-transition.test.tsx` — Brief → Studio transition emits the right observability log, respects `prefers-reduced-motion`, does not unmount the central state hooks.

### Integration tests
- A test that walks Scenario A in §6 end-to-end on a mocked doc-gen API: type, generate, preview, click row, edit script, save, render trigger.
- A regression test for the §3 contract: a snapshot test that asserts every feature listed has a corresponding DOM element / aria-label in the new layout. This is the explicit guard against the "we lost a feature" failure mode.

### Manual QA checklist (run after every phase)
Tied 1:1 to the §3 table. For each row in §3, a single line in the checklist: "Find feature X. Verify it works."

### What is NOT tested by automated tests
- Visual beauty (subjective).
- The Remotion preview render output (existing tests cover this).
- Specific animation timings (covered by manual review).

### Test framework
Existing stack is sufficient — `vitest` for unit, `@testing-library/react` for component, no new framework added.

---

## 13 · Cost (rule 8)

Zero new paid services, zero new API calls, zero new infra. The redesign is presentation only. No cost impact.

---

## 14 · Alternatives considered (rule 4)

### Alternative A — "Brief drawer + always-Studio"
Always render Studio Mode. Brief lives in a left drawer that auto-opens pre-doc and auto-closes post-doc.
- **Why I rejected:** the lazy-user walkthrough for a brand-new user (Scenario A) becomes worse — they land on a Studio shell with no doc in the preview, no scenes in the strip, and a drawer they have to discover. The Notebook step-by-step in Brief Mode is too good a first-time experience to give up.

### Alternative B — "Single scrolling page with embedded Studio panel"
One long page; top is Brief, bottom transforms into a Studio panel once a doc exists.
- **Why I rejected:** the scroll context fights the preview-pinning. You'd either lose the preview while scrolling through the brief, or pin the preview and re-fight the layout for room. The mode-switch in this plan's recommendation solves that cleanly.

### Alternative C — recommended (this plan): "Two-mode page with smooth transition"
Brief Mode (Notebook) → Studio Mode (Studio). Mode switches on `doc !== null`. Brief is always reachable from Studio via `[Brief↩]`. Studio has a Bulk Grid sub-mode for power users.
- **Why recommended:** best fit for the user's three biggest pain points (workflow order, awkward bottom editor, clutter), preserves every feature, builds on existing `EditorView`, ships in 6 small phases, and degrades gracefully to a flag flip if anything goes wrong.

---

## 15 · Decisions locked in (2026-06-04)

1. **Scene strip orientation:** ship **both** — horizontal carousel AND vertical Notion-row list. User picks via a toggle in `[STUDIO/top]` next to the `[Bulk grid ▦]` button. The toggle is sticky per-user via `getPref('prodoc_scene_strip_orientation')` with default `'horizontal'`. Implementation: a shared `SceneStrip` component with a `layout: 'horizontal' | 'vertical'` prop, two render branches sharing one selection / drag / keyboard-nav model.
2. **Default Studio sub-mode:** Scene strip. Bulk grid is the one-click escape hatch.
3. **Brief Mode on return:** auto-collapse Brief, stay in Studio. The `[Brief↩]` button in `[STUDIO/top]` opens the Brief as a sheet over Studio when the user wants to tweak inputs and re-generate.
4. **Transition animation:** animated (~180ms fade + soft transform), respects `prefers-reduced-motion` (instant fade when set). No bounce, no spring.

### Still open

5. **Settings layer existence:** does the project already have a "Production Doc" group in Settings? If not, OK to add it in Phase R2 with the four prefs from §10? (I'll verify the codebase before the next round of questions instead of guessing.)
6. **Mobile:** confirm desktop-first is OK and the "Studio Mode is desktop-only on narrow viewports, switch to Bulk Grid" notice is acceptable.

---

## 16 · Decision log (to be filled as we go)

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-04 | Plan drafted | Initial proposal awaiting approval |
| 2026-06-04 | Scene strip = both orientations (toggle) | User wants horizontal AND vertical, picked via toggle |
| 2026-06-04 | Default sub-mode = Scene strip | Recommended path accepted |
| 2026-06-04 | Brief on return = collapsed, stay in Studio | Recommended path accepted |
| 2026-06-04 | Transition = animated + reduced-motion respect | Recommended path accepted |
| 2026-06-04 | Settings layer = new "Production Doc" section in Phase R2 with all 4 prefs | User approved; verified settings page pattern in codebase |
| 2026-06-04 | Mobile = desktop-first, narrow viewport routes to Bulk Grid with notice | Recommended path accepted |
| 2026-06-04 | §4 mocks + §3 contract approved | Start Phase R0 scaffolding |
| 2026-06-04 | Phase R0 merged | `6d18c42` |
| 2026-06-05 | Flag flipped (R6 — default ON, opt-out) | Plan complete. Legacy code paths stay for a few weeks as rollback insurance; cleanup PR follows once production confirms stable. |

---

**END OF PLAN.** No code is written until the user approves the §4 mocks and answers the §15 questions.
