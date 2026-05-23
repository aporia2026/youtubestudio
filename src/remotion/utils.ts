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

// ─── Thumbnail-region zoom padding ────────────────────────────────────────────
//
// Per `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`:
// the historical `ThumbnailZoomScene` framing scaled the region exactly
// to canvas, producing an over-tight crop with no breathing room. The
// new default pulls the camera back ~15% on each side so a marked
// region sits inside the frame with visible surrounding content.
//
// Range is clamped server- AND client-side so a malformed payload can
// never produce an infinite scale or NaN inside Remotion.
export const DEFAULT_REGION_ZOOM_PADDING_PCT = 15;
export const REGION_ZOOM_PADDING_BOUNDS = { min: 0, max: 50 } as const;

/** Clamp `n` to `[bounds.min, bounds.max]`. Used by the timing knobs. */
export function clampSceneTiming(n: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(n)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
}

// ─── Voiceover gain / fade clamping ───────────────────────────────────────────

/** Hard limits on the doc-level voiceover gain knob. -60 dB is practical
 *  silence; +12 dB is the most we'll allow without forcing the user
 *  through a "are you sure" prompt to avoid clipping. */
export const VOICEOVER_VOLUME_DB_MIN = -60;
export const VOICEOVER_VOLUME_DB_MAX = 12;

/** Hard cap on voiceover fade-in / fade-out durations. 10 s is the
 *  longest fade that makes editorial sense for a tutorial / explainer
 *  voiceover; longer values typically indicate a typo. */
export const VOICEOVER_FADE_MS_MAX = 10_000;

export function clampVolumeDb(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(VOICEOVER_VOLUME_DB_MAX, Math.max(VOICEOVER_VOLUME_DB_MIN, value));
}

export function clampFadeMs(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(VOICEOVER_FADE_MS_MAX, Math.round(value));
}

/** Convert decibels to a linear gain multiplier for `<Audio>` volume.
 *  Standard formula: `gain = 10 ^ (dB / 20)`. The Remotion `<Audio>`
 *  element expects a linear multiplier in `[0, ∞)`. */
export function dbToLinearGain(db: number): number {
  return Math.pow(10, db / 20);
}

// ─── On-screen-text mode resolution ────────────────────────────────────────────

/** Result of resolving a row's OST rendering against the doc default.
 *  - `overlayText` is set only when mode='overlay' AND the text is non-empty;
 *    that's the value the renderer feeds into LowerThird.
 *  - `suppressLowerThird` is `true` for `'bake'` and `'none'` so the renderer
 *    skips the LowerThird mount (avoids double text in `'bake'`, no text in
 *    `'none'`). See `_plans/2026-05-21-phase-5-text-mode-toggle.md`. */
export interface OstRendering {
  mode: 'bake' | 'overlay' | 'none';
  overlayText: string | undefined;
  suppressLowerThird: boolean;
}

/** Resolve OST rendering: row → doc-default → `'bake'` (back-compat for pre-
 *  Phase-5 docs that never set the field). Pure — easy to unit-test. */
export function resolveOstRendering(
  rowMode: 'bake' | 'overlay' | 'none' | undefined,
  docDefault: 'bake' | 'overlay' | 'none' | undefined,
  rowText: string | undefined,
): OstRendering {
  const mode = rowMode ?? docDefault ?? 'bake';
  const trimmed = (rowText || '').trim();
  return {
    mode,
    overlayText: mode === 'overlay' && trimmed.length > 0 ? trimmed : undefined,
    suppressLowerThird: mode !== 'overlay',
  };
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

/** Threshold above which `topStripeBusyness` is considered "the title
 *  would cover busy image content" — drives the smart auto-shift in
 *  overlay-layout title rows. Conservative enough to leave rows with
 *  blank-sky tops alone, low enough to catch the typical illustration
 *  where the doodle action is dead-centre. Surfaces in the editor's
 *  per-row indicator so the user knows WHY a row is recommended for
 *  auto-fix. */
export const AUTO_SHIFT_COLLISION_THRESHOLD = 0.4;

/** Mean busyness in the top stripe of a saliency map. Used by the
 *  auto-shift heuristic in overlay-layout title rows: if the image
 *  has high importance under where the title would sit, the renderer
 *  shifts the image down to clear it. Returns 0 when the saliency is
 *  malformed or the stripe is empty. */
export function topStripeBusyness(
  saliency: ImageSaliencyMap,
  stripeFraction: number,
): number {
  if (!Array.isArray(saliency.busyness) || saliency.busyness.length === 0) {
    return 0;
  }
  if (saliency.cols <= 0 || saliency.rows <= 0) return 0;
  const stripeRowCount = Math.max(1, Math.ceil(saliency.rows * stripeFraction));
  let sum = 0;
  let count = 0;
  for (let r = 0; r < stripeRowCount && r < saliency.rows; r++) {
    for (let c = 0; c < saliency.cols; c++) {
      const idx = r * saliency.cols + c;
      const v = saliency.busyness[idx];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Decide whether a row qualifies for the smart auto-shift. Returns
 *  the recommended `image_y_pct` value when the row WOULD benefit, or
 *  `null` when it wouldn't (no title, wrong layout, no saliency,
 *  busyness below threshold, or no visual on the row).
 *
 *  Pure function — no side effects, safe to call from the editor
 *  inspector to drive the "Apply auto-fix" affordance AND from the
 *  renderer's `productionDocToVideoConfig` to apply automatically
 *  when the row has no manual override. Same logic in both places
 *  keeps the "what the editor recommends" and "what the renderer
 *  does" perfectly aligned. */
export function computeAutoShiftYPct(
  row: ProductionRow,
  doc: ProductionDoc,
  hasVisual: boolean,
): { yPct: number; collisionScore: number; stripeFraction: number } | null {
  if (!hasVisual) return null;
  const layout =
    row.section_title_layout ?? doc.section_title_layout_default ?? 'letterbox';
  if (!row.section_title || layout !== 'overlay' || !row.image_saliency) {
    return null;
  }
  const stripeFraction = doc.thumbnail?.stripeHeightFraction ?? 0.13;
  const collisionScore = topStripeBusyness(row.image_saliency, stripeFraction);
  if (collisionScore <= AUTO_SHIFT_COLLISION_THRESHOLD) return null;
  return { yPct: stripeFraction * 100, collisionScore, stripeFraction };
}

/** Categorised edit tracking per row. Each field key matches the
 *  store command category that touches it. Reads via
 *  `@/lib/editor/edited-at::readRowEditedAt` to normalise the
 *  legacy string shape. */
export interface RowEditedAt {
  /** When ANY edit landed on the row. Always the most recent of
   *  every `fields` value. */
  any: string;
  /** Per-category timestamps. Absent key = no edit via that path. */
  fields?: {
    image?: string;
    video?: string;
    script_text?: string;
    visual_description?: string;
    ai_image_prompt?: string;
    on_screen_text?: string;
    duration?: string;
    trim?: string;
    mute?: string;
    structure?: string;
  };
}

export type RowEditedAtCategory = keyof NonNullable<RowEditedAt['fields']>;

export interface ProductionRow {
  timecode: string;
  script_text: string;
  visual_type: string;
  visual_description: string;
  stock_search_terms: string;
  ai_image_prompt: string;
  /** Phase 7 — opt out of style-sheet chaining for this row. Generation-time
   *  concern only; the renderer ignores this field. */
  style_sheet_skip?: boolean;
  on_screen_text: string;
  /** How this row's `on_screen_text` is realised: `'bake'` puts the text
   *  inside the generated image; `'overlay'` keeps the image clean and
   *  composites the text via LowerThird at render time; `'none'` shows
   *  no text. Undefined ⇒ ProductionDoc.on_screen_text_mode_default,
   *  then `'bake'` (back-compat). See
   *  `_plans/2026-05-21-phase-5-text-mode-toggle.md`. */
  on_screen_text_mode?: 'bake' | 'overlay' | 'none';
  notes: string;
  /** Planning fields for auto-sourced real-image overlays. See the
   *  `/api/overlay/fetch` route and the OverlayCell component. */
  overlay_stock_terms?: string;
  overlay_zone?: OverlayZone;
  overlay_size?: OverlaySize;
  /** Per-row escape hatch from the doc-level overlay behaviour. When
   *  `true`, this row never auto-fetches an overlay even if
   *  `overlay_stock_terms` is set AND the doc-level toggle would
   *  otherwise allow it. When `false`, this row DOES auto-fetch even
   *  when the doc-level `overlays_disabled` is on (rare — used to
   *  force one specific row to keep an overlay in an otherwise
   *  overlay-free doc). Undefined ⇒ follow the doc-level setting. */
  skip_overlay?: boolean;
  /** Phase 5 of `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
   *  Background-removed cutout of the row's image (alpha PNG). Set by
   *  the Remove background AI verb. Stored separately from
   *  `image_url` so the action stays undoable: flipping
   *  `image_rmbg_applied` back to false reverts to the original
   *  image without re-running the model. */
  image_rmbg_url?: string;
  /** When true AND `image_rmbg_url` is set, the renderer uses the
   *  cutout instead of the original image. The cutout's transparent
   *  regions show whatever the scene background renders underneath
   *  (row.background_color → doc.pillarbox_color_default → white).
   *  Default false; legacy docs ⇒ historical behaviour. */
  image_rmbg_applied?: boolean;
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
  /** Manual overlay height as % of frame height — set only by Shift+drag
   *  on a resize handle (free aspect). Absent means height follows the
   *  image's natural aspect. Phase 1 of
   *  `_plans/2026-05-18-overlay-system-overhaul.md`. */
  overlay_stretched_height_pct?: number;
  /** One-sentence AI rationale for this overlay's auto-picked size and
   *  position — written by `/api/overlay/fetch` when smart placement
   *  ran at fetch time. Phase 2 of the overlay-system overhaul. */
  overlay_placement_reason?: string;
  /** Model id that produced the placement decision (e.g.
   *  `kie-gemini-3.1-pro`). 'doc-gen-blind' for pre-Phase-2 rows whose
   *  zone/size came from the text-only doc-gen LLM. Drives the per-
   *  model drag-rate telemetry signal. */
  overlay_placement_model?: string;
  /** Phase 4 — `true` when the RMBG cutout was uploaded to R2,
   *  `false` when the heuristic gate (or vision tiebreaker) decided
   *  the original Brave-source image was a cleaner overlay and we
   *  re-encoded that as PNG instead. Absent on pre-Phase-4 rows. */
  overlay_rmbg_kept?: boolean;
  /** Phase 5 — stack of prior overlay URLs (R2 keys) the row has been
   *  through via AI edits. Oldest first, most-recent-last. Capped at
   *  3 entries so we don't bloat saved-doc payloads. Each Accept on
   *  the edit dialog pushes the current URL onto this stack; an
   *  "Undo edit" button pops the most recent entry back into the
   *  live overlay slot. */
  overlay_edit_history?: string[];
  /** Cached saliency map of `imageUrl` for this row — populated by the
   *  image-generation route. Sparse: missing for rows whose image hasn't
   *  been generated, or which pre-date the feature. */
  image_saliency?: ImageSaliencyMap;
  /** Per-row transition override; falls back to ProductionDoc.thumbnail.defaultTransition. */
  thumbnail_transition?: ThumbnailTransitionConfig;
  /** Camera padding for the thumbnail-zoom framing on this row, as a
   *  percent of the region's longest edge added on each side. Higher
   *  pulls the camera back so the region sits inside the frame with
   *  breathing room. Range `[0, 50]`. Falls back to
   *  `ProductionDoc.region_zoom_padding_default_pct`, then to the
   *  built-in default (15). Only meaningful when `thumbnail_zoom_to`
   *  is set. See
   *  `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`. */
  region_zoom_padding_pct?: number;
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
  /** When `true`, the user has explicitly pinned this row's duration
   *  via Set timing / drag / insert / split / merge. Voiceover
   *  alignment respects the pin — keeps cascade-derived values for
   *  this row instead of overwriting them with word-derived positions.
   *
   *  Legacy rows with `duration_override_ms` but no `pin_duration`
   *  are NOT pinned: alignment continues to overwrite, preserving
   *  existing project playback exactly as it was before the pin
   *  feature shipped. Only NEW user actions set this flag.
   *
   *  See `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
  pin_duration?: boolean;
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
  /** Editor edit tracking. Carries the timestamp of the last edit
   *  AND per-category timestamps (image / video / script_text / etc.)
   *  so future AI regen paths can honor the "manual edit wins over
   *  AI regen" rule from `_plans/2026-05-18-shot-graph-editor.md`.
   *
   *  Backward-compat: legacy rows may carry a plain ISO-string
   *  `edited_at` (the original Phase 1 shape). Callers that read
   *  this field should use `readRowEditedAt` from
   *  `@/lib/editor/edited-at` which normalises both shapes. */
  edited_at?: RowEditedAt | string;
  /** Editor's pick-from-project override of the source video clip
   *  for this row. When set, the renderer uses this URL instead of
   *  the auto-pipeline's rowVideoClips entry. Cleared (undefined)
   *  means "fall back to the doc-level clip resolution." */
  video_url_override?: string;
  /** Intrinsic duration of the override clip in seconds — used by
   *  BRollScene's playback-rate fit math. */
  video_duration_seconds_override?: number;
  /** Per-row animation model lock. When set, takes precedence over
   *  `ProductionDoc.broll_model_id` and the workspace default. Lets
   *  the user pick a specific i2v model for THIS shot without flipping
   *  the doc-wide default. Cleared (undefined) means "fall back to
   *  doc-level → workspace-level resolution." */
  broll_model_id?: string;
  /** How the renderer reconciles a clip's intrinsic duration with the
   *  scene's duration when they differ (e.g. Kling 10s clips in a 12s
   *  narration-driven scene). 2026-05-23.
   *
   *  - `stretch` (default, undefined): rescale playbackRate so the clip
   *    fills the scene exactly. Slow-mo when scene > clip, speed-up
   *    when scene < clip. Clamped to [0.25, 2.0] in the renderer.
   *  - `freeze-last`: play at native 1.0× speed. If the scene is
   *    longer, the last frame freezes for the remainder. If shorter,
   *    the trailing clip frames are cut.
   *  - `loop`: play at native 1.0×; when the scene is longer, the
   *    clip restarts from frame 0 and continues as many times as
   *    needed. Good for ambient/cyclical motion.
   *  - `trim-scene`: data signal, not a render mode. The inspector's
   *    "Trim scene to clip" button writes
   *    `duration_override_ms = clip_duration_ms` so the scene's
   *    playable window shortens to match the clip exactly. The
   *    renderer treats it as `stretch` (which becomes a no-op once
   *    durations match). */
  clip_fit_mode?: 'stretch' | 'freeze-last' | 'loop' | 'trim-scene';
  /** Free-transform offset of the visual element on the 1920×1080
   *  canvas, expressed as a percentage of canvas width/height from
   *  the center. `0` = centered (the default). Range [-200, 200] —
   *  values outside ±100 place the visual partially off-frame, which
   *  is sometimes useful for stylized framings. Persisted alongside
   *  `image_y_pct`, `image_scale_pct`, `image_rotation_deg`; the
   *  renderer composes them into a single CSS transform applied AFTER
   *  the existing scene_zoom wrapper. See
   *  `_plans/2026-05-23-editor-canva-transform.md`. */
  image_x_pct?: number;
  image_y_pct?: number;
  /** Free-transform scale of the visual element as a percentage of
   *  its natural fit size. `100` = fits the canvas the way today's
   *  render does. Composes with `scene_zoom`: effective scale is
   *  scene_zoom% × image_scale_pct%. Range [10, 400]. */
  image_scale_pct?: number;
  /** Free-transform rotation in degrees, clockwise. `0` = no rotation.
   *  Range [-3600, 3600] — stored unbounded so spins can be
   *  represented; the renderer applies modulo as needed. */
  image_rotation_deg?: number;
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
  /** Doc-level fallback for `ProductionRow.on_screen_text_mode`. Auto-pipeline
   *  output should set this to `'overlay'`. Undefined ⇒ renderer treats it
   *  as `'bake'` (back-compat with pre-Phase-5 docs). */
  on_screen_text_mode_default?: 'bake' | 'overlay' | 'none';
  /** Phase 7 — style sheet bookkeeping. Carried on the doc but only used
   *  at generation time (not at render time), so the Remotion mapper
   *  ignores these fields. Mirrored here so the type stays compatible
   *  with the page-level ProductionDoc shape. See
   *  `_plans/2026-05-21-phase-7-style-sheet.md`. */
  style_sheet_url?: string;
  style_sheet_model?: 'flux-schnell-local' | 'qwen-image-local';
  style_sheet_has_protagonist?: boolean;
  style_sheet_prompt?: string;
  style_sheet_description?: string;
  /** v2 (2026-05-22): the doc's active style-preset id. Persisted on
   *  the doc itself so downstream surfaces (the shot-graph editor's
   *  regenerate button, future analyses, etc.) can reliably read the
   *  user's choice without depending on transient localStorage state.
   *  May be a built-in slug ('doodle_explainer', 'cinematic') or a
   *  saved-style UUID. Undefined on legacy docs — callers fall back to
   *  the user's `default_style_preset` setting or to the built-in
   *  default. See `_plans/2026-05-21-user-defined-styles-with-reference-images.md`. */
  style_preset?: string;
  /** Doc-level fallback for the static scene zoom percentage. Per-row
   *  `scene_zoom` overrides this. Undefined ⇒ 100 (no zoom). */
  scene_zoom_default?: number;
  /** Doc-level fallback for the thumbnail-region camera padding (percent
   *  of the region's longest edge added on each side). Per-row
   *  `region_zoom_padding_pct` overrides this. Range `[0, 50]`.
   *  Undefined ⇒ built-in default (15) so existing renders pull the
   *  camera back slightly from the over-tight exact-region framing.
   *  See `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`. */
  region_zoom_padding_default_pct?: number;
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
  /** Doc-level animation (image-to-video) model id. Every B-roll cell
   *  uses this as the default when the row doesn't have its own lock.
   *  Tier priority: row-level lock > doc-level > user-level default.
   *  Undefined ⇒ each row falls back to the user's global default.
   *  Mirrors the production-doc page's `Animation model for all shots`
   *  bulk picker — surfaced in the editor's doc-defaults panel so the
   *  user can change it without bouncing pages. */
  broll_model_id?: string;
  /** Doc-level text overlays — Phase 4 master overlay layer (shot-
   *  graph editor plan). Each overlay spans a configurable time
   *  window independent of any row. Persisted on the doc so editor
   *  + render see the same data. Empty array OR undefined renders
   *  nothing. */
  text_overlays?: import('@/remotion/types').TextOverlay[];
  /** When `true`, the editor SKIPS the auto-fetch overlay pipeline for
   *  every row (Brave Search → RMBG → smart placement). Lets the user
   *  rely on brand mentions baked directly into `ai_image_prompt`
   *  instead of pasting separate stock PNGs on top of the still. Per-
   *  row `skip_overlay` overrides this in either direction. Undefined
   *  on legacy docs ⇒ historical behaviour (overlays auto-fetch). */
  overlays_disabled?: boolean;
  /** Doc-level voiceover mute. When `true`, the renderer outputs the
   *  voiceover at zero gain (the `<Audio>` element still mounts so
   *  buffering / timeline alignment stay identical — only the volume
   *  is dropped). Undefined ⇒ historical behaviour (audible). See
   *  `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`. */
  voiceover_muted?: boolean;
  /** Doc-level voiceover gain in decibels relative to source. Range
   *  clamped to [-60, +12] before use. `0` is unity gain (default).
   *  Negative values reduce; positive values amplify (be careful past
   *  +6 — most VOs already sit close to peak). Undefined ⇒ unity. */
  voiceover_volume_db?: number;
  /** Doc-level voiceover fade-in duration in ms. The renderer ramps
   *  gain from 0 → target gain over this window starting at t=0.
   *  Default 0 (no fade). Capped at 10s by the editor UI. */
  voiceover_fade_in_ms?: number;
  /** Doc-level voiceover fade-out duration in ms. The renderer ramps
   *  gain from target gain → 0 across the last `fade_out_ms` of the
   *  voiceover's runtime. Default 0 (no fade). Capped at 10s by the
   *  editor UI. */
  voiceover_fade_out_ms?: number;
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
  /** Broll clip UUID. When set, the renderer URL is rewritten to the
   *  same-origin proxy `/api/broll/<brollClipId>/video` instead of the
   *  raw R2 presigned URL. Remotion's `<OffthreadVideo>` silently
   *  produces empty frames on URLs with many query parameters (the
   *  X-Amz-* presign params), so routing through a clean proxy URL
   *  with no query string is the workaround. The original `videoUrl`
   *  remains the source of truth for the in-browser preview player
   *  (where the presigned URL works fine). 2026-05-20. */
  brollClipId?: string;
  /** Provider error message when status is 'failed' or 'error'. The
   *  inspector surfaces this inline so the user sees WHY the animation
   *  failed instead of just a generic "Animation failed" pill. */
  errorMessage?: string;
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
  /** Burned-in captions to render via CaptionsOverlay. Editor passes
   *  through `state.captions.segments` so renders include the same
   *  captions the user saw in the editor's preview. Phase 4 of the
   *  shot-graph editor plan. */
  captions?: Array<{ start: number; end: number; text: string }>;
  /** When `true`, emit `/api/broll/<brollClipId>/video` for ready clips
   *  instead of the raw R2 presigned `videoUrl`. The server-side
   *  Remotion renderer needs the proxy URL — its `<OffthreadVideo>`
   *  silently produces empty frames on URLs with many X-Amz-* query
   *  parameters. The in-browser preview Player works fine with the
   *  direct R2 URL and shouldn't pay the Vercel-bandwidth tax for every
   *  scrub. Default `false` (direct URL); the render route opts in.
   *  See route `/api/broll/[id]/video/route.ts`. 2026-05-20. */
  useBrollProxy?: boolean;
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
    const baseImageUrl = imageState?.status === 'done' ? imageState.imageUrl : undefined;
    // Phase 5 of editor timeline-and-shots overhaul plan: when the
    // user applied "Remove background" on this row, the renderer
    // swaps in the alpha cutout. The original image is preserved
    // in rowImages (state.rowImages keeps the originally generated
    // URL) so flipping `image_rmbg_applied` back to false reverts
    // without re-running the RMBG model — that's the user-visible
    // "Restore original background" affordance.
    const useRmbg =
      row.image_rmbg_applied === true &&
      typeof row.image_rmbg_url === 'string' &&
      row.image_rmbg_url.length > 0;
    const imageUrl = useRmbg ? row.image_rmbg_url : baseImageUrl;

    const lockedAsStill = opts.rowLockedAsStill?.[i] === true;
    const clipState = animateScenes && !lockedAsStill ? opts.rowVideoClips?.[i] : undefined;
    // Editor's pick-from-project override takes precedence over the
    // auto-pipeline's rowVideoClips entry. When the override is set
    // we ignore `animateScenes=false` and `lockedAsStill=true` for
    // THIS row — the user explicitly picked a clip in the inspector,
    // so respecting that intent matters more than the doc-level
    // toggle. Undefined override leaves the existing logic intact.
    const overrideVideoUrl =
      typeof row.video_url_override === 'string' && row.video_url_override
        ? row.video_url_override
        : undefined;
    // Resolve the videoUrl. Two cases:
    //   1. Editor override (`video_url_override`) — used verbatim.
    //   2. Auto-generated broll clip — use the same-origin proxy
    //      `/api/broll/<id>/video` ONLY when `opts.useBrollProxy === true`
    //      (the server-side render route). The in-browser preview Player
    //      uses the raw R2 URL so we don't pay Vercel bandwidth for
    //      every preview scrub. The presigned URL silently breaks
    //      Remotion's OffthreadVideo URL cache key handling on the
    //      server, so the render route opts in to the proxy. Falls back
    //      to the raw videoUrl when the clip id isn't known (legacy
    //      state). 2026-05-20.
    let videoUrl: string | undefined;
    if (overrideVideoUrl) {
      videoUrl = overrideVideoUrl;
    } else if (clipState && clipState.status === 'ready' && clipState.videoUrl) {
      videoUrl = opts.useBrollProxy && clipState.brollClipId
        ? `/api/broll/${encodeURIComponent(clipState.brollClipId)}/video`
        : clipState.videoUrl;
    }
    // Pass clip duration through so BRollScene can compute the
    // playback rate that fits the clip to the scene. Only meaningful
    // when videoUrl is set; otherwise undefined and the still path
    // is taken regardless.
    const overrideDuration =
      overrideVideoUrl &&
      typeof row.video_duration_seconds_override === 'number' &&
      row.video_duration_seconds_override > 0
        ? row.video_duration_seconds_override
        : undefined;
    const videoDurationSeconds =
      overrideDuration ??
      (videoUrl && clipState?.durationSeconds && clipState.durationSeconds > 0
        ? clipState.durationSeconds
        : undefined);

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
            stretchedHeightPct:
              typeof row.overlay_stretched_height_pct === 'number'
                ? row.overlay_stretched_height_pct
                : undefined,
            placementReason:
              typeof row.overlay_placement_reason === 'string' && row.overlay_placement_reason.length > 0
                ? row.overlay_placement_reason
                : undefined,
            rmbgKept:
              typeof row.overlay_rmbg_kept === 'boolean' ? row.overlay_rmbg_kept : undefined,
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

    // Resolve OST rendering (row → doc-default → 'bake'). 'overlay' is the
    // only mode that mounts a Remotion LowerThird; 'bake' (text already in
    // image pixels) and 'none' suppress it. See
    // `_plans/2026-05-21-phase-5-text-mode-toggle.md`.
    const ost = resolveOstRendering(row.on_screen_text_mode, doc.on_screen_text_mode_default, row.on_screen_text);

    return {
      startMs,
      durationMs,
      sceneType,
      imageUrl,
      videoUrl,
      title: row.on_screen_text || undefined,
      onScreenText: ost.overlayText,
      suppressLowerThird: ost.suppressLowerThird,
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
      // Canva-style free-transform — per-row, no doc-level default
      // for v1. All four fields are optional; the renderer treats
      // unset as identity.
      imageXPct:
        typeof row.image_x_pct === 'number' && Number.isFinite(row.image_x_pct)
          ? row.image_x_pct
          : undefined,
      imageYPct: (() => {
        // Manual override always wins.
        if (typeof row.image_y_pct === 'number' && Number.isFinite(row.image_y_pct)) {
          return row.image_y_pct;
        }
        // Smart auto-shift (2026-05-23) — see computeAutoShiftYPct
        // for the decision logic. Same helper drives the editor's
        // "Apply auto-fix" UI so the recommendation and the actual
        // render stay in lockstep.
        const auto = computeAutoShiftYPct(row, doc, Boolean(imageUrl || videoUrl));
        if (auto && typeof console !== 'undefined') {
          console.info('[renderer auto-shift] applied', {
            rowIndex: i,
            collisionScore: Number(auto.collisionScore.toFixed(2)),
            stripeFraction: auto.stripeFraction,
            autoShiftPct: auto.yPct,
            reason: 'overlay-mode title would cover busy image area',
          });
        }
        return auto?.yPct;
      })(),
      imageScalePct:
        typeof row.image_scale_pct === 'number' && Number.isFinite(row.image_scale_pct)
          ? row.image_scale_pct
          : undefined,
      imageRotationDeg:
        typeof row.image_rotation_deg === 'number' && Number.isFinite(row.image_rotation_deg)
          ? row.image_rotation_deg
          : undefined,
      clipFitMode: row.clip_fit_mode,
      thumbnailTransition: row.thumbnail_transition,
      // Resolve thumbnail-region camera padding for THIS row. Order:
      //   row.region_zoom_padding_pct → doc.region_zoom_padding_default_pct
      //   → DEFAULT_REGION_ZOOM_PADDING_PCT (15).
      // Clamped to [0, 50] so a stale/legacy value can't break the math
      // inside ThumbnailZoomScene. Only meaningful when thumbnail_zoom_to
      // is set; harmless otherwise (the scene router ignores it).
      regionZoomPaddingPct: clampSceneTiming(
        typeof row.region_zoom_padding_pct === 'number' && Number.isFinite(row.region_zoom_padding_pct)
          ? row.region_zoom_padding_pct
          : typeof doc.region_zoom_padding_default_pct === 'number' &&
              Number.isFinite(doc.region_zoom_padding_default_pct)
            ? doc.region_zoom_padding_default_pct
            : DEFAULT_REGION_ZOOM_PADDING_PCT,
        REGION_ZOOM_PADDING_BOUNDS,
      ),
      // Editor's `transition_in: 'cross-fade'` and the doc's existing
      // `scene_fade: true` mean the same thing at render time — fade
      // INTO this shot. The editor uses `transition_in` because it's
      // a discriminated union with room to grow (slide, wipe, etc.
      // later) while `scene_fade` is a boolean toggle. We resolve to
      // `sceneFade` here so the renderer's existing fade logic
      // doesn't need to change.
      //
      // Doc-level OFF overrides everything. When the user explicitly
      // toggles `Scene fade between shots` OFF
      // (`doc.scene_fade_enabled === false`), force `sceneFade=false`
      // on every shot — regardless of per-row `transition_in` or
      // `scene_fade`. Without this override, editor-stamped
      // `transition_in: 'cross-fade'` values silently shadow the doc
      // toggle, which made creators report "fades still appear even
      // though I turned them off." 2026-05-20.
      sceneFade:
        doc.scene_fade_enabled === false
          ? false
          : row.transition_in === 'cross-fade'
            ? true
            : row.transition_in === null
              ? false
              : row.scene_fade,
      videoDurationSeconds,
      overlay,
      // Shot-graph editor fields. The renderer reads these when
      // present; pre-editor rows leave them undefined and behave
      // exactly as before. See `_plans/2026-05-18-shot-graph-editor.md`.
      trimStartMs: row.trim_start_ms,
      trimEndMs: row.trim_end_ms,
      muted: row.muted,
      playbackRate: row.playback_rate,
      transitionInId: row.transition_in,
      // `edited_at` deliberately NOT threaded — see comment in VideoShot.
    };
  });

  // Voiceover gain knobs — read straight off the doc. The mapper just
  // copies + clamps; the actual gain math runs inside the Remotion
  // composition (see YouTubeVideo.tsx) so a static config object is
  // enough to drive both preview and server render.
  const voiceoverVolumeDb = clampVolumeDb(doc.voiceover_volume_db);
  const voiceoverFadeInMs = clampFadeMs(doc.voiceover_fade_in_ms);
  const voiceoverFadeOutMs = clampFadeMs(doc.voiceover_fade_out_ms);

  const config: VideoConfig = {
    fps,
    width: 1920,
    height: 1080,
    shots,
    voiceoverUrl: opts.voiceoverUrl,
    voiceoverMuted: doc.voiceover_muted === true,
    voiceoverVolumeDb,
    voiceoverFadeInMs,
    voiceoverFadeOutMs,
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
    captions: opts.captions,
    textOverlays: doc.text_overlays,
  };

  if (!opts.alignment) return config;

  // 2026-05-23 pin-duration architecture: rows the user has
  // explicitly pinned (via Set timing / drag / insert / split /
  // merge) must NOT be overwritten by alignment. Build the per-row
  // pin flag from `row.pin_duration` and pass it through.
  //
  // CRITICAL safety property: when NO row has `pin_duration: true`
  // (the pure-legacy case), call `realignVideoConfig` WITHOUT the
  // options argument at all. This guarantees a byte-identical call
  // shape to pre-pin-duration behavior — no chance any branch we
  // didn't anticipate causes a timing shift for legacy projects.
  //
  // See `_plans/2026-05-23-editor-pin-duration-architecture.md`.
  const pinnedShots = doc.rows.map((r) => r.pin_duration === true);
  if (!pinnedShots.some((p) => p)) {
    return realignVideoConfig(config, opts.alignment).config;
  }
  return realignVideoConfig(config, opts.alignment, { pinnedShots }).config;
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
export interface RealignVideoConfigOptions {
  /** Per-shot pin flag (length must match `config.shots.length`).
   *  `true` ⇒ keep the shot's cascade-derived `[startMs, durationMs]`
   *  verbatim; alignment-derived values are discarded for that row.
   *  Downstream non-pinned rows cascade-forward to avoid overlap
   *  (their START shifts to the pinned shot's end; their aligned
   *  DURATION is preserved). The shift propagates only when the
   *  next-next row's aligned start would still overlap — alignment
   *  gaps absorb the shift naturally.
   *
   *  Built by `productionDocToVideoConfig` from
   *  `row.pin_duration === true`. See
   *  `_plans/2026-05-23-editor-pin-duration-architecture.md`. */
  pinnedShots?: boolean[];
}

export function realignVideoConfig(
  config: VideoConfig,
  alignment: ForcedAlignmentResponse,
  options?: RealignVideoConfigOptions,
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

  // Build the new shots in one pass.
  //
  // Pinned shots: keep the cascade-derived `[startMs, durationMs]`
  // from the incoming config — the user's manual edit is the
  // authority.
  //
  // Non-pinned shots: use the aligned values. If the aligned start
  // overlaps the previous shot's end (common after a pinned shot
  // extends past its word boundaries), cascade-forward: shift the
  // start to the previous end, preserve the ALIGNED DURATION
  // (so the shot doesn't grow indefinitely). The next iteration's
  // overlap check may or may not need another shift — alignment
  // gaps absorb the drift, so the cumulative shift is bounded.
  //
  // 2026-05-23 pin-duration architecture. See
  // `_plans/2026-05-23-editor-pin-duration-architecture.md`.
  const frameMs = 1000 / config.fps;
  const pinnedFlags = options?.pinnedShots ?? [];
  // CRITICAL: cascade-forward only runs when the doc has at least
  // one pinned shot. For a pure-legacy project (no pins anywhere),
  // this loop must produce byte-identical output to the pre-pin
  // implementation — otherwise legacy projects could see subtle
  // timing shifts they didn't ask for. The cascade-forward shift
  // is only meaningful relative to a pinned upstream shot anyway:
  // without pins, the aligned values already encode the
  // word-derived ordering and we should trust them verbatim.
  // 2026-05-23 pin-duration architecture follow-up.
  const anyPinned = pinnedFlags.some((p) => p === true);
  let pinnedRespectedCount = 0;
  let cascadeForwardCount = 0;
  let cursor = 0;
  const newShots: VideoShot[] = [];
  for (let i = 0; i < config.shots.length; i++) {
    const shot = config.shots[i];
    const isPinned = pinnedFlags[i] === true;
    let startMs: number;
    let endMs: number;
    if (isPinned) {
      // Cascade values verbatim — user's manual edit wins.
      startMs = snapMsToFrame(shot.startMs, config.fps);
      endMs = snapMsToFrame(shot.startMs + shot.durationMs, config.fps);
      pinnedRespectedCount++;
    } else {
      const aligned = alignedRows[i];
      if (!aligned) {
        // Defensive: no aligned entry for this index. Keep the
        // incoming shot as-is and advance the cursor.
        newShots.push(shot);
        cursor = shot.startMs + shot.durationMs;
        continue;
      }
      startMs = snapMsToFrame(aligned.startMs, config.fps);
      endMs = snapMsToFrame(aligned.endMs, config.fps);
      // Cascade-forward: only fires when AT LEAST ONE shot in the
      // doc is pinned (anyPinned). For pure-legacy projects this
      // branch is unreachable and the loop falls back to identical
      // pre-pin behavior.
      if (anyPinned && startMs < cursor) {
        const shift = cursor - startMs;
        startMs = cursor;
        endMs += shift;
        cascadeForwardCount++;
      }
    }
    // Defensive: a single-frame minimum protects the render route's
    // `durationMs > 0` validator if the aligner produced a degenerate
    // [start, end] interval. One frame at 30 fps = 33.33 ms.
    const durationMs = Math.max(endMs - startMs, frameMs);
    newShots.push({ ...shot, startMs, durationMs });
    cursor = startMs + durationMs;
  }
  if (typeof console !== 'undefined' && console.info && pinnedRespectedCount > 0) {
    console.info('[render-timing] respecting pin', {
      pinnedCount: pinnedRespectedCount,
      cascadeForwardCount,
      totalShots: config.shots.length,
    });
  }

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
