import { VideoShot, VideoConfig, inferSceneType, DEFAULT_BRAND_KIT, BrandKit, VideoThumbnail, ThumbnailTransitionConfig } from './types';
import { stripProductionMarkers } from '@/lib/script-markers';
import {
  alignRowsToWords,
  snapMsToFrame,
  type AlignedRow,
} from '@/lib/voiceover-alignment';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';

// ─── Timecode Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a timecode string like "0:15", "1:23", "0:00–0:15" into milliseconds.
 * Returns start of the range if it's a range.
 */
export function parseTimecodeToMs(timecode: string): number {
  if (!timecode || typeof timecode !== 'string') return 0;
  // Strip range (take the start), handle em-dash, en-dash, hyphen
  const start = timecode.split(/[–\-—]/)[0].trim();
  if (!start) return 0;
  const parts = start.split(':');
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10);
    const seconds = parseFloat(parts[1]);
    if (isNaN(minutes) || isNaN(seconds)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[remotion] Invalid timecode format: "${timecode}" — defaulting to 0ms`);
      }
      return 0;
    }
    return (Math.abs(minutes) * 60 + Math.abs(seconds)) * 1000;
  }
  if (parts.length === 3) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseFloat(parts[2]);
    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[remotion] Invalid timecode format: "${timecode}" — defaulting to 0ms`);
      }
      return 0;
    }
    return (Math.abs(hours) * 3600 + Math.abs(minutes) * 60 + Math.abs(seconds)) * 1000;
  }
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[remotion] Unrecognized timecode format: "${timecode}" — defaulting to 0ms`);
  }
  return 0;
}

/** Convert milliseconds to Remotion frame number */
export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

/** Convert frame number to milliseconds */
export function frameToMs(frame: number, fps: number): number {
  return (frame / fps) * 1000;
}

/** Parse total duration string like "3:45" to milliseconds */
export function parseDurationToMs(duration: string): number {
  return parseTimecodeToMs(duration);
}

// ─── Shot Duration Calculation ─────────────────────────────────────────────────

/**
 * Calculate duration of each shot from sequential timecodes.
 * The last shot extends to the total video duration.
 */
export function calcShotDurations(
  timecodes: string[],
  totalDurationMs: number,
  minShotMs = 1500,
): number[] {
  const starts = timecodes.map(parseTimecodeToMs);
  return starts.map((start, i) => {
    const next = starts[i + 1] ?? totalDurationMs;
    return Math.max(next - start, minShotMs);
  });
}

// ─── Words Per Minute → ms per shot ───────────────────────────────────────────

/**
 * Estimate shot duration from word count and speaking pace.
 */
export function wpmToDurationMs(wordCount: number, wpm: number): number {
  return Math.round((wordCount / wpm) * 60 * 1000);
}

// ─── Production Doc → VideoConfig Conversion ──────────────────────────────────

export interface ProductionRow {
  timecode: string;
  script_text: string;
  visual_type: string;
  visual_description: string;
  stock_search_terms: string;
  ai_image_prompt: string;
  on_screen_text: string;
  notes: string;
  /** Planning fields for auto-sourced real-image overlays. See the
   *  `/api/overlay/fetch` route and the OverlayCell component. */
  overlay_stock_terms?: string;
  overlay_zone?:
    | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    | 'center-top' | 'center-bottom' | 'left-center' | 'right-center';
  overlay_size?: 'small' | 'medium' | 'large';
  /** Region id this row's scene zooms into. See ProductionDoc.thumbnail.regions. */
  thumbnail_zoom_to?: string;
  /** Section title stripe text shown at top of frame for the row's duration. */
  section_title?: string;
  /** Per-row transition override; falls back to ProductionDoc.thumbnail.defaultTransition. */
  thumbnail_transition?: ThumbnailTransitionConfig;
}

export interface ProductionDoc {
  title: string;
  niche: string;
  total_duration: string;
  total_words: number;
  speaking_pace_wpm: number;
  rows: ProductionRow[];
  /** Optional section-divider thumbnail; forwarded into VideoConfig.thumbnail. */
  thumbnail?: VideoThumbnail;
}

export interface RowImageState {
  status: string;
  imageUrl?: string;
}

/** Per-row B-roll clip state passed into the renderer.
 *
 *  Only rows whose corresponding entry has `status === 'ready'` AND a
 *  non-empty `videoUrl` contribute an animation. Anything else falls
 *  back to the still + Ken Burns path. */
export interface RowVideoClipState {
  status: string;
  videoUrl?: string;
}

/** Per-row auto-fetched overlay state passed into the renderer. Only rows
 *  whose corresponding entry has `status === 'done'` AND a non-empty `url`
 *  contribute an overlay composite — anything else renders the scene
 *  without an overlay (graceful fallback). The zone + size come from the
 *  doc-generator's planning on the ProductionRow itself. */
export interface RowOverlayRenderState {
  status: string;
  url?: string;
}

/**
 * Convert a ProductionDoc + its generated image URLs into a VideoConfig
 * ready to pass to the Remotion composition.
 *
 * When `alignment` is supplied, per-shot `startMs` / `durationMs` are
 * re-derived from the aligner's word-level timestamps so every scene
 * transition lands exactly where the narration's row starts. See
 * `_plans/2026-05-13-voiceover-aligned-scene-timing.md`. Without
 * `alignment`, behaviour is identical to the pre-alignment code path —
 * estimated timecodes from the doc are used verbatim.
 *
 * When `rowVideoClips` is supplied and `animateScenes` is true (default),
 * ready clips populate `VideoShot.videoUrl` so `BRollScene` can render
 * an animated clip instead of Ken Burns on the still. Passing
 * `animateScenes: false` short-circuits all clips and forces the
 * still-with-Ken-Burns path — the production doc page surfaces this
 * as the "Animate scenes" master toggle.
 */
export interface ProductionDocToVideoConfigOptions {
  voiceoverUrl?: string;
  musicUrl?: string;
  brand?: Partial<BrandKit>;
  alignment?: ForcedAlignmentResponse;
  rowVideoClips?: (RowVideoClipState | null)[];
  /** Defaults to true. When false, `rowVideoClips` is ignored entirely
   *  and every shot renders as a still + Ken Burns. */
  animateScenes?: boolean;
  /** Per-row "use the still, ignore any generated clip" override. When
   *  `rowLockedAsStill[i] === true`, shot i's `videoUrl` is suppressed
   *  even when a ready clip exists. The clip stays in `broll_clips` so
   *  unlocking is reversible without re-generation. */
  rowLockedAsStill?: boolean[];
  /** Per-row auto-fetched overlay state. Sparse — only present for rows
   *  whose `overlay_stock_terms` produced a usable image. */
  rowOverlays?: Record<number, RowOverlayRenderState>;
  /** Suppress the lower-third on-screen-text overlay across all scenes
   *  that render one. Forwarded into VideoConfig.suppressLowerThirds —
   *  see that field for semantics. */
  suppressLowerThirds?: boolean;
}

export function productionDocToVideoConfig(
  doc: ProductionDoc,
  rowImages: (RowImageState | null)[],
  voiceoverUrlOrOptions?: string | ProductionDocToVideoConfigOptions,
  musicUrl?: string,
  brand?: Partial<BrandKit>,
  alignment?: ForcedAlignmentResponse,
): VideoConfig {
  // Back-compat: callers may still pass the original 6-arg form. Normalise
  // to the options shape so the body below has a single path.
  const opts: ProductionDocToVideoConfigOptions =
    typeof voiceoverUrlOrOptions === 'object' && voiceoverUrlOrOptions !== null
      ? voiceoverUrlOrOptions
      : {
          voiceoverUrl: voiceoverUrlOrOptions,
          musicUrl,
          brand,
          alignment,
        };
  const animateScenes = opts.animateScenes !== false;
  const fps = 30;
  const totalMs = parseDurationToMs(doc.total_duration) || 60_000;
  const timecodes = doc.rows.map(r => r.timecode);
  const durations = calcShotDurations(timecodes, totalMs);

  const shots: VideoShot[] = doc.rows.map((row, i) => {
    const startMs = parseTimecodeToMs(row.timecode);
    const durationMs = durations[i];
    const imageState = rowImages[i];
    const imageUrl = imageState?.status === 'done' ? imageState.imageUrl : undefined;

    const lockedAsStill = opts.rowLockedAsStill?.[i] === true;
    const clipState = animateScenes && !lockedAsStill ? opts.rowVideoClips?.[i] : undefined;
    const videoUrl =
      clipState && clipState.status === 'ready' && clipState.videoUrl
        ? clipState.videoUrl
        : undefined;

    // Real-image overlay — only attached when the doc generator planned
    // one AND the auto-fetch resolved to a usable URL. The renderer
    // composites at the planned zone/size with a fade-in + scale-in motion.
    const overlayState = opts.rowOverlays?.[i];
    const overlay =
      overlayState?.status === 'done' &&
      overlayState.url &&
      row.overlay_zone &&
      row.overlay_size
        ? { url: overlayState.url, zone: row.overlay_zone, size: row.overlay_size }
        : undefined;

    return {
      startMs,
      durationMs,
      sceneType: inferSceneType(row.visual_type),
      imageUrl,
      videoUrl,
      title: row.on_screen_text || undefined,
      onScreenText: row.on_screen_text || undefined,
      scriptText: row.script_text ? stripProductionMarkers(row.script_text) || undefined : undefined,
      floatImage: true,
      // Per-row thumbnail-zoom data; consumed by the ThumbnailZoomScene
      // component (Phase 5 — until then the scene router falls through
      // to the inferred sceneType so these are harmless on the renderer).
      thumbnailZoomTo: row.thumbnail_zoom_to || undefined,
      sectionTitle: row.section_title || undefined,
      thumbnailTransition: row.thumbnail_transition,
      overlay,
    };
  });

  const config: VideoConfig = {
    fps,
    width: 1920,
    height: 1080,
    shots,
    voiceoverUrl: opts.voiceoverUrl,
    musicUrl: opts.musicUrl,
    musicVolume: 0.12,
    brand: { ...DEFAULT_BRAND_KIT, ...opts.brand },
    showCaptions: true,
    suppressLowerThirds: opts.suppressLowerThirds === true,
    thumbnail: doc.thumbnail,
  };

  return opts.alignment ? realignVideoConfig(config, opts.alignment).config : config;
}

// ─── Voiceover-aligned re-timing ──────────────────────────────────────────────

export interface RealignResult {
  /** New VideoConfig with shot startMs / durationMs swapped for
   *  frame-snapped, voiceover-aligned values. Identity-equal to the
   *  input when no aligned rows were produced. */
  config: VideoConfig;
  /** Per-row alignment outcome — `source: 'aligned'` for rows whose
   *  timing came from the aligner, `'estimated'` for fallbacks. The
   *  render route logs this for cost / health telemetry; the
   *  production-doc UI uses the aggregate `aligned` count to colour
   *  the pill. */
  alignedRows: AlignedRow[];
}

/**
 * Re-time an already-built VideoConfig using a ForcedAlignmentResponse.
 *
 * The render route hits this when the client has pre-warmed the
 * voiceover alignment cache: it reuses `config.shots[].scriptText`
 * (already passed through `stripProductionMarkers` by
 * `productionDocToVideoConfig`) as the per-row script and the existing
 * `startMs` as the fallback. Frame snapping uses `config.fps` so the
 * resulting timings sit exactly on Remotion frame boundaries — no
 * sub-frame jitter at scene boundaries.
 *
 * Pure: returns a new VideoConfig + a new shots array; the input is
 * not mutated. Empty `config.shots` short-circuits to `config` unchanged.
 */
export function realignVideoConfig(
  config: VideoConfig,
  alignment: ForcedAlignmentResponse,
): RealignResult {
  if (!config.shots.length) return { config, alignedRows: [] };

  const rowScripts = config.shots.map((s) => s.scriptText ?? '');
  const fallbackStartMs = config.shots.map((s) => s.startMs);
  const lastShot = config.shots[config.shots.length - 1];
  const fallbackTotalMs = lastShot.startMs + lastShot.durationMs;

  const alignedRows = alignRowsToWords({
    rowScripts,
    fallbackStartMs,
    fallbackTotalMs,
    alignment,
  });

  // Build the new shots in one pass. Frame-snapping happens here, not
  // in `alignRowsToWords`, so the pure helper can be tested against
  // exact aligner values without an fps round-trip.
  const newShots: VideoShot[] = config.shots.map((shot, i) => {
    const aligned = alignedRows[i];
    if (!aligned) return shot;
    const startMs = snapMsToFrame(aligned.startMs, config.fps);
    const endMs = snapMsToFrame(aligned.endMs, config.fps);
    // Defensive: a single-frame minimum protects the render route's
    // `durationMs > 0` validator if the aligner produced a degenerate
    // [start, end] interval. One frame at 30 fps = 33.33 ms.
    const durationMs = Math.max(endMs - startMs, 1000 / config.fps);
    return { ...shot, startMs, durationMs };
  });

  return {
    config: { ...config, shots: newShots },
    alignedRows,
  };
}

/** Total frame count for a VideoConfig */
export function totalFrames(config: VideoConfig): number {
  if (!config.shots.length) return config.fps * 10;
  const last = config.shots[config.shots.length - 1];
  return msToFrame(last.startMs + last.durationMs, config.fps);
}

/** Clamp a value between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
