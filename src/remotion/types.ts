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

export type ThumbnailTransitionKind = 'hard-cut' | 'smooth';

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
  /** Section title shown as a fixed stripe at the top of frame for the
   *  shot's full duration. Independent of `sceneType` — usable on any scene. */
  sectionTitle?: string;
  /** Auto-sourced real-image overlay composited on top of the scene at
   *  the planned zone. Falsy = no overlay, scene renders unmodified.
   *
   *  The overlay PNG is fetched by `/api/overlay/fetch` (Brave Search +
   *  background removal) when the production-doc row carries an
   *  `overlay_stock_terms` value. The zone + size are planned by the
   *  doc generator at the same time as the row's `ai_image_prompt`, so
   *  the still's negative-space layout matches where the overlay lands. */
  overlay?: {
    url: string;
    zone:
      | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
      | 'center-top' | 'center-bottom' | 'left-center' | 'right-center';
    size: 'small' | 'medium' | 'large';
  };
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
  /** Optional composite thumbnail referenced by `VideoShot.thumbnailZoomTo`. */
  thumbnail?: VideoThumbnail;
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
