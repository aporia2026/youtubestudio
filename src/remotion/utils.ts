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

// ─── Scene-timing defaults ────────────────────────────────────────────────────
//
// Per `_plans/2026-05-17-scene-min-duration-and-tail-buffer.md`:
//
//   - `DEFAULT_MIN_SCENE_MS` is the floor on every shot's on-screen
//     duration. Stops too-short title cards and aligner-failure rows
//     (e.g. two-word phrases the forced aligner skipped) from flashing
//     on screen for less than the readable minimum.
//
//   - `DEFAULT_TAIL_BUFFER_MS` is the per-row breathing room after the
//     narrator's last word, capped at the gap to the next row so it
//     never desyncs the visual cut from the next narration onset.
//
// Both are overridable per-project on `ProductionDoc.min_scene_ms` /
// `tail_buffer_ms` and per-workspace via the settings UI (which
// populates `ProductionDocToVideoConfigOptions`).
export const DEFAULT_MIN_SCENE_MS = 2000;
export const DEFAULT_TAIL_BUFFER_MS = 400;

/** Bounds for both settings, enforced client- and server-side. */
export const MIN_SCENE_MS_BOUNDS = { min: 500, max: 10_000 } as const;
export const TAIL_BUFFER_MS_BOUNDS = { min: 0, max: 3_000 } as const;

/** Clamp `n` to `[bounds.min, bounds.max]`. Used by the timing knobs. */
export function clampSceneTiming(n: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(n)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
}

// ─── Shot Duration Calculation ─────────────────────────────────────────────────

/** Result row from `calcShotIntervals`. */
export interface ShotInterval {
  startMs: number;
  durationMs: number;
}

/**
 * Calculate per-shot intervals from sequential timecodes (no-alignment
 * path). Each shot extends to the next shot's start (or the total video
 * duration for the last shot), with `minSceneMs` as a floor so a too-tight
 * AI WPM estimate can't produce a sub-readable scene. A floor extension
 * on shot i cascades into shot i+1's start so shots never overlap.
 *
 * The forced-alignment path goes through `realignVideoConfig`, which
 * applies the same floor plus tail buffer + gap-fill. Both paths share
 * the same `minSceneMs` so behaviour is consistent regardless of which
 * one executed.
 */
export function calcShotIntervals(
  timecodes: string[],
  totalDurationMs: number,
  minSceneMs: number = DEFAULT_MIN_SCENE_MS,
): ShotInterval[] {
  const starts = timecodes.map(parseTimecodeToMs);
  const intervals: ShotInterval[] = [];
  let prevEndMs = 0;
  for (let i = 0; i < starts.length; i++) {
    const naturalStart = starts[i];
    const naturalNext = starts[i + 1] ?? totalDurationMs;
    // Cascade: a previous floor extension may have pushed this row's
    // effective start past its timecode. Use whichever is later.
    const startMs = Math.max(naturalStart, prevEndMs);
    // Floor against the next shot's natural start (or total duration).
    const endMs = Math.max(naturalNext, startMs + minSceneMs);
    intervals.push({ startMs, durationMs: endMs - startMs });
    prevEndMs = endMs;
  }
  return intervals;
}

/**
 * @deprecated Returns only the duration component of {@link calcShotIntervals}.
 * Prefer `calcShotIntervals` so the caller has access to cascaded startMs.
 * Kept for any external callers that imported it pre-2026-05-17.
 */
export function calcShotDurations(
  timecodes: string[],
  totalDurationMs: number,
  minSceneMs: number = DEFAULT_MIN_SCENE_MS,
): number[] {
  return calcShotIntervals(timecodes, totalDurationMs, minSceneMs).map((s) => s.durationMs);
}

// ─── Words Per Minute → ms per shot ───────────────────────────────────────────

/**
 * Estimate shot duration from word count and speaking pace.
 */
export function wpmToDurationMs(wordCount: number, wpm: number): number {
  return Math.round((wordCount / wpm) * 60 * 1000);
}

// ─── Production Doc → VideoConfig Conversion ──────────────────────────────────

export type OverlayZone =
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'center-top' | 'center-bottom' | 'left-center' | 'right-center';

export type OverlaySize = 'small' | 'medium' | 'large';

/** Pixel-saliency map of a row's image, computed once at image-generation
 *  time. Drives overlay placement (Layer 1 + 3 of the overlay-blending
 *  plan) so the overlay lands in empty space and picks up a halo color
 *  matched to the local image environment. */
export interface ImageSaliencyMap {
  cols: number;
  rows: number;
  /** Busyness score per cell, 0..1. Row-major flat array, length = cols*rows. */
  busyness: number[];
  /** Dominant RGB color per cell as `#RRGGBB`. Row-major, length = cols*rows. */
  dominantColors: string[];
}

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
  overlay_zone?: OverlayZone;
  overlay_size?: OverlaySize;
  /** Final overlay placement after saliency-aware resolution. When set,
   *  the renderer prefers these over `overlay_zone` / `overlay_size`.
   *  See `src/lib/overlay-placement.ts` for the resolver. */
  overlay_zone_resolved?: OverlayZone;
  overlay_size_resolved?: OverlaySize;
  /** Region id this row's scene zooms into. See ProductionDoc.thumbnail.regions. */
  thumbnail_zoom_to?: string;
  /** Section title stripe text shown at top of frame for the row's duration. */
  section_title?: string;
  /** Per-row stripe ↔ scene layout. Only meaningful when `section_title` is set.
   *  Undefined treated as 'letterbox' (plan 2026-05-17). */
  section_title_layout?: 'overlay' | 'letterbox';
  /** Per-row fill color for letterbox pillarbox area. Hex `#RRGGBB`. Falls back
   *  to ProductionDoc.pillarbox_color_default, then to white. */
  pillarbox_color?: string;
  /** Static zoom on the rendered image / video, as a percentage where
   *  100 = unchanged. Multiplies on top of any animated transform (Ken
   *  Burns, B-roll motion) so the animation is preserved exactly — only
   *  the static scale changes. Falls back to
   *  `ProductionDoc.scene_zoom_default`, then 100. */
  scene_zoom?: number;
  /** Manual overlay placement (top-left corner of overlay box, % of
   *  frame). Overrides `overlay_zone`/`overlay_zone_resolved` when set. */
  overlay_position?: { x_pct: number; y_pct: number };
  /** Manual overlay width as % of frame width. Overrides `overlay_size`
   *  / `overlay_size_resolved` when set. */
  overlay_size_pct?: number;
  /** Cached saliency map of `imageUrl` for this row — populated by the
   *  image-generation route. Sparse: missing for rows whose image hasn't
   *  been generated, or which pre-date the feature. */
  image_saliency?: ImageSaliencyMap;
  /** Per-row transition override; falls back to ProductionDoc.thumbnail.defaultTransition. */
  thumbnail_transition?: ThumbnailTransitionConfig;
  /** Per-row override of the scene-to-scene cross fade. `true` forces a
   *  fade even when the doc default is off; `false` forces a hard cut
   *  even when the doc default is on. `undefined` inherits the doc
   *  default (`ProductionDoc.scene_fade_enabled`). */
  scene_fade?: boolean;
  // ─── Shot-graph editor fields ────────────────────────────────────
  //
  // Additive, optional, set only by the editor (see
  // `_plans/2026-05-18-shot-graph-editor.md`). When unset, the
  // renderer falls back to the pre-editor derivation (timecode-based
  // duration, no head/tail trim, no per-shot mute).

  /** Editor's override of the per-row duration in ms. When set, this
   *  value takes precedence over the timecode-derived duration. The
   *  renderer recomputes the cumulative shot start times so changing
   *  this on row N shifts every subsequent row's startMs. */
  duration_override_ms?: number;
  /** Head-trim on the underlying source clip (ms). Skips this many
   *  ms from the clip's start before playing. The on-screen duration
   *  is still controlled by `duration_override_ms` / timecode. */
  trim_start_ms?: number;
  /** Tail-trim (ms dropped from the source clip's end). */
  trim_end_ms?: number;
  /** Per-row mute toggle. When true, the source clip's own audio is
   *  silenced at render time; the master VO + music tracks still play. */
  muted?: boolean;
  /** Playback rate for the source clip. 1 = normal, 0.5 = half-speed,
   *  2 = double. Static (no speed ramps in v1). */
  playback_rate?: number;
  /** Cross-fade transition INTO this row. `'cross-fade'` enables the
   *  Phase 4 transition; undefined keeps the row's existing fade
   *  resolution (`scene_fade` etc.). */
  transition_in?: 'cross-fade' | null;
  /** UTC ISO timestamp of the last editor edit to this row. Used by
   *  Phase 3's conflict-resolution rule (manual edit wins over AI
   *  regen). */
  edited_at?: string;
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
  /** Doc-level fallback fill for letterbox pillarbox areas. Hex `#RRGGBB`.
   *  Per-row `pillarbox_color` overrides this. Defaults to white when unset. */
  pillarbox_color_default?: string;
  /** Doc-level fallback for the stripe/scene layout. Per-row
   *  `section_title_layout` overrides this. Defaults to 'letterbox' when
   *  both this AND the row are unset. */
  section_title_layout_default?: 'overlay' | 'letterbox';
  /** Doc-level fallback for the static scene zoom percentage. Per-row
   *  `scene_zoom` overrides this. Undefined ⇒ 100 (no zoom). */
  scene_zoom_default?: number;
  /** Per-doc override of the workspace's minimum scene duration (ms).
   *  When omitted, the workspace default (or `DEFAULT_MIN_SCENE_MS`)
   *  applies. See `_plans/2026-05-17-scene-min-duration-and-tail-buffer.md`. */
  min_scene_ms?: number;
  /** Per-doc override of the workspace's tail buffer after narration
   *  (ms). When omitted, the workspace default (or
   *  `DEFAULT_TAIL_BUFFER_MS`) applies. */
  tail_buffer_ms?: number;
  /** Doc-level default for the scene-to-scene cross fade. `undefined`
   *  preserves the historical behaviour (faded). `false` makes every
   *  shot hard-cut, including the very first fade-in-from-black and
   *  the closing fade-out of the outro. Per-row `scene_fade` overrides.
   *  See `_plans/2026-05-17-scene-transition-controls.md`. */
  scene_fade_enabled?: boolean;
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
  /** Intrinsic clip duration in seconds. Sourced from `broll_clips.duration_seconds`.
   *  Used by `BRollScene` to fit playback rate to the scene's `durationMs` so a
   *  10s clip in a 7s scene doesn't freeze and a 10s clip in a 15s scene doesn't
   *  stop mid-narration. See `_plans/2026-05-17-clip-duration-fit.md`. */
  durationSeconds?: number;
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
  /** Workspace-default minimum scene duration (ms). When omitted, falls
   *  back to `doc.min_scene_ms`, then `DEFAULT_MIN_SCENE_MS`. Clamped to
   *  `MIN_SCENE_MS_BOUNDS` before use. See the scene-min-duration plan. */
  minSceneMs?: number;
  /** Workspace-default tail buffer (ms) after a row's narration ends.
   *  Capped at the natural gap to the next row so it never desyncs the
   *  visual cut from the next narration onset. Falls back to
   *  `doc.tail_buffer_ms`, then `DEFAULT_TAIL_BUFFER_MS`. */
  tailBufferMs?: number;
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

  // Scene-timing resolution: options (workspace default) > doc (per-
  // project override) > built-in default. Clamp to bounds so a stale
  // legacy value can never bypass the protection. See plan §Defaults.
  const minSceneMs = clampSceneTiming(
    opts.minSceneMs ?? doc.min_scene_ms ?? DEFAULT_MIN_SCENE_MS,
    MIN_SCENE_MS_BOUNDS,
  );
  const tailBufferMs = clampSceneTiming(
    opts.tailBufferMs ?? doc.tail_buffer_ms ?? DEFAULT_TAIL_BUFFER_MS,
    TAIL_BUFFER_MS_BOUNDS,
  );

  const baseIntervals = calcShotIntervals(timecodes, totalMs, minSceneMs);

  // Apply per-row editor duration overrides (added 2026-05-18 with the
  // shot-graph editor). When a row carries `duration_override_ms` we
  // replace its natural durationMs and rebuild every subsequent row's
  // startMs cumulatively — same cascade rule calcShotIntervals uses.
  // The first edited row anchors the cascade at its OWN startMs (kept
  // from `baseIntervals`) so a resize of row N doesn't reflow earlier
  // rows.
  const overrideCount = doc.rows.reduce(
    (acc, r) => acc + (typeof r.duration_override_ms === 'number' ? 1 : 0),
    0,
  );
  let intervals = baseIntervals;
  if (overrideCount > 0) {
    intervals = [];
    let cursorMs = baseIntervals[0]?.startMs ?? 0;
    for (let i = 0; i < doc.rows.length; i++) {
      const row = doc.rows[i];
      const naturalDuration = baseIntervals[i]?.durationMs ?? minSceneMs;
      const durationMs =
        typeof row.duration_override_ms === 'number' && row.duration_override_ms >= minSceneMs
          ? row.duration_override_ms
          : naturalDuration;
      intervals.push({ startMs: cursorMs, durationMs });
      cursorMs += durationMs;
    }
  }

  if (typeof console !== 'undefined' && console.info) {
    console.info('[render-timing] config built', {
      rowCount: doc.rows.length,
      alignmentPresent: Boolean(opts.alignment),
      minSceneMs,
      tailBufferMs,
      overrideCount,
      // First 5 shots' cascaded intervals (post-override).
      // realignVideoConfig will replace these for aligned rows when
      // alignment data is available.
      firstFiveIntervals: intervals.slice(0, 5),
    });
  }

  const shots: VideoShot[] = doc.rows.map((row, i) => {
    const startMs = intervals[i].startMs;
    const durationMs = intervals[i].durationMs;
    const imageState = rowImages[i];
    const imageUrl = imageState?.status === 'done' ? imageState.imageUrl : undefined;

    const lockedAsStill = opts.rowLockedAsStill?.[i] === true;
    const clipState = animateScenes && !lockedAsStill ? opts.rowVideoClips?.[i] : undefined;
    const videoUrl =
      clipState && clipState.status === 'ready' && clipState.videoUrl
        ? clipState.videoUrl
        : undefined;
    // Pass clip duration through so BRollScene can compute the
    // playback rate that fits the clip to the scene. Only meaningful
    // when videoUrl is set; otherwise undefined and the still path
    // is taken regardless.
    const videoDurationSeconds =
      videoUrl && clipState?.durationSeconds && clipState.durationSeconds > 0
        ? clipState.durationSeconds
        : undefined;

    // Real-image overlay — only attached when the doc generator planned
    // one AND the auto-fetch resolved to a usable URL. The renderer
    // composites at the planned zone/size with a fade-in + scale-in motion.
    //
    // Placement: prefer the saliency-resolved values (set by the overlay
    // placement resolver after image generation) over the LLM's original
    // pick — they're the post-analysis output that knows what's actually
    // in the image. Halo color is sampled from the chosen saliency cell.
    //
    // Stripe guard: legacy rows (pre-saliency) won't have resolved values,
    // so the LLM's blind pick is what we see. When the row uses 'overlay'
    // layout (stripe on top of full-frame scene), top zones would land
    // under the stripe — swap them to their bottom equivalent here so
    // the overlay stays visible without needing a re-generation pass.
    const overlayState = opts.rowOverlays?.[i];
    let finalZone = row.overlay_zone_resolved ?? row.overlay_zone;
    const finalSize = row.overlay_size_resolved ?? row.overlay_size;
    const stripeOverlapsScene =
      Boolean(row.section_title?.trim()) &&
      (row.section_title_layout ?? doc.section_title_layout_default ?? 'letterbox') === 'overlay';
    if (stripeOverlapsScene && finalZone) {
      const mapTopToBottom: Partial<Record<OverlayZone, OverlayZone>> = {
        'top-left': 'bottom-left',
        'top-right': 'bottom-right',
        'center-top': 'center-bottom',
      };
      finalZone = mapTopToBottom[finalZone] ?? finalZone;
    }
    let overlayHaloColor: string | undefined;
    if (overlayState?.status === 'done' && finalZone && row.image_saliency) {
      const idx = zoneToSaliencyIndex(finalZone, row.image_saliency);
      if (idx >= 0) overlayHaloColor = row.image_saliency.dominantColors[idx];
    }
    const overlay =
      overlayState?.status === 'done' &&
      overlayState.url &&
      finalZone &&
      finalSize
        ? {
            url: overlayState.url,
            zone: finalZone,
            size: finalSize,
            haloColor: overlayHaloColor,
            customX:
              typeof row.overlay_position?.x_pct === 'number'
                ? row.overlay_position.x_pct
                : undefined,
            customY:
              typeof row.overlay_position?.y_pct === 'number'
                ? row.overlay_position.y_pct
                : undefined,
            customSizePct:
              typeof row.overlay_size_pct === 'number' ? row.overlay_size_pct : undefined,
          }
        : undefined;

    // Scene-type resolution: if the row has actual visual content (a
    // generated still OR a Kling-animated clip), force b-roll so the
    // image/video is what plays. The `inferSceneType` heuristic runs a
    // substring match on `visual_type` and will pick `text-reveal`
    // for any row whose visual_type contains "stat" / "fact" / "quote"
    // / "text" — even when the row has a full still + animation ready.
    // That used to silently swap a finished b-roll for a plain-text
    // card on every "statistic" shot. Heuristic now only applies when
    // there's no visual to play.
    const hasVisual = Boolean(imageUrl || videoUrl);
    const sceneType = hasVisual ? 'b-roll' : inferSceneType(row.visual_type);

    return {
      startMs,
      durationMs,
      sceneType,
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
      sectionTitleLayout: row.section_title
        ? (row.section_title_layout ?? doc.section_title_layout_default ?? 'letterbox')
        : undefined,
      pillarboxColor: row.pillarbox_color || undefined,
      sceneZoom:
        typeof row.scene_zoom === 'number' && Number.isFinite(row.scene_zoom)
          ? row.scene_zoom
          : typeof doc.scene_zoom_default === 'number' && Number.isFinite(doc.scene_zoom_default)
          ? doc.scene_zoom_default
          : undefined,
      thumbnailTransition: row.thumbnail_transition,
      sceneFade: row.scene_fade,
      videoDurationSeconds,
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
    pillarboxColorDefault: doc.pillarbox_color_default || undefined,
    // Carry the resolved timing knobs through so a server-side
    // realignVideoConfig call (render route) doesn't have to re-resolve
    // from doc/options that may not be on hand.
    minSceneMs,
    tailBufferMs,
    sceneFadeEnabled: doc.scene_fade_enabled,
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

/** Per-row trace from `applySceneTimingRules`, used by the diagnostic
 *  logs to show what each rule did. Not exported — internal to
 *  `realignVideoConfig`. */
interface SceneTimingTrace {
  rowIndex: number;
  source: AlignedRow['source'];
  rawStartMs: number;
  rawEndMs: number;
  finalStartMs: number;
  finalEndMs: number;
  appliedBuffer: boolean;
  appliedGapFill: boolean;
  appliedFloor: boolean;
  cascadedFromPrev: boolean;
}

/**
 * Apply the three scene-timing rules to a sequence of aligned rows.
 * Order per `_plans/2026-05-17-scene-min-duration-and-tail-buffer.md`:
 *
 *   1. Cascade `startMs` forward so a previous shot's extension never
 *      gets overlapped by the next shot.
 *   2. Tail buffer (aligned rows only), capped at the gap to the next
 *      row's natural start so a continuous-narration sequence does not
 *      desync.
 *   3. Forward gap-fill — extend `endMs` to the next row's natural
 *      start when the tail buffer didn't already cover it.
 *   4. Minimum scene duration floor.
 *
 * Pure. Caller frame-snaps the result; this function works in raw ms so
 * unit tests can assert on exact values without an fps round-trip.
 */
function applySceneTimingRules(
  rows: AlignedRow[],
  opts: { minSceneMs: number; tailBufferMs: number },
): { rows: AlignedRow[]; traces: SceneTimingTrace[] } {
  const out: AlignedRow[] = [];
  const traces: SceneTimingTrace[] = [];
  let prevEndMs = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    const rawStartMs = row.startMs;
    const rawEndMs = row.endMs;

    const cascadedFromPrev = prevEndMs > row.startMs;
    const startMs = Math.max(row.startMs, prevEndMs);
    let endMs = row.endMs;

    // Rule 2: tail buffer, capped at the gap before the next row's
    // natural narration onset. Only applies to aligned rows — estimated
    // rows don't have a precise "narration end" to pad past.
    let appliedBuffer = false;
    if (row.source === 'aligned' && opts.tailBufferMs > 0) {
      const cap = next ? Math.max(0, next.startMs - endMs) : opts.tailBufferMs;
      const buffer = Math.min(opts.tailBufferMs, cap);
      if (buffer > 0) {
        endMs += buffer;
        appliedBuffer = true;
      }
    }

    // Rule 3: forward gap-fill. The tail buffer above only extends up
    // to the next row's start when there's slack; this catches the
    // rest (e.g. estimated row followed by aligned row with a gap).
    let appliedGapFill = false;
    if (next && endMs < next.startMs) {
      endMs = next.startMs;
      appliedGapFill = true;
    }

    // Rule 4: minimum scene duration floor. Cascades into the next
    // row's startMs on the next loop iteration via prevEndMs.
    let appliedFloor = false;
    if (endMs - startMs < opts.minSceneMs) {
      endMs = startMs + opts.minSceneMs;
      appliedFloor = true;
    }

    out.push({ ...row, startMs, endMs });
    traces.push({
      rowIndex: row.rowIndex,
      source: row.source,
      rawStartMs,
      rawEndMs,
      finalStartMs: startMs,
      finalEndMs: endMs,
      appliedBuffer,
      appliedGapFill,
      appliedFloor,
      cascadedFromPrev,
    });
    prevEndMs = endMs;
  }
  return { rows: out, traces };
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
 * After the aligner produces per-row windows, `applySceneTimingRules`
 * enforces tail buffer, gap-fill, and the minimum scene floor so an
 * aligner failure on a short title row (or a too-tight WPM estimate)
 * can never produce a sub-readable shot or a black-frame gap.
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

  const rawAligned = alignRowsToWords({
    rowScripts,
    fallbackStartMs,
    fallbackTotalMs,
    alignment,
  });

  // Resolve the timing knobs. VideoConfig carries them through from
  // the client when the config was built via productionDocToVideoConfig;
  // when realignVideoConfig is called standalone (defensive fallback),
  // use the system defaults so behaviour degrades safely rather than
  // dropping the floor entirely.
  const minSceneMs = clampSceneTiming(
    config.minSceneMs ?? DEFAULT_MIN_SCENE_MS,
    MIN_SCENE_MS_BOUNDS,
  );
  const tailBufferMs = clampSceneTiming(
    config.tailBufferMs ?? DEFAULT_TAIL_BUFFER_MS,
    TAIL_BUFFER_MS_BOUNDS,
  );

  const { rows: alignedRows, traces } = applySceneTimingRules(rawAligned, {
    minSceneMs,
    tailBufferMs,
  });

  if (typeof console !== 'undefined' && console.info) {
    const alignedCount = alignedRows.filter((r) => r.source === 'aligned').length;
    const estimatedCount = alignedRows.length - alignedCount;
    console.info('[render-timing] realigned', {
      rowCount: alignedRows.length,
      aligned: alignedCount,
      estimated: estimatedCount,
      minSceneMs,
      tailBufferMs,
      bufferAppliedRows: traces.filter((t) => t.appliedBuffer).length,
      gapFilledRows: traces.filter((t) => t.appliedGapFill).length,
      floorAppliedRows: traces.filter((t) => t.appliedFloor).length,
      cascadedRows: traces.filter((t) => t.cascadedFromPrev).length,
      firstFiveTraces: traces.slice(0, 5),
    });
  }

  // Build the new shots in one pass. Frame-snapping happens here, not
  // in `alignRowsToWords` or `applySceneTimingRules`, so those pure
  // helpers can be tested against exact ms values without an fps
  // round-trip.
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

/** Map a semantic overlay zone to a flat row-major index into a saliency
 *  grid. Returns -1 when the grid is too small to host the named zone.
 *  Used by `productionDocToVideoConfig` to sample the halo color for an
 *  overlay from the cell it'll land in. */
export function zoneToSaliencyIndex(
  zone: OverlayZone,
  saliency: ImageSaliencyMap,
): number {
  const { cols, rows } = saliency;
  if (cols < 2 || rows < 2) return -1;
  const left = 0;
  const right = cols - 1;
  const cx = Math.floor(cols / 2);
  const top = 0;
  const bottom = rows - 1;
  const cy = Math.floor(rows / 2);
  const at = (col: number, row: number) => row * cols + col;
  switch (zone) {
    case 'top-left':      return at(left, top);
    case 'top-right':     return at(right, top);
    case 'bottom-left':   return at(left, bottom);
    case 'bottom-right':  return at(right, bottom);
    case 'center-top':    return at(cx, top);
    case 'center-bottom': return at(cx, bottom);
    case 'left-center':   return at(left, cy);
    case 'right-center':  return at(right, cy);
  }
}
