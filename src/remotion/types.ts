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
  /** On-screen overlay text (lower third style) */
  onScreenText?: string;
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
  /** UTC ISO timestamp of the last manual edit to this shot's
   *  fields. Used by Phase 3's conflict resolution rule: if the
   *  shot was edited more recently than a pending regen, the
   *  manual edit wins. Server-enforced. */
  editedAt?: string;
}

// ─── Video Config ──────────────────────────────────────────────────────────────

export interface VideoConfig {
  /** Frames per second — 30 for YouTube, 60 for gaming content */
  fps: number;
  /** Composition width in pixels */
  width: number;
  /** Composition height in pixels */
  height: number;
  /** All shots in order */
  shots: VideoShot[];
  /** Voiceover audio URL (Vercel Blob public URL) */
  voiceoverUrl?: string;
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
