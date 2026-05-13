# 2026-05-13 — Thumbnail zoom + section-title stripe for production-doc renders

**Status: ✅ Shipped 2026-05-13**

End-to-end implementation complete, typecheck clean, lint clean on all
touched files, and a full QA + code-review pass (CLAUDE.md rule 6) was
performed at the end. Ready for real content.

What landed:

- Upload + replace flow ([POST /api/production-doc/thumbnail/upload](../src/app/api/production-doc/thumbnail/upload/route.ts),
  card at [SectionThumbnailCard.tsx](../src/components/production-doc/SectionThumbnailCard.tsx)).
- Visual region editor with drag-to-draw, click-to-select, 8-handle
  resize, sidebar with mini-previews + hover-to-highlight, arrow-key
  nudge, snap to edges (draw + move + resize), undo + redo, localStorage
  draft, scale-up + fade-out animations — see [ThumbnailRegionEditor.tsx](../src/components/production-doc/ThumbnailRegionEditor.tsx).
- Per-row controls (Zoom to, Section title, Transition override) with
  mini-preview crop in each row, on both desktop AND mobile —
  [SectionRowControls.tsx](../src/components/production-doc/SectionRowControls.tsx).
- Doc-level default transition button + Title-stripe height slider on
  the card.
- Shared [TransitionDialog](../src/components/production-doc/TransitionDialog.tsx) (kind / speed / easing) used for both per-row override and doc-level default.
- Patrick Hand font loaded via `@remotion/google-fonts/PatrickHand`.
- [SectionTitleStripe](../src/remotion/components/SectionTitleStripe.tsx) — white band with fade+slide-in, applied to ANY scene type when `shot.sectionTitle` is set.
- [ThumbnailZoomScene](../src/remotion/scenes/ThumbnailZoomScene.tsx) with both transition kinds:
  - Hard-cut: hold-full → spring zoom → hold-region.
  - Smooth: zoom-out from previous region → contain → zoom-in to target,
    when the previous shot was also a thumbnail-zoom. Degrades cleanly
    when it wasn't.
- Scene router in [YouTubeVideo.tsx](../src/remotion/compositions/YouTubeVideo.tsx) dispatches to `ThumbnailZoomScene` only when both `shot.thumbnailZoomTo` and a matching region resolve — otherwise falls through to the inferred scene type silently.
- Safety clamps in the scene math (NaN / zero dimensions can't produce
  Infinity transforms or kill the render).
- Stripe height clamped to `[0.06, 0.22]` at render time so bad config
  can't produce invisible or overwhelming bands.

**Required to actually see it render:**

1. `npm run deploy:remotion` so Lambda + the in-app preview pick up the
   new scene, font, and `stripeHeightFraction` plumbing.
2. Upload your real thumbnail in the production-doc page, mark regions,
   assign rows, render.

**Conscious limitations** (low-value-to-fix, documented for the next
maintainer):

- Dangling `thumbnail_zoom_to` after region deletion shows "— No zoom —"
  in the dropdown silently rather than auto-clearing the row data.
- Pointer-up outside the browser window mid-drag relies on
  `setPointerCapture`; no `pointerleave-window` fallback.
- Studio preview (`npx remotion studio`) renders `DEMO_CONFIG` which has
  no thumbnail — Studio won't show the zoom unless a real config is
  loaded via the production-doc preview path.

## Goal

A creator uploads a single composite "thumbnail" image (typically a grid
of N tiles, one per video section), marks each tile's rectangle in a
simple visual editor, and then references those rectangles from
production-doc rows. At render time, the video opens on the full
thumbnail, the camera flies in on the first tile while the narrator
says its title coldly, then cuts to the section's content. At each
section boundary, the camera returns to the full thumbnail and zooms
to the next tile. A small fixed title stripe sits at the top of the
frame throughout each section, rendered in the matching font.

Grids are not always 2×3. The number, position, and aspect ratio of
tiles vary — confirmed by user. So the system needs region-defining
input from the creator; no auto-grid detection.

## In scope

- Region editor UI on the production-doc page: upload thumbnail, draw
  named rectangles, edit/delete, save.
- New scene type `thumbnail-zoom` plus a small `<SectionTitleStripe>`
  overlay component for use across any scene.
- VideoConfig + VideoShot fields to carry thumbnail data and per-row
  zoom targets.
- Configurable transition behavior: hard-cut OR smooth zoom-out-then-in
  between sections, with editable speed.
- Patrick Hand font loaded for the section title stripe (uses the
  fonts plan's per-channel font system).

## Out of scope (v2+)

- Auto-detection of regions from a thumbnail image (LLM vision call).
  Defer until creators tell us the manual editor is the bottleneck.
- More than rectangular regions. No polygons, no circles, no rotated
  rectangles in v1. Rectangles cover every example we've seen.
- Multi-thumbnail per video. v1 = one thumbnail per VideoConfig. If a
  longer video needs section dividers from two different reference
  images, defer.
- Inline-rendered region labels (showing "Reconnaissance" floating on
  the thumbnail during the zoom). Section title stripe at top of frame
  already covers this need.

## Data model

### New `thumbnail` on `VideoConfig`

```ts
export interface VideoThumbnail {
  imageUrl: string;     // Vercel Blob URL of the composite thumbnail
  width: number;        // intrinsic pixel width (used for region math)
  height: number;       // intrinsic pixel height
  regions: ThumbnailRegion[];
  /** Default transition params; per-shot can override. */
  defaultTransition?: ThumbnailTransitionConfig;
}

export interface ThumbnailRegion {
  id: string;           // stable uuid; never user-visible
  label: string;        // 'Reconnaissance' — what the creator typed
  x: number;            // top-left in intrinsic pixels
  y: number;
  w: number;
  h: number;
}

export type ThumbnailTransitionKind = 'hard-cut' | 'smooth';

export interface ThumbnailTransitionConfig {
  kind: ThumbnailTransitionKind;
  /** Frames the full thumbnail dwells before the zoom starts. */
  holdAtFullMs?: number;     // default 500
  /** Frames the zoom takes to settle on the target tile. */
  zoomDurationMs?: number;   // default 1000
  /** Frames camera dwells on tile before content cut. */
  holdAtTargetMs?: number;   // default 600
  /** Easing applied to the zoom curve. */
  easing?: 'spring-snappy' | 'spring-smooth' | 'spring-gentle';
  // default 'spring-smooth'
}

export interface VideoConfig {
  // ... existing fields
  thumbnail?: VideoThumbnail;
}
```

### New `VideoShot` fields

```ts
export interface VideoShot {
  // ... existing fields
  /** When set, this shot becomes a thumbnail-zoom scene that lands on
   *  `thumbnail.regions.find(r => r.id === thumbnailZoomTo)`. */
  thumbnailZoomTo?: string;
  /** Per-shot transition override. Falls back to thumbnail.defaultTransition. */
  thumbnailTransition?: ThumbnailTransitionConfig;
  /** Section title stripe shown at the top of frame for this shot's
   *  full duration. Stripe is on its own component, usable from any
   *  scene type (not only thumbnail-zoom). */
  sectionTitle?: string;
}
```

The `thumbnail` field lives on the **production-doc record** in the
database (not on every render call's `inputProps`) so re-renders of
the same doc don't re-upload it. Per-shot fields live on the existing
production-doc-row JSON.

## DB changes — REVISED 2026-05-13 (no migration needed)

Pre-implementation read of the actual codebase found that:

- The production-doc editor at [src/app/(app)/production-doc/page.tsx](../src/app/(app)/production-doc/page.tsx)
  works against `ProductionDocHistoryEntry` records (stored in
  `user_history` via the [history library](../src/lib/history.ts)).
  The doc itself is the `doc: unknown` JSON field of that entry.
  `pipeline_stage_artefacts` is for the auto-pipeline path, a different
  surface.
- Adding `thumbnail` as a top-level field on `ProductionDoc` JSON is
  cleaner: the image URL + regions + transition defaults live
  alongside `title`, `rows`, `total_duration` — one source of truth,
  zero new SQL.

**Net: no migration.** Thumbnail data lives as a new optional field on
the existing `ProductionDoc` interface, persisted through the existing
history save/update path with no server changes for storage.

## API changes

1. **`POST /api/production-doc/[id]/thumbnail/upload`** — multipart
   image upload. Stores to Vercel Blob, writes
   `thumbnail_jsonb.imageUrl` + extracted intrinsic dimensions.
   Returns `{ imageUrl, width, height }`.
2. **`PATCH /api/production-doc/[id]/thumbnail/regions`** —
   `{ regions: ThumbnailRegion[] }`. Replaces the regions array
   wholesale. Server validates rectangles are in-bounds; deduplicates
   ids.
3. **`PATCH /api/production-doc/[id]/rows/[rowIndex]`** — existing-ish
   patch route, extended to accept `thumbnailZoomTo`, `sectionTitle`,
   `thumbnailTransition`. (If no such patch route exists today, this
   plan introduces it — confirm during phase 3.)

All authed + workspace-scoped per the project's `apiRoute.authed`
pattern.

## Remotion scene component

New file `src/remotion/scenes/ThumbnailZoomScene.tsx`. Sketch:

```tsx
export const ThumbnailZoomScene: React.FC<Props> = ({
  shot, durationInFrames, brand, thumbnail,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const region = thumbnail.regions.find(r => r.id === shot.thumbnailZoomTo);
  if (!region) return <BasicFallback shot={shot} brand={brand} />;

  const t = shot.thumbnailTransition ?? thumbnail.defaultTransition ?? DEFAULTS;
  const holdAtFullFrames = msToFrame(t.holdAtFullMs ?? 500, fps);
  const zoomFrames        = msToFrame(t.zoomDurationMs ?? 1000, fps);

  // 0..1 progress along the zoom curve, with hold-at-full as the dead zone
  const rawProgress = (frame - holdAtFullFrames) / zoomFrames;
  const progress = clamp(rawProgress, 0, 1);
  const eased = applyEasing(progress, t.easing, fps);

  // Transform math: at progress=0, scale 1, no translate (full image
  // fills the frame). At progress=1, the region exactly fills the frame.
  const scale = interpolate(eased, [0, 1], [1, frameToRegionScale(region, width, height)]);
  const tx    = interpolate(eased, [0, 1], [0, -region.x * scale]);
  const ty    = interpolate(eased, [0, 1], [0, -region.y * scale]);

  return (
    <AbsoluteFill style={{ background: brand.backgroundColor, overflow: 'hidden' }}>
      <img
        src={thumbnail.imageUrl}
        style={{
          width: `${thumbnail.width}px`,
          height: `${thumbnail.height}px`,
          transformOrigin: '0 0',
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          willChange: 'transform',
        }}
      />
      {shot.sectionTitle && <SectionTitleStripe text={shot.sectionTitle} brand={brand} />}
    </AbsoluteFill>
  );
};
```

`frameToRegionScale(region, w, h) = max(w / region.w, h / region.h)` so
the region fills the frame on at least one axis. Letterboxing on the
other axis is OK and matches the source thumbnail's framing.

### Section title stripe

`src/remotion/components/SectionTitleStripe.tsx` — a separately
reusable overlay. Renders as a fixed band at the top of the frame
with the section title in Patrick Hand (when loaded; falls back to
`brand.titleFontFamily`). Used by `ThumbnailZoomScene` and by any
other scene that has `shot.sectionTitle` set.

```tsx
export const SectionTitleStripe: React.FC<{ text: string; brand: BrandKit }> = ({ text, brand }) => (
  <div style={{
    position: 'absolute', top: 0, left: 0, right: 0,
    height: '14%', background: '#FFFFFF',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
  }}>
    <span style={{
      fontFamily: brand.titleFontFamily,
      fontSize: 96, fontWeight: 400,
      color: brand.titleColor,
      letterSpacing: -0.5,
    }}>{text}</span>
  </div>
);
```

(The font size and stripe height are starting points and likely the
first thing the creator will want to tune. They go on the brand kit in
the fonts plan.)

## Region editor UI — the "easy beautiful clean intuitive" piece

User explicitly asked for high-quality UX here. Specs:

**Layout (modal):**
- Full-screen modal, dark backdrop, centered card.
- Title bar: "Mark thumbnail regions" + close (×) on the right.
- Main area: the thumbnail image, scaled to fit viewport with a max
  width / height so it always shows fully. Subtle checkered background
  visible at the edges to make the image's extent obvious.
- Right sidebar (240px): a list of regions with their labels and
  color chips, plus "Delete" buttons on hover. Empty state: "Drag on
  the image to mark a region."

**Drawing:**
- Cursor changes to a crosshair when hovering over empty image area.
- Press-and-drag from any empty point draws a new rectangle. Live
  outline as you drag. Release to commit.
- Once committed, the rectangle gets a soft-color fill (auto-picked
  from a curated palette of 10 colors that cycle) and a label input
  appears in its top-left corner, auto-focused. Type the label, press
  Enter to confirm. Click outside to cancel and roll back the rect.

**Editing existing regions:**
- Hover → rectangle lifts slightly (subtle shadow + 1px brighter
  border).
- Click → selected. Selected rectangle shows 4 corner handles + 4 edge
  handles. Drag a corner / edge to resize. Drag the body to move.
- Press Delete or Backspace → remove (with undo toast).
- Click the label → inline edit.
- Click empty area → deselect.

**Keyboard shortcuts (small but high-leverage):**
- `Delete` / `Backspace` → remove selected region.
- `Esc` → deselect / cancel current draw.
- `Enter` → commit label edit.
- `Ctrl/Cmd+Z` → undo last change (up to last 20).

**Right sidebar:**
- Each entry shows the colored swatch, the label (inline-editable
  here too), and a mini-preview of the region cropped from the
  thumbnail (24×16 thumb image). Hovering an entry highlights its
  rectangle on the main image.
- "Save" and "Cancel" buttons at the bottom of the modal.

**Save semantics:**
- Save → PATCH the regions array. Modal closes. Production-doc page
  re-renders with the new regions available in the per-row dropdowns.
- Cancel → discard local edits, close.

**Polish details:**
- Animation on rectangle commit (small scale-up to 1.0 from 0.96).
- Animation on delete (fade-out + slight scale-down).
- "Snap to image edges" when drawing within 4px of the bounding box —
  helps creators line up to the thumbnail's outer margin.
- Auto-save draft to localStorage on every change, restore on modal
  reopen if save was never clicked.

**Library choice:**
- Build with plain HTML divs + pointer events. ~250 lines. No new dep.
- Considered `react-rnd` — adds a dep, but the resize/drag logic is
  simple enough that custom is the cleaner path.

## Per-row picker UI

In the production-doc page, each row gets two small new controls
inline next to its existing image/voiceover/notes fields:

1. **Zoom to** — a dropdown listing the regions defined in the
   thumbnail editor. Empty option = no zoom. Selecting a region
   automatically sets `sceneType = 'thumbnail-zoom'` for that row.
2. **Section title** — a single-line text input. Default empty.
   When non-empty, the title stripe shows on top of frame for that
   row's duration. (Note: not the same as `onScreenText`. Stripe is
   fixed, large, full-width at top; on-screen text is lower-third.)
3. **Transition override** (collapsible) — kind (hard-cut / smooth),
   speed (single slider that scales both `holdAtFullMs` and
   `zoomDurationMs` proportionally), easing. Empty = use the doc's
   default. Collapsible so it's only visible when the creator wants
   to tune it.

## End-to-end render flow

```
Creator opens /production-doc/<id>
        │
        ├─ Upload thumbnail (one-time per doc) ──► VideoBlob, regions=[]
        │
        ├─ Open Region Editor modal
        │       └─ Draw rectangles, label them, Save ──► regions[]
        │
        ├─ For each section row:
        │       ├─ Zoom to: <region dropdown>
        │       ├─ Section title: <text>
        │       └─ (optional) Transition override
        │
        ▼
Render kicked off → productionDocToVideoConfig builds:
  - VideoConfig.thumbnail = { imageUrl, width, height, regions, defaultTransition }
  - Per-row shots with `thumbnailZoomTo`, `sectionTitle`, `thumbnailTransition`
        │
        ▼
Remotion renders ThumbnailZoomScene for those rows, regular scene
components for the rest, with SectionTitleStripe applied wherever
`sectionTitle` is set.
```

## Transitions: detailed semantics

Two kinds, both with the same parameters; difference is what happens
between consecutive thumbnail-zoom shots.

### Hard-cut (default)

Each thumbnail-zoom shot is independent. Shot N ends on its target
tile, then shot N+1 starts on the full thumbnail (fresh). Cut is
immediate, no smooth animation between them. Most energetic, most
punchy. Good for cybersecurity-style content.

### Smooth zoom-out-then-in

Between consecutive thumbnail-zoom shots, the camera animates from
the previous target back to the full thumbnail, then immediately
forward to the next target. Total transition time = 2 × zoom duration
+ optional dwell-at-full.

Implemented by detecting "this shot starts on full and the previous
shot ended on a tile" and inserting a brief opening zoom-out phase
into the new shot, scaling in from the previous tile's transform
state. The math is the same `interpolate` — just two phases instead of
one.

Per-shot override (`thumbnailTransition`) wins over the doc's default,
so the creator can mix styles within one video if they want.

## Security (rule 13)

- The thumbnail upload route validates content-type (image/jpeg,
  image/png, image/webp) and size cap (default 5 MB). No SVG —
  embedded script vector.
- The regions PATCH validates `0 ≤ x, y` and `x + w ≤ thumbnail.width`
  and `y + h ≤ thumbnail.height`. Out-of-bounds → 400.
- All routes are authed + workspace-scoped. A creator can only modify
  thumbnails on production docs they own.
- The thumbnail Vercel Blob URL is public (matches the existing image
  upload pattern) — acceptable because thumbnails are designed to be
  shown to viewers anyway. No additional surface.

## UX walk-through (rule 10)

The lazy-user path:

1. Open `/production-doc/<id>`. Near the top, a "Section divider
   thumbnail" card. Empty state: "Upload a thumbnail image to enable
   section zoom-ins." Single dropzone.
2. Drag-drop the thumbnail. Card fills with a preview + "Mark regions"
   button.
3. Click "Mark regions". Modal opens, image fills the viewport.
4. Drag rectangles, label them. Save.
5. Modal closes. Each production-doc row now has a "Zoom to" dropdown.
   Pick the region for each section's intro row.
6. (Optional) Type a `Section title` per row to add the stripe at the
   top of frame for that section.
7. Render. The video opens on the full thumbnail, zooms to region 1,
   plays section 1, hard-cuts back to the full thumbnail, zooms to
   region 2, plays section 2, repeat.

**What if the creator forgets to assign a Zoom to** on a row that
inherits `sceneType='thumbnail-zoom'`? The scene falls back to
`BasicFallback` (just shows the full thumbnail with a faint warning
overlay in dev mode, silent in prod). Render doesn't fail.

## Decision log

- **No auto-grid detection.** User said grids vary; manual editor is
  the only sane v1.
- **Rectangles only.** Polygons are a vanity feature for v1.
- **One thumbnail per video.** Multi-thumbnail support adds UI
  complexity for a rare case.
- **Sidebar with mini-previews** in the editor — high signal-to-cost
  ratio for "easy beautiful clean UX." Small render cost; large
  confirmation value.
- **Custom drawing UI, not `react-rnd`.** Saves a dep, full control
  over the polish details the user asked for.
- **Both transitions configurable, hard-cut as the default.** User
  confirmed (2026-05-13): wants both kinds available and selectable per
  video, with editable speed. Hard-cut stays default because it matches
  the cybersecurity-explainer energy; smooth is one toggle and a speed
  slider away. Per-shot override allows mixing inside one video.
- **Section title stripe is its own component**, usable by any scene
  type. Decoupling pays off whenever the creator wants the stripe
  without a thumbnail zoom (e.g., the section's content shots).
- **No LLM Council pass.** Design space is well-understood (image
  cropping editors are well-trodden). If user finds the UX clunky
  in practice, council the redesign then.

## Phases

### Phase 1 — Data model + scene component (½ day)
- New types in `src/remotion/types.ts`.
- `src/remotion/scenes/ThumbnailZoomScene.tsx` + math.
- `src/remotion/components/SectionTitleStripe.tsx`.
- Hard-cut transition first; smooth in Phase 4.
- Wire into `YouTubeVideo` composition's `SceneRouter`.

### Phase 2 — DB + read/write API (½ day)
- Migration `0067_add_production_doc_thumbnail.ts`.
- POST upload, PATCH regions, PATCH per-row endpoints.
- Existing `productionDocToVideoConfig` reads the thumbnail and
  forwards into `VideoConfig`.

### Phase 3 — Region editor UI (1½ days)
- Modal scaffold + image display + viewport math.
- Pointer events for draw / select / drag / resize.
- Right sidebar with mini-previews.
- Keyboard shortcuts.
- Undo (linear history, 20 steps).
- localStorage draft autosave.

### Phase 4 — Production-doc page per-row controls (½ day)
- "Zoom to" dropdown, "Section title" input, "Transition override"
  collapsible per row.
- Inline preview indicator (a tiny dot in the row's color matching
  the region's color, so the creator can scan the doc and see which
  rows are assigned).

### Phase 5 — Smooth transition + polish (½ day)
- Implement the smooth `kind = 'smooth'` math.
- Tweak default timing values based on a real render.
- Easing curve options wired through the picker.

### Phase 6 — Validation (¼ day)
- Render the ransomware CSV with a fabricated 6-tile thumbnail and
  one zoom per section. Verify hard-cut and smooth both look right.
- Verify section title stripe stays legible at 1080p.

**Total: ~3½ days of focused work.**

## Effort

| Phase | Effort |
|---|---|
| 1. Data model + scene component | ½ day |
| 2. DB + read/write API | ½ day |
| 3. Region editor UI | 1½ days |
| 4. Per-row controls | ½ day |
| 5. Smooth transition + polish | ½ day |
| 6. Validation | ¼ day |

**Estimate: 3½ days, no dependencies beyond a working thumbnail-upload
path (which is `@vercel/blob`, already wired).**
