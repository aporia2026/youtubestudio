// ─── Scene Types ───────────────────────────────────────────────────────────────

export type SceneType =
  | 'title-card'      // Bold title text, optional subtitle — for intros, section headers
  | 'b-roll'          // Image/illustration with Ken Burns animation
  | 'text-reveal'     // Text-only shot, words reveal one by one
  | 'icon-scene'      // Flat illustration style: white bg, icons/characters, bold title
  | 'screen-mockup'   // Shows a UI/app screenshot in a device frame
  | 'split-scene'     // Two items side by side (comparison, before/after)
  | 'outro';          // End card with CTA

// ─── Brand Kit ─────────────────────────────────────────────────────────────────

export interface BrandKit {
  primaryColor: string;    // Main accent color, e.g. "#FF4444"
  secondaryColor: string;  // Secondary accent, e.g. "#222222"
  backgroundColor: string; // Scene background, e.g. "#FFFFFF"
  textColor: string;       // Body text color, e.g. "#111111"
  titleColor: string;      // Title text color
  fontFamily: string;      // CSS font-family string
  titleFontFamily: string; // Separate font for bold titles
  logoUrl?: string;        // Optional logo URL for intros/outros
  channelName?: string;    // Channel name for outros
}

export const DEFAULT_BRAND_KIT: BrandKit = {
  primaryColor: '#FF0000',
  secondaryColor: '#222222',
  backgroundColor: '#FFFFFF',
  textColor: '#111111',
  titleColor: '#111111',
  fontFamily: 'Inter, system-ui, sans-serif',
  titleFontFamily: 'Inter, system-ui, sans-serif',
};

// ─── Section-divider Thumbnail (Phase 1 of the thumbnail-zoom feature) ────────
//
// A composite thumbnail (typically a grid of N labelled tiles) the
// creator uploads once per production-doc. At render time, intro shots
// can zoom from the full thumbnail into a specific tile while the
// narrator announces that section. See `_plans/2026-05-13-thumbnail-zoom-section-divider.md`.

export type ThumbnailTransitionKind = 'hard-cut' | 'smooth' | 'none';

export interface ThumbnailTransitionConfig {
  kind: ThumbnailTransitionKind;
  /** Frames the full thumbnail dwells before the zoom starts. */
  holdAtFullMs?: number;
  /** Frames the zoom takes to settle on the target tile. */
  zoomDurationMs?: number;
  /** Frames camera dwells on tile before content cut. */
  holdAtTargetMs?: number;
  /** Easing applied to the zoom curve. */
  easing?: 'spring-snappy' | 'spring-smooth' | 'spring-gentle';
}

export interface ThumbnailRegion {
  /** Stable id; never user-visible. Used by VideoShot.thumbnailZoomTo. */
  id: string;
  /** Creator-supplied label (e.g. "Reconnaissance"). */
  label: string;
  /** Rectangle in intrinsic-image pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VideoThumbnail {
  /** Vercel Blob URL of the composite image. */
  imageUrl: string;
  /** Intrinsic pixel width — needed to map region rectangles to frame. */
  width: number;
  /** Intrinsic pixel height. */
  height: number;
  /** All regions the creator drew. Empty array = uploaded but not yet marked. */
  regions: ThumbnailRegion[];
  /** Doc-level default transition; per-shot can override via VideoShot.thumbnailTransition. */
  defaultTransition?: ThumbnailTransitionConfig;
  /** Height of the section-title stripe as a fraction of frame height.
   *  Range 0.06–0.22 (clamped at render time). Default 0.13 (~140px @ 1080p). */
  stripeHeightFraction?: number;
}

// ─── Video Shot ─────────────────────────────────────────────────────────────────

export interface VideoShot {
  /** Start time in milliseconds */
  startMs: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Scene type — determines which scene component renders this shot */
  sceneType: SceneType;
  /** Editorial type from the source row — Title Card / Animation /
   *  Statistics / B-Roll / blank. Threaded through so the editor's
   *  ShotKindBadge can resolve the same label the inspector's Shot type
   *  dropdown shows, without the timeline / left-rail caller needing
   *  separate access to `doc.rows[i]`. Renderer ignores; this is
   *  purely an editor-UI surface. */
  visualType?: string;
  /** Variant grouping — when the row belongs to a variant group of
   *  shots that share a base image. `groupId` identifies the group;
   *  `variantIndex` is 0 for the base, 1+ for siblings. Threaded so
   *  the editor's badge can show BASE vs VAR chips on each thumb. */
  groupId?: string;
  variantIndex?: number;
  /** Image URL for this shot (b-roll, icon-scene, screen-mockup) */
  imageUrl?: string;
  /** Optional animated B-roll clip URL. When present, the scene renders a
   *  video instead of Ken-Burns-ing the still. Populated from a ready
   *  `broll_clips` row keyed by row signature. Clip duration may be
   *  shorter than `durationMs` — Remotion freezes the last frame for the
   *  remainder. See `_plans/2026-05-14-image-to-video-animation-rows.md`. */
  videoUrl?: string;
  /** Intrinsic duration (seconds) of the clip referenced by `videoUrl`.
   *  Used by BRollScene to fit the playback rate to the scene duration
   *  so a 10s clip in a 7s scene doesn't freeze and a 10s clip in a 15s
   *  scene doesn't stop mid-narration. Falls back to a sensible default
   *  inside the scene when missing (legacy clips with no duration field).
   *  See `_plans/2026-05-17-clip-duration-fit.md`. */
  videoDurationSeconds?: number;
  /** Bold title text shown at top of frame */
  title?: string;
  /** Subtitle or secondary text */
  subtitle?: string;
  /** On-screen overlay text (lower third style). Only populated when the
   *  source row's `on_screen_text_mode === 'overlay'` — for `'bake'` and
   *  `'none'` rows the mapper omits this field so the LowerThird stays
   *  off. See `_plans/2026-05-21-phase-5-text-mode-toggle.md`. */
  onScreenText?: string;
  /** Per-shot multi-block OST. PR 4 of
   *  `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
   *  Renderer ignores this until PR 6 wires per-block composition;
   *  threaded through now so the editor's persist + load round-trip
   *  is wired and existing-shape rows keep rendering unchanged.
   *  See `OnScreenTextBlock` in `remotion/utils.ts` for the structural
   *  type (re-stated here would force a duplicate definition; the
   *  renderer-side VideoShot stays the structural mirror it has been
   *  for every other multi-cell field). */
  onScreenTextBlocks?: Array<{
    id: string;
    text: string;
    x_pct: number;
    y_pct: number;
    scale: number;
    anchor?:
      | 'top-left' | 'top-center' | 'top-right'
      | 'center-left' | 'center' | 'center-right'
      | 'bottom-left' | 'bottom-center' | 'bottom-right';
    variant?: 'default' | 'doodle-yellow';
    rotation_deg?: number;
  }>;
  /** Per-shot override for the doc-level `suppressLowerThirds` flag. When
   *  `true`, the LowerThird component never mounts for this shot — used by
   *  Phase 5's `'bake'` / `'none'` rows whose underlying images already
   *  carry (or deliberately omit) the text. Undefined falls back to
   *  `VideoConfig.suppressLowerThirds`. */
  suppressLowerThird?: boolean;
  /** The voiceover script text for this shot (used for captions) */
  scriptText?: string;
  /** Animation variant override — used to pick between multiple entrance styles */
  animationVariant?: 'slide-up' | 'slide-left' | 'slide-right' | 'zoom-in' | 'fade';
  /** Ken Burns direction override */
  kenBurnsDirection?: 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down';
  /** Background color override for this shot */
  backgroundColor?: string;
  /** Whether to show floating/bobbing animation on the main image */
  floatImage?: boolean;
  /** When set, this shot is a thumbnail-zoom scene that lands on the
   *  region with this id (looked up against VideoConfig.thumbnail.regions). */
  thumbnailZoomTo?: string;
  /** Per-shot transition override. Falls back to VideoConfig.thumbnail.defaultTransition. */
  thumbnailTransition?: ThumbnailTransitionConfig;
  /** Resolved camera padding (percent of the region's longest edge added
   *  on each side) for the thumbnail-zoom framing. The renderer inflates
   *  the region by this fraction before computing the cover scale, so a
   *  higher value pulls the camera back. Resolved upstream from the row
   *  override → doc default → built-in default (15) inside
   *  `productionDocToVideoConfig`. Range `[0, 50]`. Undefined ⇒ 0 (no
   *  padding, exact-region framing — backwards-compat with pre-padding
   *  renders). See
   *  `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`. */
  regionZoomPaddingPct?: number;
  /** Per-shot override of the scene-to-scene cross fade. `true` forces a
   *  fade even when the doc default is off; `false` forces a hard cut
   *  even when the doc default is on. `undefined` falls through to
   *  VideoConfig.sceneFadeEnabled (which itself defaults to `true`). See
   *  `_plans/2026-05-17-scene-transition-controls.md`. */
  sceneFade?: boolean;
  /** Section title shown as a fixed stripe at the top of frame for the
   *  shot's full duration. Independent of `sceneType` — usable on any scene. */
  sectionTitle?: string;
  /** When `sectionTitle` is set, controls how the stripe relates to the scene:
   *  - 'overlay': stripe sits on top of full-frame scene (legacy behavior).
   *  - 'letterbox': scene shrinks to fit below the stripe; pillarbox color fills
   *    any empty area when the image doesn't fill the box. Default when unset
   *    is 'letterbox' — see _plans/2026-05-17-section-title-letterbox-and-overlay-blending.md. */
  sectionTitleLayout?: 'overlay' | 'letterbox';
  /** Fill color (hex `#RRGGBB`) for the area below the stripe that the image
   *  doesn't cover. Only meaningful when `sectionTitleLayout === 'letterbox'`.
   *  Falls back to `VideoConfig.pillarboxColorDefault`, then to white. */
  pillarboxColor?: string;
  /** Static zoom on the rendered image / video, as a percentage where
   *  100 = unchanged. Multiplies on top of any animated transform so
   *  Ken Burns / B-roll motion is preserved. The renderer wraps the
   *  visual in a scaled container; surrounding area shows the scene
   *  background (or pillarbox color in letterbox mode). Undefined ⇒ 100. */
  sceneZoom?: number;
  /** Free-transform on the visual — Canva-style position + scale +
   *  rotation. Composes WITH `sceneZoom` (sceneZoom acts as a coarse
   *  shortcut; image_scale_pct as fine control). x/y are percent of
   *  canvas width/height from center (0 = centered, ±100 = off-frame
   *  edge). Scale is percent of natural fit (100 = today's render).
   *  Rotation is degrees clockwise. See
   *  `_plans/2026-05-23-editor-canva-transform.md`. */
  imageXPct?: number;
  imageYPct?: number;
  imageScalePct?: number;
  imageRotationDeg?: number;
  /** Render policy for clip/scene duration mismatch. See
   *  `ProductionRow.clip_fit_mode` for the full description. The
   *  renderer reads this via BRollScene. Undefined → 'stretch'
   *  (back-compat with pre-2026-05-23 behavior). `trim-scene` is
   *  ALSO treated as 'stretch' here because by the time the renderer
   *  sees the shot, the inspector's button has already shortened
   *  duration_override_ms so the two durations match. */
  clipFitMode?: 'stretch' | 'freeze-last' | 'loop' | 'trim-scene';
  /** Auto-sourced real-image overlay composited on top of the scene at
   *  the planned zone. Falsy = no overlay, scene renders unmodified.
   *
   *  The overlay PNG is fetched by `/api/overlay/fetch` (Brave Search +
   *  background removal) when the production-doc row carries an
   *  `overlay_stock_terms` value. The zone + size are planned by the
   *  doc generator at the same time as the row's `ai_image_prompt`, so
   *  the still's negative-space layout matches where the overlay lands.
   *
   *  `haloColor` is the dominant RGB of the saliency cell the overlay
   *  lands in (sampled at image-generation time) — used as the colour
   *  of a soft glow behind the overlay so it reads as part of the
   *  local image environment, not a sticker on top. */
  overlay?: {
    url: string;
    zone:
      | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
      | 'center-top' | 'center-bottom' | 'left-center' | 'right-center';
    size: 'small' | 'medium' | 'large';
    haloColor?: string;
    /** Manual top-left position from drag-and-drop, as % of frame
     *  width/height (0-100). When BOTH x and y are numbers, the
     *  renderer ignores `zone` and pins the overlay to this position.
     *  Either alone is treated as "unset" for safety. */
    customX?: number;
    customY?: number;
    /** Manual width override (% of frame width). When a number, the
     *  renderer ignores `size` and uses this directly. */
    customSizePct?: number;
    /** Manual height override (% of frame height) — set only when the
     *  user freely stretched the overlay to a non-natural aspect via
     *  Shift+drag on a resize handle. When a finite number, the renderer
     *  uses this height verbatim instead of deriving height from the
     *  image's natural aspect. Absent ⇒ height follows natural aspect.
     *  See Phase 1 of `_plans/2026-05-18-overlay-system-overhaul.md`. */
    stretchedHeightPct?: number;
    /** One-sentence rationale for the AI-chosen placement — surfaced as
     *  a tooltip in the position editor so the user can see *why* the
     *  overlay landed here. Written by `/api/overlay/fetch` when smart
     *  placement was applied at fetch time. Absent for pre-Phase-2 rows
     *  and for rows that opted out. Phase 2 of the overlay-system
     *  overhaul. */
    placementReason?: string;
    /** Phase 4 — whether the RMBG cutout was used (`true`) or reverted
     *  to the original Brave-source image (`false`). The renderer
     *  doesn't act on this — it's metadata for the UI so the editor
     *  can surface "background removed" vs "original kept". Absent =
     *  the gate didn't run (cache hit, pre-Phase-4 row, or gate
     *  errored). */
    rmbgKept?: boolean;
  };
  // ─── Shot-graph editor fields ──────────────────────────────────────
  //
  // Phase 1 additions for `_plans/2026-05-18-shot-graph-editor.md`.
  // Every field below is optional; absent on a shot means "behave as
  // before." The renderer reads each when present, falls back to the
  // pre-editor behaviour otherwise. Persistence is on the doc-row
  // shape (JSONB in `user_history.payload`) — no SQL migration. See
  // the plan's "Phase 1 corrections" section.

  /** Head-trim on the underlying clip. Number of milliseconds skipped
   *  from the source clip's start. Used by BRollScene to advance the
   *  source's playhead without changing the shot's `durationMs`.
   *  Snap-to-frame at the data layer; renderer floors to nearest
   *  `1000/fps` ms. */
  trimStartMs?: number;
  /** Tail-trim on the underlying clip. Number of milliseconds dropped
   *  from the source clip's end. Same snap-to-frame rules. */
  trimEndMs?: number;
  /** Per-shot mute toggle. When true, the shot's audio track is
   *  silenced at render time — voiceover + music still play (those
   *  are master tracks on `VideoConfig`). v1 only mutes the source
   *  clip's own audio when present. */
  muted?: boolean;
  /** Playback rate for the source clip. 1 = normal, 0.5 = half-speed,
   *  2 = double. Renderer multiplies the source's playhead advance
   *  by this value. Out of scope: speed ramps (Remotion `interpolate`
   *  on `playbackRate` over time) — that's v2. */
  playbackRate?: number;
  /** Cross-fade transition INTO this shot. `null` / undefined =
   *  hard-cut (today's behaviour). Phase 4 wires this to
   *  `<TransitionSeries>` with `@remotion/transitions`. v1 only
   *  supports the literal `'cross-fade'`. */
  transitionInId?: 'cross-fade' | null;
  // Note: `edited_at` lives ONLY on the doc row (ProductionRow.edited_at)
  // in the structured `{ any, fields }` shape — see `RowEditedAt`. It's
  // never threaded into VideoShot because the renderer doesn't care
  // about edit history, and carrying it here would force a string-vs-
  // structured-object conversion at the boundary for no gain.

  // ─── paint_explainer_v1 (2026-05-28) ─────────────────────────────
  //
  // Renderer-side mirror of ProductionRow's motion fields. Plumbed
  // through `productionDocToVideoConfig` so SceneRouter can route to
  // `<MotionScene>` when `shotKind === 'motion'`, and that scene can
  // mount the right Remotion overlays per `motionBeats[]`. All four
  // fields are optional; absent ⇒ render exactly as before (rule 2 —
  // additive only, no regression on doodle_explainer_2). See
  // `_plans/2026-05-28-paint-explainer-v1-architecture.md`.

  /** Renderer routing hint. `'motion'` mounts `<MotionScene>` over the
   *  base image; `'hard_cut'` signals snap-cut entry (no fade);
   *  `'motion_collage'` mounts `<MotionCollageScene>` and plays
   *  `motionCollagePanelUrls` as hard-cut keyframes over the shot's
   *  duration (doodle_explainer_2 motion collage); `'static'` (or
   *  undefined) uses the current Ken-Burns-or-still path. */
  shotKind?: 'static' | 'motion' | 'hard_cut' | 'motion_collage';

  /** Procedural motion overlays for this shot. Same shape as
   *  `ProductionRow.motion_beats`. Unrecognised kinds are skipped
   *  silently by MotionScene so future motion-beat kinds can ship
   *  through the LLM before the renderer supports them. */
  motionBeats?: Array<{
    kind: string;
    startMs: number;
    durationMs: number;
    anchor?:
      | { kind: 'auto-mouth' }
      | { kind: 'auto-center' }
      | { kind: 'auto-eyes' }
      | { kind: 'specific'; xPct: number; yPct: number };
    payload?: {
      text?: string;
      assetUrl?: string;
      propPromptHint?: string;
    };
  }>;

  /** R2 URL of the mouth-removed companion of `imageUrl`, used as the
   *  bottom layer by `<MouthSwap>`. Populated by the image-gen pipeline
   *  for paint_explainer_v1 character shots whose row carries a
   *  `character_id` and a `mouth_swap` motion beat. Absent when the
   *  pipeline hasn't generated it yet (a later tick picks it up) OR
   *  when the shot doesn't need one. */
  mouthRemovedUrl?: string;

  /** Stable character identifier (mirrors `ProductionRow.character_id`).
   *  Renderer doesn't act on this field — carried through to telemetry
   *  so per-character render counts grep cleanly. */
  characterId?: string;

  /** Forced-alignment word slice covering this shot's time window
   *  (absolute ms from start of audio). Populated by
   *  `productionDocToVideoConfig` for paint_explainer_v1 motion shots
   *  when the project has alignment JSON available. Consumed by
   *  `<MouthSwap>` via `visemeSequenceFromAlignment` to produce frame-
   *  precise mouth-state transitions tied to actual phoneme onsets,
   *  instead of the constant-rate fallback. Absent on shots without
   *  alignment (constant-rate falls through automatically). */
  visemeWords?: Array<{ text: string; startMs: number; endMs: number }>;

  /** Resolved mouth anchor (% of canvas) for this shot's character,
   *  looked up by `productionDocToVideoConfig` from
   *  `ProductionDoc.paint_explainer_v1_character_cache[character_id]
   *  .anchors['auto-mouth']`. Passed to `<MouthSwap>` so the procedural
   *  mouth PNG composites at the right pixel on character poses that
   *  aren't the centered close-up MouthSwap's hardcoded default
   *  calibrated against. Absent when the vision-pass hasn't run or
   *  returned no useful result — MouthSwap falls back to the default. */
  mouthAnchor?: { xPct: number; yPct: number };

  // ─── doodle_explainer_2 motion_collage (2026-05-31) ────────────────
  //
  // Renderer-side mirror of ProductionRow.motion_collage_panel_urls.
  // Plumbed through `productionDocToVideoConfig` so SceneRouter can
  // route to `<MotionCollageScene>` when `shotKind === 'motion_collage'`,
  // and that scene can divide the shot's duration evenly across the
  // panels. Absent when shotKind is not 'motion_collage'. See
  // `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.

  /** Sliced per-panel R2 URLs for motion_collage shots. Index 0 is the
   *  first keyframe (top-left of the source grid); subsequent indices
   *  walk row-major across the grid. The renderer divides
   *  `durationInFrames` by N panels with the remainder absorbed by the
   *  last panel — every frame is hard-cut, no fades between panels.
   *  When absent / empty, the renderer falls back to a held single
   *  image (panel 0 mirrored into `imageUrl` by the pipeline). */
  motionCollagePanelUrls?: string[];
  /** Per-panel transform overrides — index-aligned with
   *  `motionCollagePanelUrls`. When set, MotionCollageScene applies
   *  CSS `translate(x_pct%, y_pct%) scale(scale_pct/100)` to that
   *  panel's image so the user can reposition badly-framed panels
   *  without regen. Mirror of `motion_collage_panel_transforms` on
   *  the source row. User-asked-for 2026-06-02. */
  motionCollagePanelTransforms?: Array<{
    x_pct?: number;
    y_pct?: number;
    scale_pct?: number;
  } | null>;
  /** Grid layout for the panel URLs. Mirror of `ProductionRow.motion_collage_grid`,
   *  threaded so editor thumbnails can render the exact cols × rows the
   *  panels were sliced from instead of falling back to a square-ish guess.
   *  Absent when shotKind is not 'motion_collage'. See PR 1 of
   *  `_plans/2026-06-02-editor-motion-collage-support.md`. */
  motionCollageGrid?: { cols: number; rows: number };
}

// ─── paint_explainer_v1 settings ────────────────────────────────────
//
// Lives in this file (the renderer's type module) so VideoConfig can
// reference it without a circular import. The constants
// (PAINT_EXPLAINER_V1_DEFAULTS, _BOUNDS) and the resolver function
// stay in `./utils` where the runtime behaviour lives.

export interface PaintExplainerV1Settings {
  /** Target median shot length in seconds. Drives the LLM's pacing
   *  during doc generation — shorter values produce more, shorter
   *  rows. 2.5–3.0s matches the Paint Explainer reference videos. */
  median_shot_seconds?: number;
  /** Mouth-swap loop rate (Hz) when alignment JSON isn't available
   *  for a row. Bounded 6–12; viability test verdict was 8. Renderer-
   *  consumed via `constantRateVisemeSequence({ rateHz })`. */
  mouth_swap_fps_fallback?: number;
  /** When true (default), `<MouthSwap>` reads frame-by-frame state
   *  from alignment JSON visemes. When false, uses constant-rate
   *  fallback at `mouth_swap_fps_fallback`. */
  use_alignment_driven_visemes?: boolean;
  /** Target percentage of factual rows that should carry a real-photo
   *  overlay. The LLM's mixing_rules trigger on every named entity
   *  but this knob lets a channel dial overall density up or down. */
  real_photo_cadence_pct?: number;
  /** When true (default), the image-gen pipeline reuses the same
   *  base + mouth-removed pair across rows sharing a `character_id`. */
  character_persistence_enabled?: boolean;
  /** Yellow label color (Font B in the style guide). */
  label_color_hex?: string;
  /** Default duration (ms) of a `<ScribbleDraw>` reveal beat. */
  draw_on_default_duration_ms?: number;
  /** Transition between shots. `'snap'` matches the genre default. */
  hard_cut_transition?: 'snap' | 'micro-fade';
}

// ─── doodle_explainer_2 motion-collage settings (2026-05-31) ────────
//
// Per-doc controls for the motion_collage shot kind. Lives in this
// file (the renderer's type module) so VideoConfig can reference it
// without a circular import. The constants
// (DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS, _BOUNDS) and the
// resolver function live in `./utils` alongside the
// paint_explainer_v1 equivalents. See
// `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.

export interface DoodleExplainer2MotionCollageSettings {
  /** Global kill for motion_collage shots in this doc. When false, the
   *  LLM is told to skip the new shot kind via mixing_rules AND the
   *  pipeline refuses to generate any motion_collage row (defense in
   *  depth — covers a stale doc where the LLM emitted before this
   *  toggle was flipped). Default true. */
  allow_motion_collage?: boolean;
  /** Maximum panels per collage (cols × rows). Bounds spend per shot
   *  and renderer load. Bounded [4, 16] — the hard ceiling is enforced
   *  in `src/lib/collage-slicer.ts` via `MAX_COLLAGE_CELLS`. Default 12. */
  max_grid_panels?: number;
  /** Minimum per-frame duration (ms). Frames briefer than this read as
   *  flicker; the pipeline rejects rows whose
   *  `shot.durationMs / N < min_per_frame_ms`. Default 200 (5 fps
   *  perceived floor). */
  min_per_frame_ms?: number;
  /** Maximum per-frame duration (ms). Frames longer than this stop
   *  feeling like motion and start feeling like a slideshow — the LLM
   *  is told to pick a grid such that `shot.durationMs / N` lands
   *  below this. Default 800. */
  max_per_frame_ms?: number;
}

// ─── zenn_v1 settings (2026-06-10) ──────────────────────────────────
//
// Per-doc controls for the `zenn_v1` style (modelled on the YouTube
// channel Zenn @Zenn0009). Lives in this file (the renderer's type
// module) so VideoConfig can reference it without a circular import.
// The constants (ZENN_V1_DEFAULTS, _BOUNDS) and the resolver function
// live in `./utils` alongside the paint_explainer_v1 equivalents.
// See `_plans/2026-06-10-zenn-v1-style.md` §8.

export interface ZennV1Settings {
  /** Per-shot default when the LLM does not pick a mode. Zenn videos
   *  mix both modes; `'scene'` is the differentiator (flat-fill
   *  character on a colored world) so that is the default. */
  default_mode?: 'stick' | 'scene';
  /** Hand-lettered emphasis text color. Zenn's bold red is `#D32F2F`. */
  label_color_hex?: string;
  /** When true (default), `<highlighter_stripe>` beats render. When
   *  false, label-pop beats render with no underlying stripe. */
  highlighter_enabled?: boolean;
  /** Translucent highlighter stripe color. Stored as solid hex; the
   *  renderer applies the canonical `0.65` opacity at composite time
   *  so a stale doc value cannot accidentally produce an opaque
   *  block over the word. */
  highlighter_color_hex?: string;
  /** Default ground baseline color for Mode A stick-figure shots.
   *  Zenn uses a warm medium grey; brand variants may want a cool
   *  grey or a tinted color. */
  ground_color_hex?: string;
  /** Target median shot length in seconds. Zenn Mode B cuts at ~2.8s
   *  (measured); Mode A holds longer (~4.3s median, p90 = 11.2s).
   *  This drives the LLM's pacing during doc generation — shorter
   *  values produce more, shorter rows. Bounded `[2.0, 6.0]`. */
  median_shot_seconds?: number;
  /** Maximum sibling-frame layers a single `canvas_reveal` beat may
   *  emit. Lower values reduce per-video Kie Edit cost (the largest
   *  line item in section 11 of the plan). The `mixing_rules` block
   *  surfaces this cap to the LLM so a stale value can't blow the
   *  budget. Bounded `[1, 8]`. */
  max_canvas_reveal_layers?: number;
  /** When true (default), the per-doc character bank reuses the same
   *  base + pose set across every row sharing a `zenn_character_id`.
   *  Disabling this is a debugging aid — it forces every character
   *  shot to a fresh generation. Burns budget; not a normal toggle. */
  character_persistence_enabled?: boolean;
  /** Hard cap on unique characters in the per-doc bank. Defensive
   *  against a runaway LLM emitting twenty character ids when the
   *  script only has three. When the LLM emits more, the pipeline
   *  merges near-duplicates by name similarity rather than rejecting
   *  rows (see plan §6). Bounded `[3, 20]`. */
  max_unique_characters?: number;
}

// ─── Video Config ──────────────────────────────────────────────────────────────

/** Per-segment voiceover slice — mirrors VoiceoverSegment in
 *  remotion/utils but stays in the renderer types so the renderer
 *  doesn't pull from doc-shape types. */
export interface VoiceoverConfigSegment {
  id: string;
  sourceUrl: string;
  sourceOffsetMs: number;
  durationMs: number;
}

export interface VideoConfig {
  /** Frames per second — 30 for YouTube, 60 for gaming content */
  fps: number;
  /** paint_explainer_v1 effective settings — the resolver-resolved
   *  shape with every default applied. Populated by
   *  `productionDocToVideoConfig` from `doc.paint_explainer_v1_settings`
   *  so the renderer doesn't have to re-resolve defaults at frame time.
   *  Undefined on non-paint_explainer_v1 docs. */
  paintExplainerV1Settings?: Required<PaintExplainerV1Settings>;
  /** paint_explainer_v1 prop cache — `propPromptHint` → public PNG
   *  URL. Populated by `productionDocToVideoConfig` from
   *  `doc.paint_explainer_v1_prop_cache`. `<MotionScene>` reads via
   *  beat.payload.propPromptHint to resolve a prop_slide beat's
   *  assetUrl when the LLM didn't supply one directly. */
  paintExplainerV1PropCache?: Record<string, string>;
  /** zenn_v1 effective settings — the resolver-resolved shape with
   *  every default applied. Populated by `productionDocToVideoConfig`
   *  from `doc.zenn_v1_settings` so the renderer doesn't have to
   *  re-resolve defaults at frame time. Undefined on non-zenn_v1
   *  docs. See `_plans/2026-06-10-zenn-v1-style.md` §8. */
  zennV1Settings?: Required<ZennV1Settings>;
  /** Composition width in pixels */
  width: number;
  /** Composition height in pixels */
  height: number;
  /** All shots in order */
  shots: VideoShot[];
  /** Voiceover audio URL (Vercel Blob public URL) */
  voiceoverUrl?: string;
  /** Per-segment voiceover playback — when present and non-empty,
   *  the renderer wraps each segment in its own <Sequence><Audio
   *  startFrom={…}/></Sequence> instead of playing
   *  `voiceoverUrl` straight through. Produced by the CapCut-style
   *  timeline editor (cut / trim / split on the voiceover track).
   *  See `_plans/2026-06-05-capcut-timeline-editor.md` (M6). */
  voiceoverSegments?: VoiceoverConfigSegment[];
  /** Mute voiceover at render time (composition outputs zero gain).
   *  Forwarded from `ProductionDoc.voiceover_muted`. Default false. */
  voiceoverMuted?: boolean;
  /** Voiceover gain in decibels. Clamped to [-60, +12]. Default 0
   *  (unity). Forwarded from `ProductionDoc.voiceover_volume_db`. */
  voiceoverVolumeDb?: number;
  /** Voiceover fade-in duration in ms. Default 0. */
  voiceoverFadeInMs?: number;
  /** Voiceover fade-out duration in ms. Default 0. */
  voiceoverFadeOutMs?: number;
  /** Background music URL */
  musicUrl?: string;
  /** Music volume (0–1), defaults to 0.15 */
  musicVolume?: number;
  /** Brand kit for colors/fonts */
  brand: BrandKit;
  /** Whether to show burned-in captions */
  showCaptions?: boolean;
  /** Suppress the LowerThird `onScreenText` overlay across all scenes
   *  that render one (BRollScene, ScreenMockupScene). When true the
   *  scenes simply skip rendering the dark band — useful when the
   *  on-screen text is already baked into the AI image at generation
   *  time, so showing it again as a Remotion overlay is redundant.
   *  Default false (overlay shown) for backwards compatibility. */
  suppressLowerThirds?: boolean;
  /** Optional composite thumbnail referenced by `VideoShot.thumbnailZoomTo`. */
  thumbnail?: VideoThumbnail;
  /** Doc-level fallback fill color for letterbox pillarbox areas when a
   *  shot doesn't set its own `pillarboxColor`. Hex `#RRGGBB`. When unset,
   *  individual shots fall through to white. See section-title-letterbox plan. */
  pillarboxColorDefault?: string;
  /** Minimum scene duration (ms) carried through from the doc so the
   *  server-side `realignVideoConfig` call has the resolved value. See
   *  `_plans/2026-05-17-scene-min-duration-and-tail-buffer.md`. */
  minSceneMs?: number;
  /** Tail buffer (ms) after narration, carried through for the server-
   *  side realign call. Capped at the gap to the next row at apply time. */
  tailBufferMs?: number;
  /** Doc-level default for the scene-to-scene cross fade (the
   *  `<SceneTransition>` overlay each scene renders at its start/end).
   *  `true` (or unset) keeps the historical fade; `false` makes every
   *  shot hard-cut, including removing the opening fade-in on the first
   *  shot and the closing fade-out on the last. Per-shot `sceneFade`
   *  overrides this. See `_plans/2026-05-17-scene-transition-controls.md`. */
  sceneFadeEnabled?: boolean;
  /** Burned-in captions — Phase 4 of
   *  `_plans/2026-05-18-shot-graph-editor.md`. When present and
   *  non-empty, the composition renders each segment's text over the
   *  bottom-third of the frame while its time window is active.
   *  Editor uses this for Lambda renders so the rendered MP4 carries
   *  the captions the user already saw in the editor's HTML overlay. */
  captions?: Array<{ start: number; end: number; text: string }>;
  /** Doc-level text overlays — Phase 4 "master overlay layer." Each
   *  overlay spans a configurable time window and lays its text at
   *  one of two preset positions. Independent from per-shot
   *  `onScreenText` (which the LowerThird handles per-row); these
   *  overlays sit on top of any number of consecutive shots without
   *  being tied to a single row. */
  textOverlays?: TextOverlay[];
  /** Production-doc style id pinned at the doc level (e.g.
   *  `doodle_explainer_2`). Forwarded from `ProductionDoc.style_id`
   *  so Remotion components can style-vary their rendering — Phase 2
   *  of `_plans/2026-05-25-style-aware-overlay-text.md` uses this on
   *  `<LowerThird>` + `<TextOverlayLayer>` to switch on-screen text
   *  to the yellow bubble-font treatment for the doodle_explainer_2
   *  built-in. Other components are free to read it via
   *  `useVideoConfig()` when adding their own style-aware behavior.
   *  Optional and unspecified ⇒ every component uses its default
   *  rendering — no regression for any existing doc. */
  styleId?: string;
}

/** A single doc-level text overlay. Identified by `id` so commands
 *  can update/delete one without ambiguity. */
export interface TextOverlay {
  id: string;
  text: string;
  /** Start time in ms from the start of the video. */
  startMs: number;
  /** End time in ms from the start of the video (exclusive). */
  endMs: number;
  /** Two presets in v1 — lower-third matches the existing LowerThird
   *  zone, top-center sits below the section-title stripe area. */
  position: 'lower-third' | 'top-center';
  /** Font size as a fraction of frame height. 0.04 ≈ 43 px on a
   *  1080p render — slightly bigger than the caption default. */
  fontSizeFraction?: number;
  /** Text color, hex `#RRGGBB`. Defaults to white when undefined. */
  color?: string;
  /** Background opacity 0..1. 0 = fully transparent text only;
   *  0.85 = solid card. Defaults to 0.85. */
  backgroundOpacity?: number;
  /** Fade-in duration in ms. Defaults to 250 ms. */
  fadeInMs?: number;
}

// ─── Render Job ───────────────────────────────────────────────────────────────

export type RenderStatus = 'pending' | 'rendering' | 'done' | 'error';

export interface RenderJob {
  id: string;
  status: RenderStatus;
  progress: number;    // 0–1
  outputUrl?: string;  // Vercel Blob URL when done
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

// ─── Production Doc → Shot Conversion ─────────────────────────────────────────

/** Maps visual_type strings from production doc to SceneType */
export function inferSceneType(visualType: string): SceneType {
  const v = visualType.toLowerCase();
  if (v.includes('title') || v.includes('intro') || v.includes('header')) return 'title-card';
  if (v.includes('outro') || v.includes('end') || v.includes('cta')) return 'outro';
  if (v.includes('screen') || v.includes('ui') || v.includes('app') || v.includes('demo')) return 'screen-mockup';
  if (v.includes('icon') || v.includes('diagram') || v.includes('illustration') || v.includes('infograph')) return 'icon-scene';
  if (v.includes('text') || v.includes('quote') || v.includes('stat') || v.includes('fact')) return 'text-reveal';
  if (v.includes('split') || v.includes('comparison') || v.includes('vs')) return 'split-scene';
  // Default: b-roll (most common)
  return 'b-roll';
}
