import { VideoShot, VideoConfig, inferSceneType, DEFAULT_BRAND_KIT, BrandKit, VideoThumbnail, ThumbnailTransitionConfig, type PaintExplainerV1Settings, type DoodleExplainer2MotionCollageSettings } from './types';
// Re-export so callers can keep importing from `@/remotion/utils` —
// the canonical interface lives in `./types` (next to VideoConfig)
// but the constants + resolver below live here, so co-locating the
// type re-export keeps the call surface single-import for consumers.
export type { PaintExplainerV1Settings, DoodleExplainer2MotionCollageSettings };
import { stripProductionMarkers } from '@/lib/script-markers';
import {
  alignRowsToWords,
  snapMsToFrame,
  type AlignedRow,
} from '@/lib/voiceover-alignment';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';
import {
  getVariantPreservationHint,
  isShortVariantPromptEnabled,
} from '@/lib/production-doc-flags';
import { SAFE_FRAMING_EDIT_SUFFIX } from '@/lib/prompt-framing';

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

// ─── OnScreenTextBlock — multi-block per-row OST (Part B of OST plan) ────────
//
// Legacy `ProductionRow.on_screen_text` (string) renders as a single
// LowerThird per shot. Part B of
// `_plans/2026-06-02-editor-ost-styling-and-positioning.md` adds an
// array shape so users can place MULTIPLE text blocks per shot, each at
// their own position, anchor, scale, rotation, and glyph variant.
//
// PR 4 (this file) is data-only. PR 5 mounts the inspector UI; PR 6
// wires free placement (drag) + per-block rendering. Until PR 6 lands,
// the renderer continues to consume `on_screen_text` and ignores
// `on_screen_text_blocks`. The data is persisted faithfully so
// PR 5/6 light up retroactively.
//
// Why a distinct name from the existing `TextOverlay` in types.ts:
// that type is the GLOBAL doc-level text-overlay (start/end ms,
// position pinned to a preset). This one is PER-ROW and per-shot,
// drag-positionable, multi-block. Different concept, different
// lifecycle, kept under its own name to avoid silent collisions.

export const ON_SCREEN_TEXT_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;
export type OnScreenTextAnchor = (typeof ON_SCREEN_TEXT_ANCHORS)[number];

export const ON_SCREEN_TEXT_VARIANTS = ['default', 'doodle-yellow'] as const;
export type OnScreenTextVariant = (typeof ON_SCREEN_TEXT_VARIANTS)[number];

/** Hard caps used by the migrator + route validators. Defense-in-depth
 *  per Rule 13 — every numeric/bound is clamped at the boundary so a
 *  malformed PATCH never reaches state or the renderer. */
export const ON_SCREEN_TEXT_BLOCK_LIMITS = {
  maxBlocksPerShot: 16,
  maxTextChars: 1024,
  xPctMin: -50,
  xPctMax: 150,
  yPctMin: -50,
  yPctMax: 150,
  scaleMin: 0.4,
  scaleMax: 3.0,
  rotationDegMin: -45,
  rotationDegMax: 45,
} as const;

export interface OnScreenTextBlock {
  /** Stable, opaque id assigned on creation. Editors track blocks by
   *  id so a reorder / edit doesn't lose selection state. */
  id: string;
  /** Plain text. React renders via {text} so XSS is not a vector;
   *  validation only caps length. */
  text: string;
  /** Position as a percentage of the 1920×1080 canvas. 0,0 = top-left;
   *  100,100 = bottom-right. The renderer multiplies by canvas
   *  width/height. Slightly off-canvas values allowed for animation
   *  enter / exit. */
  x_pct: number;
  y_pct: number;
  /** Multiplier on the variant's default fontSize. */
  scale: number;
  /** Which point of the block sits at (x_pct, y_pct). Default 'center'. */
  anchor?: OnScreenTextAnchor;
  /** Per-block glyph variant; undefined inherits the doc's style default. */
  variant?: OnScreenTextVariant;
  /** Rotation degrees, clamped to [-45, 45]. */
  rotation_deg?: number;
}

/** Resolved overlays for rendering. Always returns an array; collapses
 *  the legacy single-text `shot.onScreenText` case into a synthetic
 *  single-element array. PR 6 swaps the current single-LowerThird mount
 *  in each scene for an iteration over this helper's output. */
export function resolveOnScreenTextBlocks(args: {
  blocks: readonly OnScreenTextBlock[] | undefined;
  legacyOnScreenText: string | undefined;
}): OnScreenTextBlock[] {
  const { blocks, legacyOnScreenText } = args;
  if (blocks && blocks.length > 0) return [...blocks];
  const trimmed = (legacyOnScreenText ?? '').trim();
  if (!trimmed) return [];
  return [
    {
      id: `legacy:${trimmed.slice(0, 24)}`,
      text: trimmed,
      x_pct: 50,
      y_pct: 88,
      scale: 1,
      anchor: 'bottom-center',
    },
  ];
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
  /** Multi-block per-row OST. Part B of
   *  `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
   *  When set + non-empty, the renderer iterates each block and
   *  composites N independently-placeable LowerThirds (PR 6); legacy
   *  `on_screen_text` is ignored. When empty / undefined, the renderer
   *  continues to use `on_screen_text` (current behaviour). The
   *  migrator caps the array at ON_SCREEN_TEXT_BLOCK_LIMITS.maxBlocksPerShot
   *  and clamps every numeric field. Persisted faithfully through
   *  ProjectPayload; no auto-migration on read. */
  on_screen_text_blocks?: OnScreenTextBlock[];
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
  /** Server-persisted URL of the row's last-generated image. Mirrors
   *  the transient `rowImages[i].imageUrl` client state — written by a
   *  useEffect every time a generation completes, read on doc load to
   *  re-hydrate `rowImages` so a refresh / link-share / new-tab visit
   *  doesn't show blank cells. The image BYTES live in R2 regardless;
   *  this field is the editor's bookmark to find them again. Sparse:
   *  rows whose image was never generated (or generated before this
   *  field was added) leave it undefined. */
  image_url?: string;
  /** Phase 2 of 2026-06-03 production-doc flow stabilization.
   *
   *  Count of image-generation attempts the auto-pipeline has made on
   *  this row. Incremented every time a generator returns an error;
   *  reset to 0 on user-driven Retry. When `attempts >= RETRY_BUDGET[last_error.class]`,
   *  the stage's `stillRemaining()` treats the row as "done" for
   *  advancement purposes (circuit breaker) and the row UI surfaces a
   *  red error chip + Retry button. Undefined ⇒ 0 (fresh row). */
  attempts?: number;
  /** Most recent generation failure on this row. Pre-PR2 rows that
   *  failed are indistinguishable from rows that never tried — they
   *  appear in the next tick's plan and retry without limit. Once
   *  this field lands, every failure path classifies the error and
   *  surfaces it to the user. Null means the row succeeded (or has
   *  never been attempted); undefined means pre-PR2 / legacy row. */
  last_error?: {
    /** Classified error category. Drives the per-class retry budget
     *  and the user-facing chip text. See `classifyImageGenError`
     *  in src/lib/auto-pipeline/image-gen-errors.ts for the regex
     *  matchers and the budgets. */
    class:
      | 'content_policy'
      | 'reference_rejected'
      | 'model_rejected'
      | 'blank_output'
      | 'timeout'
      | 'invalid_prompt'
      | 'no_refs'
      | 'source_missing'
      | 'killed'
      | 'validation_failed'
      | 'unknown';
    /** Short, sanitized message shown in the error chip. NEVER include
     *  API keys, internal paths, or customer ids — the classifier
     *  scrubs known leak patterns before storing here. */
    message: string;
    /** ISO timestamp when the failure landed. Drives the "Failed at …"
     *  text in the chip's tooltip. */
    at: string;
  } | null;
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
  /** Per-row image (still) model lock. When set, the inspector's
   *  Regenerate button sends this value as `model` to
   *  `/api/generate/production-doc/image`. Cleared (undefined) means
   *  "fall back to `ProductionDoc.image_model_default` → server-side
   *  `DEFAULT_IMAGE_MODEL`." Mirrors `broll_model_id` for the still
   *  side of the row. Values are entries of `IMAGE_MODELS` in
   *  `src/lib/image-models.ts`. */
  image_model?: string;
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
  // ─── Phase 3 (2026-05-25): variant groups for near-static animation ──
  //
  // A variant group is N consecutive rows that share a `group_id` and
  // depict the same visual composition with subtle expression / pose
  // changes (a brow shift, a mouth open, a hand raise). The row with
  // `variant_index = 0` is the BASE — its image is generated normally
  // via the t2i/i2i path. Rows with `variant_index > 0` derive their
  // image from the base via Atlas GPT Image 2 Edit at $0.011/call.
  // Each variant keeps its own timecode, duration, and narration —
  // they're ordinary rows in the timeline, just visually anchored to
  // the same composition.
  //
  // Three rules enforced in app code (not via DB constraints — the
  // doc is JSONB):
  //
  //   1. Exactly one row per group has `variant_index = 0`.
  //   2. Variants are contiguous in the row list.
  //   3. Cap of 4 rows per group (1 base + 3 edits) to bound spend.
  //
  // Absence of `group_id` ⇒ standalone row (today's behavior).
  // See `_plans/2026-05-25-near-static-variants.md`.

  /** Group id — all rows in a variant group share this UUID. When set,
   *  `variant_index` is also set. Absence = standalone row. */
  group_id?: string;

  /** 0-based index within the group. `0` = base image (generated
   *  normally). `1..3` = edited variants derived from the base. */
  variant_index?: number;

  /** Short edit instruction for this variant. Only meaningful when
   *  `variant_index > 0`. Examples: "raise the right eyebrow", "open
   *  the mouth into an O shape", "lift the waving arm a few degrees".
   *  Keep it short — Atlas Edit is best at deltas, weak at full scene
   *  re-descriptions. The dispatcher prepends the base row's
   *  `ai_image_prompt` so the model has full scene context. */
  variant_edit_prompt?: string;

  /** The SOURCE image_url captured at the moment this variant was last
   *  generated. Lets the editor detect "the source has been regenerated
   *  since this variant was made" — when the current source's image_url
   *  no longer matches this snapshot, the variant is stale and the UI
   *  shows a "regenerate?" banner. Only set on variant rows
   *  (variant_index > 0). Phase 3.7c.
   *
   *  Source semantics depend on `variant_derives_from_previous`:
   *    - false (default): source = the group's base row image
   *    - true:            source = the previous variant's image
   *  The field name kept its original spelling for back-compat. */
  variant_base_image_at_generation?: string;

  /** When true, this variant edits the previous variant's image
   *  instead of the group's base. variant_index 1 still falls back
   *  to the base (nothing earlier to chain from). Default false ⇒
   *  parallel (every variant derives from the base independently).
   *
   *  Chained variants let users build additive frame-by-frame
   *  animations — base shows the intact tent, variant 1 shows the
   *  first slash, variant 2 adds more rips, etc. Each frame builds
   *  on the last instead of being an independent alternative.
   *
   *  Compounding caveat: chained variant N inherits style drift from
   *  N-1. The MAX_VARIANTS_PER_GROUP cap (4 rows / 3 variants) bounds
   *  the maximum chain depth at 3 hops.
   *
   *  Three-tier resolution for NEW variants added via the editor:
   *    1. variant_derives_from_previous on the variant itself (if set)
   *    2. group_variant_chain_default on the BASE row (if set)
   *    3. variants_chained_by_default on the doc (if true)
   *    4. else false (parallel)
   *  Tier 1 is the per-variant override the chip toggle sets; tiers
   *  2-3 only affect what NEW variants default to. */
  variant_derives_from_previous?: boolean;

  /** Group-level default for new variants in this group. Set on the
   *  BASE row (variant_index === 0) only. New variants added via the
   *  editor inherit this when their own `variant_derives_from_previous`
   *  is unset. Undefined ⇒ fall through to the doc-level
   *  `variants_chained_by_default`. */
  group_variant_chain_default?: 'parallel' | 'chained';

  // ─── paint_explainer_v1 (2026-05-28): procedural motion ────────────
  //
  // Additive, optional, only meaningful when the doc's `style_preset`
  // is `paint_explainer_v1`. All four fields are absent on every other
  // style and on legacy docs. See
  // `_plans/2026-05-28-paint-explainer-v1-architecture.md`.

  /** Stable identifier for a recurring character. Two rows that share
   *  `character_id` reuse the same generated base image and mouth-removed
   *  variant — character persistence is what keeps the per-video cost
   *  under the $1 ceiling (§6 of the plan). Null / undefined ⇒ this row
   *  gets a fresh base, not a recurring entity. Set by the LLM during
   *  doc generation; the image-gen pipeline keys
   *  `ProductionDoc.paint_explainer_v1_character_cache` by this value. */
  character_id?: string;

  /** Renderer routing for the paint_explainer_v1 + doodle_explainer_2
   *  styles.
   *  - `'static'` (default ⇒ same as the rest of the codebase): Ken Burns
   *    or still, current behaviour.
   *  - `'motion'`: render Layer 1 procedural overlays from `motion_beats`
   *    over the base image (mouth-swap, label-pop, prop-slide, …).
   *    paint_explainer_v1 only.
   *  - `'hard_cut'`: signal that this shot enters as a snap cut from the
   *    previous, no transition.
   *  - `'motion_collage'`: render a hard-cut keyframe sequence from
   *    `motion_collage_panel_urls`. doodle_explainer_2 only — see
   *    `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`. */
  shot_kind?: 'static' | 'motion' | 'hard_cut' | 'motion_collage';

  /** Procedural motion overlays this row's `<MotionScene>` should run.
   *  Each beat's timing is relative to row start (ms); when the project
   *  has alignment JSON, the renderer may re-map `mouth_swap` and
   *  `label_pop` startMs to word/phoneme boundaries before applying.
   *  Capped server-side at 8 beats per row to bound the renderer cost
   *  (rule 13 — defense-in-depth against LLM hallucination). */
  motion_beats?: MotionBeat[];

  /** R2 URL of the Atlas-Edit-cleaned base where the character's mouth
   *  has been erased, ready for the `<MouthSwap>` overlay to composite
   *  procedural mouth states on top. Populated by the image-gen pipeline
   *  the first time a character shot is generated in this doc (NOT
   *  LLM-emitted). Shared across every row in the doc that carries the
   *  same `character_id` via
   *  `ProductionDoc.paint_explainer_v1_character_cache`. */
  mouth_removed_url?: string;

  /** Phase 3 (Scene cache) — stable slug identifying a recurring
   *  LOCATION or significant recurring OBJECT in the script (e.g.
   *  `"sodder-house"`, `"investigator-desk"`, `"family-home-exterior"`).
   *  Parallel to `character_id` but anchors the BACKGROUND / SETTING
   *  rather than the character. Rows sharing a `scene_id` reuse the
   *  same base image via Atlas Edit (keyed on
   *  `ProductionDoc.doodle_explainer_2_scene_cache`) so the location
   *  renders consistently across non-consecutive shots — fixes the
   *  "different house each shot" drift the Sodder QA flagged.
   *
   *  Precedence rule: when a row has BOTH `character_id` AND
   *  `scene_id` AND both are cached, the dispatcher hits the
   *  character path. Atlas Edit can only preserve ONE source image's
   *  content per call; character identity is the higher-stakes anchor.
   *  See _plans/2026-05-28-doodle-2-scene-cache.md. */
  scene_id?: string;

  // ─── doodle_explainer_2 motion_collage (2026-05-31) ────────────────
  //
  // Additive, optional, only meaningful when `shot_kind === 'motion_collage'`.
  // All four fields are absent on every other shot kind and on legacy
  // docs. See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.

  /** Grid layout for motion_collage shots. cols × rows = total
   *  keyframes generated in a single collage image, then sliced and
   *  played as a hard-cut sequence over the row's duration. Required
   *  when `shot_kind === 'motion_collage'`; ignored otherwise. Bound:
   *  cols × rows ≤ `MAX_COLLAGE_CELLS` (= 16) enforced in the slicer
   *  AND server-side in `generateMotionCollage` before any AI call. */
  motion_collage_grid?: { cols: number; rows: number };

  /** Per-panel prompts describing the action progression. Index 0 is
   *  top-left, subsequent indices walk row-major (left-to-right, then
   *  top-to-bottom). Length MUST equal `motion_collage_grid.cols *
   *  motion_collage_grid.rows` — server-side validation rejects
   *  mismatched rows. Each entry describes ONE keyframe of motion: the
   *  base composition / camera / character stays IDENTICAL across
   *  panels, only the moving element advances. */
  motion_collage_panel_prompts?: string[];

  /** Pipeline-populated: R2 URL of the raw N×M collage image (post-
   *  upscale). Kept for debugging and re-slice when settings change.
   *  Not consumed by the renderer — the renderer reads the per-panel
   *  URLs in `motion_collage_panel_urls`. */
  motion_collage_image_url?: string;

  /** Per-panel image transform (X / Y offset + scale) for motion-
   *  collage rows. User-asked-for 2026-06-02: "I really need to move
   *  it down" — when a particular panel's AI generation framed the
   *  subject badly (head cut off, off-center), the user can shift the
   *  IMAGE inside the panel viewport without regenerating.
   *
   *  Sparse array — index aligned with motion_collage_panel_urls.
   *  `null` entries leave the panel rendering centered + uncropped
   *  (the default). Entries are { x_pct, y_pct, scale_pct } with
   *  the same semantics as the per-shot transform fields:
   *    - x_pct/y_pct: percent translate. +Y moves the image content
   *      DOWN within the panel; -Y moves it UP. Same for x.
   *    - scale_pct: 100 = identity, 50 = half size, 200 = double.
   *  Bounds clamped at the migrator: [-100, 100] for x/y, [25, 400]
   *  for scale. */
  motion_collage_panel_transforms?: Array<{
    x_pct?: number;
    y_pct?: number;
    scale_pct?: number;
  } | null>;

  /** Pipeline-populated: R2 URLs of the sliced per-panel images, in
   *  the same index order as `motion_collage_panel_prompts`. Length
   *  equals cols × rows on success. The renderer (`<MotionCollageScene>`)
   *  reads from here. Empty / absent ⇒ pipeline hasn't run yet OR
   *  generation failed; the renderer falls back to a held single
   *  image. */
  motion_collage_panel_urls?: string[];
}

/** A single procedural motion overlay attached to a paint_explainer_v1
 *  row. The Remotion renderer maps `kind` to a component
 *  (`<MouthSwap>`, `<LabelPopOn>`, …) and the rest of the fields drive
 *  that component's animation. */
export interface MotionBeat {
  kind:
    | 'mouth_swap'      // procedural mouth states (closed/mid/open) cycled
    | 'scribble_draw'   // SVG stroke-reveal over the base image
    | 'label_pop'       // yellow comic-sans bubble label, scale-in with overshoot
    | 'prop_slide'      // transparent prop PNG slides in from offscreen
    | 'micro_wiggle'    // ambient ±1° / ±2px transform on character
    | 'real_photo_punch'; // real photo punches in inside a thin black rounded frame
  /** Milliseconds from the row's start when the beat begins. The renderer
   *  may rebase this to a word/phoneme onset when alignment JSON is
   *  available; the absolute value here is the fallback / floor. */
  startMs: number;
  durationMs: number;
  /** Anchor position on the 1920×1080 canvas. Required for `label_pop`
   *  and `prop_slide`; ignored by mouth_swap (auto-mouth) and
   *  micro_wiggle (no anchor). The anchor resolver runs at render time
   *  — see §5 of the architecture plan. */
  anchor?: MotionAnchor;
  /** Kind-specific payload. Schema is open here so future motion kinds
   *  can add fields without a migration. Validated server-side at row
   *  ingest per kind. */
  payload?: {
    text?: string;           // label_pop
    assetUrl?: string;       // prop_slide
    propPromptHint?: string; // prop_slide (used by image-gen, not renderer)
  };
}

export type MotionAnchor =
  | { kind: 'auto-mouth' }            // resolved against the character's calibrated mouth position
  | { kind: 'auto-center' }           // base-image center
  | { kind: 'auto-eyes' }             // resolved via vision-pass on the base
  | { kind: 'specific'; xPct: number; yPct: number }; // explicit %, 0–100

// ─── Phase 3 helpers ────────────────────────────────────────────────
//
// Pure functions, no IO. Use these instead of ad-hoc filter+sort calls
// at the row-level — keeps the variant-group semantics in one place
// and lets future changes (e.g. cap tweaks, ordering rules) land in
// one file.

/** Hard cap on rows per variant group — 1 base + 3 edits. Defined
 *  here so dispatcher routes, editor UI, and any new caller all
 *  enforce the same limit. */
export const MAX_VARIANTS_PER_GROUP = 4;

/** All rows in `doc` belonging to `groupId`, ordered ascending by
 *  `variant_index`. Returns an empty array when no rows match. */
export function getVariantGroup(doc: ProductionDoc, groupId: string): ProductionRow[] {
  if (!groupId) return [];
  return doc.rows
    .filter((r) => r.group_id === groupId)
    .slice()
    .sort((a, b) => (a.variant_index ?? 0) - (b.variant_index ?? 0));
}

/** The base row (`variant_index === 0`) of a group, or undefined when
 *  the group has no base. Callers that need the base specifically
 *  (the dispatcher, the "regenerate variants" UI) hit this so they
 *  don't accidentally consume a variant as the base. */
export function getBaseRow(doc: ProductionDoc, groupId: string): ProductionRow | undefined {
  if (!groupId) return undefined;
  return doc.rows.find((r) => r.group_id === groupId && (r.variant_index ?? 0) === 0);
}

/** The previous variant in a chained group — the row whose
 *  `variant_index === currentVariantIndex - 1` shares `groupId` with
 *  the caller. Returns undefined when no such row exists (the chain
 *  is broken, or the caller is variant 1 which falls back to the
 *  base). Used by both dispatchers (manual editor's
 *  `generateVariantImage` and the auto-pipeline's pipeline-side
 *  equivalent) to resolve the source image for a chained variant.
 *  Phase 1.7. */
export function getPreviousVariantRow(
  doc: ProductionDoc,
  groupId: string,
  currentVariantIndex: number,
): ProductionRow | undefined {
  if (!groupId || currentVariantIndex <= 1) return undefined;
  return doc.rows.find(
    (r) => r.group_id === groupId && (r.variant_index ?? 0) === currentVariantIndex - 1,
  );
}

/** Identity anchor appended to the composed Atlas Edit prompt when a
 *  variant edits from the PREVIOUS variant's image (chained mode).
 *  Parallel variants (V_n edits from base) don't need it — the base
 *  is the identity anchor by definition. Chained Edits compound drift
 *  ~5%/step; the anchor explicitly references the ORIGINAL base so
 *  the model preserves face/hair/clothing while allowing the
 *  pose/motion progression that's the point of chaining.
 *
 *  Wording verified against the smoke artefacts at
 *  `_plans/2026-05-28-atlas-edit-smoke/` — same identity-preservation
 *  language pattern that worked for the character_cache continuation
 *  prompt. Spec: `_plans/2026-05-28-doodle-2-chained-variants.md` (R4).
 *
 *  Exported so the auto-pipeline (`generateVariantImage` in
 *  `src/lib/auto-pipeline/production-doc-image-gen.ts`) can use the
 *  same string for behaviour parity between the manual editor and the
 *  auto-pipeline. */
export const CHAINED_VARIANT_IDENTITY_ANCHOR =
  'Keep the character\'s face, hair, clothing, and overall identity EXACTLY identical to the ORIGINAL base of this scene — only the pose, motion, or expression progresses from the previous frame.';

/** Resolve the effective chain mode for a variant row.
 *
 *  Three-tier priority (highest wins):
 *    1. The variant row's own `variant_derives_from_previous` (per-row
 *       override). When defined, it wins outright.
 *    2. The base row's `group_variant_chain_default` ('parallel' |
 *       'chained'). When set, it covers every variant in the group
 *       whose own flag is unset.
 *    3. The doc's `variants_chained_by_default` (boolean). When `true`,
 *       chained is the default; when `false` or unset, parallel.
 *
 *  Variant 1 is structurally always "parallel" for dispatch purposes
 *  (no previous variant to chain from); the resolver returns the
 *  declared mode regardless so the editor can still surface the
 *  group default on a single-variant group.
 *
 *  Phase 1.7 R5: gives the manual editor's `generateVariantImage` AND
 *  `composeVariantEditRequest` a single source of truth for chain
 *  resolution, replacing the prior code paths that only consulted
 *  tier 1. */
export function resolveVariantChainMode(
  doc: ProductionDoc,
  variantRow: ProductionRow,
  baseRow: ProductionRow | undefined,
): 'parallel' | 'chained' {
  if (typeof variantRow.variant_derives_from_previous === 'boolean') {
    return variantRow.variant_derives_from_previous ? 'chained' : 'parallel';
  }
  const groupMode = baseRow?.group_variant_chain_default;
  if (groupMode === 'chained') return 'chained';
  if (groupMode === 'parallel') return 'parallel';
  if (doc.variants_chained_by_default === true) return 'chained';
  return 'parallel';
}

/** True when `row` is part of a variant group (has both fields set).
 *  Treats malformed rows (group_id without variant_index, or vice
 *  versa) as standalone so the renderer doesn't crash on bad data. */
export function isVariantRow(row: ProductionRow): boolean {
  return typeof row.group_id === 'string' && typeof row.variant_index === 'number';
}

/** Body shape accepted by `POST /api/generate/production-doc/image/edit`
 *  for the variant-generation path. Exported so callers don't have to
 *  re-derive the field set and the route can keep evolving without
 *  callers drifting out of sync. */
export interface VariantEditRequest {
  originalImageUrl: string;
  prompt: string;
  optionId: 'gpt-image-2-atlas-edit';
  /** Optional vendor primary. When set, overrides the server-side
   *  `UserSettings.gpt_image_2_edit_primary` for this call only —
   *  lets the editor propagate the user's localStorage preference
   *  without a server round-trip. Caller reads from
   *  `getGptImage2EditPrimary()` in `src/lib/editor/settings.ts`
   *  and passes it through. Omitted ⇒ server uses the synced
   *  setting, then defaults to `'atlas'`. See
   *  _plans/2026-05-29-gpt-image-2-edit-provider-fallback.md. */
  gptImage2EditPrimary?: 'atlas' | 'kie';
}

/** Outcome of `composeVariantEditRequest` — either a ready-to-POST body
 *  for the existing edit route, or a typed failure the editor can map
 *  to a user-facing message without parsing strings. */
export type VariantEditPreparation =
  | { kind: 'ready'; request: VariantEditRequest; costUsd: 0.011; baseRowIndex: number; baseImageUrl: string }
  | { kind: 'error'; code: 'NOT_A_VARIANT' | 'BASE_NOT_FOUND' | 'BASE_NOT_GENERATED' | 'MISSING_EDIT_PROMPT'; message: string };

/** Prepare the request body for generating a variant row's image.
 *
 * The user-approved flow (2026-05-25): variants reuse the existing
 * `/api/generate/production-doc/image/edit` route with the Atlas
 * GPT Image 2 Edit option (`gpt-image-2-atlas-edit`, $0.011 / image).
 * No new backend route. The editor calls this helper to validate the
 * variant→base relationship and compose the edit prompt before POSTing.
 *
 * Prompt composition (user-locked decision): prepend the base row's
 * `ai_image_prompt` so the model has full scene context, then append
 * the variant's `variant_edit_prompt` after a clear delimiter. Risks
 * of drifting away from the base composition drop sharply with the
 * full context vs sending only the edit instruction in isolation.
 *
 * `baseImageUrl` is passed in by the caller rather than read off the
 * row because the production-doc image state lives in a sidecar map
 * (the editor's `rowImages[baseRowIndex].url`) — not directly on the
 * `ProductionRow`. The caller has it handy and knows the freshest
 * value (post-regenerate); reading off a row field would risk staleness.
 * Pass empty string when the base hasn't generated yet — the helper
 * returns the `BASE_NOT_GENERATED` error for that case.
 *
 * Returns a `{ kind: 'ready', ... }` for happy-path POSTs or a
 * `{ kind: 'error', code }` the UI can branch on:
 *
 *   NOT_A_VARIANT        — row isn't part of a variant group, or it IS
 *                          the base (variant_index === 0). Caller used
 *                          the wrong helper — use the regular image-gen
 *                          path for the base.
 *   BASE_NOT_FOUND       — row claims a group_id but no row with
 *                          variant_index === 0 exists in that group.
 *                          Data corruption — repair the doc.
 *   BASE_NOT_GENERATED   — base row exists but `baseImageUrl` is empty.
 *                          UX should be: "Generate the base image
 *                          first." Common during initial variant
 *                          authoring.
 *   MISSING_EDIT_PROMPT  — variant row has no variant_edit_prompt set.
 *                          UX should be: "Describe what changes from
 *                          the base."
 */
export function composeVariantEditRequest(
  doc: ProductionDoc,
  variantRow: ProductionRow,
  baseImageUrl: string,
  /** Optional vendor primary stamped into the request body for the
   *  GPT Image 2 edit dispatcher. Caller reads from the editor's
   *  localStorage (`getGptImage2EditPrimary()` in
   *  `src/lib/editor/settings.ts`). Omitted ⇒ server-side default
   *  applies. Server-only callers (auto-pipeline) don't go through
   *  this helper — they read user_settings directly. */
  gptImage2EditPrimary?: 'atlas' | 'kie',
): VariantEditPreparation {
  if (!isVariantRow(variantRow) || (variantRow.variant_index ?? 0) === 0) {
    return {
      kind: 'error',
      code: 'NOT_A_VARIANT',
      message: 'composeVariantEditRequest expects a variant row (variant_index > 0). Use the regular image-gen path for the base.',
    };
  }

  const groupId = variantRow.group_id!;
  const base = getBaseRow(doc, groupId);
  if (!base) {
    return {
      kind: 'error',
      code: 'BASE_NOT_FOUND',
      message: `No base row (variant_index = 0) in group ${groupId}.`,
    };
  }

  const trimmedBaseUrl = baseImageUrl.trim();
  if (!trimmedBaseUrl) {
    return {
      kind: 'error',
      code: 'BASE_NOT_GENERATED',
      message: 'Generate the base image first — variants edit it.',
    };
  }

  const editInstruction = variantRow.variant_edit_prompt?.trim();
  if (!editInstruction) {
    return {
      kind: 'error',
      code: 'MISSING_EDIT_PROMPT',
      message: 'Describe what changes from the base (e.g. "raise the right eyebrow").',
    };
  }

  // Prompt composition strategy depends on the Stage 2 flag.
  //
  // SHORT (flag on, the target end-state): just the edit instruction +
  // a style-specific preservation hint. Atlas Edit can SEE the input
  // image, so re-describing the scene pollutes signal. User
  // hand-verified this format with a 31-word Atlas Edit prompt
  // (2026-05-27) that produced perfect output.
  //
  // LONG (flag off, legacy back-compat): prepend the full base
  // ai_image_prompt before "EDIT: <delta>". Kept until the short
  // format passes validation on 10 varied edit types.
  //
  // Plan: _plans/2026-05-27-doodle-explainer-2-foundation.md (Stage 2).
  let composedPrompt: string;
  if (isShortVariantPromptEnabled()) {
    const hint = getVariantPreservationHint(doc.style_preset);
    // Strip a trailing period from the edit instruction so the joined
    // sentence reads as one continuous prompt without ".."
    const trimmedInstruction = editInstruction.replace(/\.\s*$/, '');
    composedPrompt = `${trimmedInstruction}. ${hint}`;
  } else {
    const basePrompt = (base.ai_image_prompt || '').trim();
    composedPrompt = basePrompt
      ? `${basePrompt}\n\nEDIT (apply this change to the input image, keep everything else identical): ${editInstruction}`
      : `EDIT (apply this change to the input image): ${editInstruction}`;
  }
  // Phase 1.7 R5 (chained variants) — when this variant edits from
  // the PREVIOUS variant's image (not the base), append the identity
  // anchor so Atlas Edit doesn't compound style drift across V1 → V2
  // → V3. Each Edit step adds ~5% drift; without the anchor a V3
  // chain can drift ~14% from the canonical base. The anchor
  // explicitly tells the model to preserve the ORIGINAL base's
  // character identity while letting the pose/motion progress.
  //
  // Resolves through the three-tier priority (variant own flag →
  // base's group_variant_chain_default → doc.variants_chained_by_default
  // → parallel) via `resolveVariantChainMode` so the per-group toggle
  // surfaced in the editor (R5) actually drives dispatch even when
  // the variant row itself has no override set.
  // Spec: _plans/2026-05-28-doodle-2-chained-variants.md (R4 + R5).
  const variantIdx = variantRow.variant_index ?? 0;
  const chainMode = resolveVariantChainMode(doc, variantRow, base);
  const isChainedFromPrevious = chainMode === 'chained' && variantIdx > 1;
  if (isChainedFromPrevious) {
    composedPrompt += ` ${CHAINED_VARIANT_IDENTITY_ANCHOR}`;
  }
  // 2026-05-28 framing fix: variant Edit runs at 1536×1024 → crop to
  // 1536×864, destroying 7.8% off top + bottom. Without this suffix the
  // model places character heads + text in the destroy band. Mirror of
  // the auto-pipeline's `generateVariantImage` compose; the two paths
  // must stay in sync.
  composedPrompt += SAFE_FRAMING_EDIT_SUFFIX;

  // Defensive truncation — the /api/.../edit route caps prompts to
  // its own limit; trimming here gives a clearer error than a
  // downstream 400 from the model.
  const MAX_PROMPT = 2000;
  const finalPrompt = composedPrompt.length > MAX_PROMPT
    ? composedPrompt.slice(0, MAX_PROMPT)
    : composedPrompt;

  const baseRowIndex = doc.rows.indexOf(base);
  const request: VariantEditRequest = {
    originalImageUrl: trimmedBaseUrl,
    prompt: finalPrompt,
    optionId: 'gpt-image-2-atlas-edit',
    ...(gptImage2EditPrimary ? { gptImage2EditPrimary } : {}),
  };
  return {
    kind: 'ready',
    request,
    costUsd: 0.011,
    baseRowIndex,
    baseImageUrl: trimmedBaseUrl,
  };
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
  /** Doc-level default for new variants' chain mode. When true, every
   *  new variant added via the editor starts with
   *  `variant_derives_from_previous = true` (chained to the previous
   *  variant). When false / undefined, new variants default to
   *  parallel (deriving from the group's base). Per-group default
   *  (`group_variant_chain_default` on the base row) wins over this;
   *  per-variant explicit (`variant_derives_from_previous` on the
   *  variant) wins over both. Existing variants are NOT mutated when
   *  this flag flips — only NEW variant additions inherit. */
  variants_chained_by_default?: boolean;
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
  /** PR3 of `_plans/2026-06-03-production-doc-flow-stabilization.md`.
   *
   *  Doc-level pacing profile. Drives three things at doc-generation
   *  time: per-row target word budgets, the motion_collage floor, and
   *  the variant-group floor. Surfaced in the Settings panel as a
   *  three-pill picker (Standard / Fast / Very fast).
   *
   *    - `'standard'`  — 9–13 words/row (~4–6 s shots), 30% motion
   *      collage floor, 40% variant floor. Pre-PR3 behaviour.
   *    - `'fast'`      — 6–9 words/row (~3–4 s shots), 40% motion
   *      collage floor, 50% variant floor. **New default.**
   *    - `'very_fast'` — 4–7 words/row (~2–3 s shots), 50% motion
   *      collage floor, 55% variant floor. TikTok-tier pace.
   *
   *  Legacy docs (undefined) keep their existing pacing — only NEW
   *  docs get the new fast default. The post-processor in
   *  `src/lib/auto-pipeline/post-process-pacing.ts` consumes this
   *  to enforce the opening-hook split + minimum shot duration on
   *  rows emitted by the LLM. */
  pacing_profile?: 'standard' | 'fast' | 'very_fast';
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
  /** Doc-level image (still) model. Every row's inspector Regenerate
   *  uses this as the default when the row doesn't have its own
   *  `image_model` lock. Tier priority: row > doc > server-side
   *  `DEFAULT_IMAGE_MODEL`. Stamped when the production-doc page
   *  generates the doc (mirrors the page's Image Model picker) so
   *  per-shot Regenerates inherit the user's gen-time choice.
   *  Values are entries of `IMAGE_MODELS` in
   *  `src/lib/image-models.ts`. */
  image_model_default?: string;
  /** Collage batching toggle. When `true`, the "Generate all missing
   *  stills" batch button and the fresh-doc generation flow group
   *  consecutive shots in chunks of 4 and ask the chosen image model
   *  to produce a single 2×2 collage per group. The server then
   *  upscales the collage and crops it into 4 per-shot images. Cuts
   *  generation cost ~70–75% per group at the cost of one combined
   *  prompt (each cell gets its own region prompt). Per-shot Regenerate
   *  always stays single-image regardless of this flag. Default
   *  `false`. See `_plans/2026-05-24-system-upscale-and-collage.md`. */
  collage_mode?: boolean;
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

  /** paint_explainer_v1 (2026-05-28): per-video cache of recurring-character
   *  base images, keyed by `ProductionRow.character_id`. Populated by the
   *  image-gen pipeline the first time a character is generated in this doc,
   *  then reused across every row that shares the same `character_id`.
   *
   *  This cache is what keeps the per-video cost under the $1 ceiling: a
   *  recurring mascot used in 40 of 60 shots pays for one base + one
   *  mouth-removed pair instead of 40 of each. See §6 of
   *  `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
   *
   *  Undefined on legacy docs and on docs not using paint_explainer_v1. */
  paint_explainer_v1_character_cache?: Record<string, {
    base_url: string;
    mouth_removed_url?: string;
    /** Cached vision-pass result for this base, indexed by the anchor
     *  kind. Saves the per-shot Gemini Flash call when the same character
     *  appears across many rows. Undefined until the first lookup. */
    anchors?: Partial<Record<'auto-mouth' | 'auto-center' | 'auto-eyes', { xPct: number; yPct: number }>>;
  }>;

  /** doodle_explainer_2 (2026-05-28): per-video cache of recurring-character
   *  base images, keyed by `ProductionRow.character_id`. Functionally
   *  parallel to `paint_explainer_v1_character_cache` but consumed by a
   *  different pipeline path (Atlas Edit character continuation, not
   *  motion-overlay mouth-swap).
   *
   *  Mechanism: first row with a given character_id generates fresh via
   *  Atlas i2i + the 4 style refs and writes the result here. Subsequent
   *  rows with the same character_id skip i2i and instead call Atlas Edit
   *  with the cached `base_url` as the input image — preserving character
   *  identity (face/hair/clothing) across non-consecutive scenes. Validated
   *  by the smoke test at _plans/2026-05-28-atlas-edit-smoke/.
   *
   *  Saves ~$0.029 per cache hit ($0.011 Edit vs $0.04 i2i) AND fixes the
   *  user-reported character-drift problem (same family rendering as
   *  different families across shots). See plan
   *  _plans/2026-05-28-doodle-2-character-cache.md.
   *
   *  Undefined on legacy docs and on docs not using doodle_explainer_2. */
  doodle_explainer_2_character_cache?: Record<string, {
    /** R2 / vendor CDN URL of the cached base image generated on first
     *  occurrence. Read on every subsequent occurrence of the same
     *  character_id; passed as the input image to Atlas Edit. */
    base_url: string;
    /** 0-based row index where the character first appeared. Useful for
     *  telemetry ("character X cached at row 4, reused at rows 9, 14, 18")
     *  and for invalidation logic if we ever add a "regenerate from row N"
     *  feature in the editor. */
    first_seen_row_index: number;
  }>;

  /** Phase 3 (Scene cache) — per-video cache of recurring LOCATION /
   *  SIGNIFICANT-OBJECT base images, keyed by `ProductionRow.scene_id`.
   *  Parallel to `doodle_explainer_2_character_cache` but anchors the
   *  BACKGROUND / SETTING rather than a character.
   *
   *  Mechanism mirrors the character cache: first row with a given
   *  scene_id generates fresh via Atlas i2i + the style refs and writes
   *  the result here. Subsequent rows with the same scene_id skip i2i
   *  and call Atlas Edit with the cached `base_url` as the input image
   *  + a scene-continuation prompt — preserving location identity
   *  (architecture, exterior, color palette) across non-consecutive
   *  shots. Fixes the "different house each shot" drift the Sodder QA
   *  flagged after Phase 1 + 1.5 closed the character side.
   *
   *  Precedence rule: when a row has BOTH character_id AND scene_id AND
   *  both have cache entries, the character path wins. Atlas Edit can
   *  only preserve one source image's content per call; character
   *  identity is the higher-stakes anchor.
   *
   *  Saves ~$0.029 per cache hit ($0.011 Edit vs $0.04 i2i). See plan
   *  _plans/2026-05-28-doodle-2-scene-cache.md.
   *
   *  Undefined on legacy docs and on docs not using doodle_explainer_2. */
  doodle_explainer_2_scene_cache?: Record<string, {
    base_url: string;
    first_seen_row_index: number;
  }>;

  /** Phase 2 (Character Bible) — per-doc map from `character_id`
   *  slug to a 1-2 sentence visual description of distinctive
   *  features (clothing, hair, build, accessories). LLM-emitted at
   *  doc-gen time so the dispatcher can prepend a "character bible"
   *  block to every row's prompt, giving the model consistent
   *  reference language even for characters the cache can't anchor
   *  (Atlas Edit preserves only ONE source image's content per call).
   *
   *  Together with `doodle_explainer_2_character_cache`: the cache
   *  pins the DOMINANT character's identity per row; the bible pins
   *  every OTHER recurring character's appearance through prompt
   *  augmentation. Net effect: a "George + Jennie escape" row keeps
   *  George anchored (cache) AND Jennie consistent (bible reference
   *  language) instead of fresh-drifting both.
   *
   *  Spec: _plans/2026-05-28-doodle-2-character-bible.md. */
  doodle_explainer_2_character_descriptions?: Record<string, string>;

  /** paint_explainer_v1 (2026-05-28): per-doc settings overriding the
   *  defaults. Every field optional — `resolvePaintExplainerV1Settings`
   *  fills in the canonical default for any field the user hasn't set.
   *  See §14 of the architecture plan. */
  paint_explainer_v1_settings?: PaintExplainerV1Settings;

  /** paint_explainer_v1 (2026-05-30): per-doc cache of transparent
   *  prop PNGs generated for `<PropSlideIn>` motion beats. Keyed by
   *  the LLM's `propPromptHint` so the same prop hint reused across
   *  multiple beats pays for one Atlas T2I call. The pipeline's
   *  stage handler writes here after a successful generation; the
   *  renderer reads via `productionDocToVideoConfig` → VideoConfig.
   *  Undefined on legacy / non-paint_explainer_v1 docs. */
  paint_explainer_v1_prop_cache?: Record<string, string>;

  /** doodle_explainer_2 (2026-05-31): per-doc controls for
   *  motion_collage shots. Every field optional —
   *  `resolveDoodleExplainer2MotionCollageSettings` fills in the
   *  canonical default for any field the user hasn't set. Undefined
   *  on legacy / non-doodle_explainer_2 docs. See
   *  `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`. */
  doodle_explainer_2_motion_collage_settings?: DoodleExplainer2MotionCollageSettings;
  /** Ordered audio-track segments produced by the CapCut-style
   *  timeline editor (M6 of the timeline plan). When undefined the
   *  renderer falls back to playing the source voiceover URL straight
   *  through; when present, each segment plays its slice of the
   *  source via `<Audio startFrom>` offsets.
   *
   *  Each segment is a slice of one or more source audio files —
   *  trim/split/cut on the voiceover track mutates `durationMs` /
   *  splits a segment in two / removes an entry, exactly mirroring
   *  the row-track operations. v1 uses a single `sourceUrl` shared
   *  by every segment (the doc's narration); a future M7 could add
   *  multi-source music tracks.
   *
   *  See _plans/2026-06-05-capcut-timeline-editor.md (M6). */
  voiceover_segments?: VoiceoverSegment[];
}

/** One slice of the audio timeline. Cumulative position is derived
 *  from preceding segments' `durationMs` (same pattern the video
 *  rows use). */
export interface VoiceoverSegment {
  /** Stable id used for selection + library keying. */
  id: string;
  /** Source audio URL. v1 always matches the doc's narration URL. */
  sourceUrl: string;
  /** ms offset INTO the source audio file. Trim-from-start grows
   *  this; trim-from-end leaves it alone. */
  sourceOffsetMs: number;
  /** Playback duration in ms. Trim/split/resize on the timeline
   *  mutate this value; the renderer maps it to
   *  `durationInFrames` on a `<Sequence>`. */
  durationMs: number;
}

/** Canonical defaults applied by `resolvePaintExplainerV1Settings`.
 *  The interface lives in `./types` next to VideoConfig (to avoid a
 *  circular import); these constants stay here next to the resolver
 *  that consumes them. */
export const PAINT_EXPLAINER_V1_DEFAULTS: Required<PaintExplainerV1Settings> = {
  // Bumped from 2.75 → 2.4 in PR3 of 2026-06-03 plan. Tighter median
  // gives the LLM a higher row count for the same script duration —
  // approximately 24 rows over 60 s instead of 22. Matches the
  // genre's actual reference videos better than the old default.
  median_shot_seconds: 2.4,
  mouth_swap_fps_fallback: 8,
  use_alignment_driven_visemes: true,
  real_photo_cadence_pct: 50,
  character_persistence_enabled: true,
  label_color_hex: '#EBC347',
  draw_on_default_duration_ms: 1200,
  hard_cut_transition: 'snap',
};

/** Bounds applied by `resolvePaintExplainerV1Settings` to keep a stale
 *  / hand-edited doc value from breaking the renderer. Each entry is
 *  `[min, max]` inclusive. Values outside the bound clamp to the
 *  nearest edge; non-finite / wrong-type values fall back to the
 *  default. */
export const PAINT_EXPLAINER_V1_BOUNDS = {
  median_shot_seconds: [2.0, 5.0] as const,
  mouth_swap_fps_fallback: [6, 12] as const,
  real_photo_cadence_pct: [20, 80] as const,
  draw_on_default_duration_ms: [500, 3000] as const,
};

/** Resolve the effective paint_explainer_v1 settings for a doc:
 *  layer the stored values over the canonical defaults, clamping
 *  numeric fields into their allowed bounds. Returns a fully-populated
 *  shape so consumers (renderer, pipeline, LLM prompt builder) don't
 *  have to handle undefined on every field.
 *
 *  Pure: no IO. Safe to call from both server and renderer. */
export function resolvePaintExplainerV1Settings(
  doc: Pick<ProductionDoc, 'paint_explainer_v1_settings'> | null | undefined,
): Required<PaintExplainerV1Settings> {
  const stored = doc?.paint_explainer_v1_settings ?? {};
  return {
    median_shot_seconds: clampPaintSetting(
      stored.median_shot_seconds,
      PAINT_EXPLAINER_V1_BOUNDS.median_shot_seconds,
      PAINT_EXPLAINER_V1_DEFAULTS.median_shot_seconds,
    ),
    mouth_swap_fps_fallback: clampPaintSetting(
      stored.mouth_swap_fps_fallback,
      PAINT_EXPLAINER_V1_BOUNDS.mouth_swap_fps_fallback,
      PAINT_EXPLAINER_V1_DEFAULTS.mouth_swap_fps_fallback,
    ),
    use_alignment_driven_visemes:
      typeof stored.use_alignment_driven_visemes === 'boolean'
        ? stored.use_alignment_driven_visemes
        : PAINT_EXPLAINER_V1_DEFAULTS.use_alignment_driven_visemes,
    real_photo_cadence_pct: clampPaintSetting(
      stored.real_photo_cadence_pct,
      PAINT_EXPLAINER_V1_BOUNDS.real_photo_cadence_pct,
      PAINT_EXPLAINER_V1_DEFAULTS.real_photo_cadence_pct,
    ),
    character_persistence_enabled:
      typeof stored.character_persistence_enabled === 'boolean'
        ? stored.character_persistence_enabled
        : PAINT_EXPLAINER_V1_DEFAULTS.character_persistence_enabled,
    label_color_hex: isValidHexColor(stored.label_color_hex)
      ? stored.label_color_hex
      : PAINT_EXPLAINER_V1_DEFAULTS.label_color_hex,
    draw_on_default_duration_ms: clampPaintSetting(
      stored.draw_on_default_duration_ms,
      PAINT_EXPLAINER_V1_BOUNDS.draw_on_default_duration_ms,
      PAINT_EXPLAINER_V1_DEFAULTS.draw_on_default_duration_ms,
    ),
    hard_cut_transition:
      stored.hard_cut_transition === 'snap' || stored.hard_cut_transition === 'micro-fade'
        ? stored.hard_cut_transition
        : PAINT_EXPLAINER_V1_DEFAULTS.hard_cut_transition,
  };
}

function clampPaintSetting(
  value: number | undefined,
  bounds: readonly [number, number],
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(bounds[0], Math.min(bounds[1], value));
}

function isValidHexColor(value: string | undefined): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

// ─── doodle_explainer_2 motion-collage settings (2026-05-31) ────────
//
// Per-doc controls for the motion_collage shot kind. Mirrors the
// PAINT_EXPLAINER_V1_* defaults / bounds / resolver pattern exactly
// so the editor settings panel can compose against the same primitives.
// See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.

/** Canonical defaults applied by
 *  `resolveDoodleExplainer2MotionCollageSettings`. Numbers picked from
 *  the architecture plan's §Settings table — the floor / ceiling
 *  constants live in `DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS`. */
export const DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS: Required<DoodleExplainer2MotionCollageSettings> = {
  allow_motion_collage: true,
  max_grid_panels: 12,
  min_per_frame_ms: 200,
  max_per_frame_ms: 800,
};

/** Bounds applied by `resolveDoodleExplainer2MotionCollageSettings` to
 *  keep a stale / hand-edited doc value from breaking the pipeline.
 *  Each entry is `[min, max]` inclusive. The `max_grid_panels` upper
 *  bound is `MAX_COLLAGE_CELLS` from `src/lib/collage-slicer.ts` —
 *  the slicer enforces the same number as a defense-in-depth ceiling,
 *  so callers can rely on the floor + ceiling math holding regardless
 *  of which surface reads it. */
export const DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS = {
  max_grid_panels: [4, 16] as const,
  min_per_frame_ms: [100, 500] as const,
  max_per_frame_ms: [300, 1500] as const,
};

/** Resolve the effective doodle_explainer_2 motion-collage settings
 *  for a doc: layer the stored values over the canonical defaults,
 *  clamping numeric fields into their allowed bounds. Returns a
 *  fully-populated shape so consumers (pipeline validator, settings
 *  panel, mixing-rules cadence checker) don't have to handle
 *  undefined on every field.
 *
 *  Pure: no IO. Safe to call from both server and renderer. */
export function resolveDoodleExplainer2MotionCollageSettings(
  doc: Pick<ProductionDoc, 'doodle_explainer_2_motion_collage_settings'> | null | undefined,
): Required<DoodleExplainer2MotionCollageSettings> {
  const stored = doc?.doodle_explainer_2_motion_collage_settings ?? {};
  return {
    allow_motion_collage:
      typeof stored.allow_motion_collage === 'boolean'
        ? stored.allow_motion_collage
        : DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.allow_motion_collage,
    max_grid_panels: clampPaintSetting(
      stored.max_grid_panels,
      DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_grid_panels,
      DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.max_grid_panels,
    ),
    min_per_frame_ms: clampPaintSetting(
      stored.min_per_frame_ms,
      DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.min_per_frame_ms,
      DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.min_per_frame_ms,
    ),
    max_per_frame_ms: clampPaintSetting(
      stored.max_per_frame_ms,
      DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_per_frame_ms,
      DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.max_per_frame_ms,
    ),
  };
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
  /** PR 1 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
   *  Built-in slug the doc's `style_preset` should be treated as for
   *  style-aware routing decisions (yellow LowerThird variant, future
   *  bake→overlay auto-flip). For built-in style_presets this equals
   *  the style_preset itself; for saved-style UUIDs this is their
   *  `based_on_built_in`. The caller (EditorClient / production-doc)
   *  resolves it once via the styles fetch and passes it in — the
   *  conversion can't fetch async DB data itself.
   *
   *  When set, takes precedence over `doc.style_preset` when populating
   *  `config.styleId`. Undefined ⇒ legacy behavior (config.styleId =
   *  doc.style_preset verbatim). */
  effectiveStyleSlug?: string;
}

// ─── Render-config diagnostic summary ───────────────────────────────────────
//
// Editor preview and the server-side renderer share the same
// composition + same `productionDocToVideoConfig` builder, so any
// visual divergence (e.g. "the MP4 shows different zoom than the
// preview") has to come from the config data drifting between the
// three boundaries on its way to the renderer:
//
//   1. Client kickoff       — what the editor POSTs       (browser console)
//   2. Server receive       — what the route parses       (Vercel function logs)
//   3. Server effective     — post absolutize + realign   (Vercel function logs)
//
// All three log the SHAPE returned by this helper so a side-by-side
// diff pinpoints exactly which boundary mutated the field. Per-shot
// detail is capped at the first 5 shots (the reported bug is usually
// shot 1 and 195-shot dumps drown the console); the `counts` aggregate
// covers the rest.
export interface RenderConfigDiagnosticSummary {
  totalShots: number;
  fps: number;
  width: number;
  height: number;
  hasVoiceover: boolean;
  thumbnail: {
    present: boolean;
    width: number | null;
    height: number | null;
    imageUrlHead: string | null;
    regionCount: number;
  };
  counts: {
    bySceneType: Record<string, number>;
    withThumbnailZoomTo: number;
    withImageUrl: number;
    withVideoUrl: number;
    withSceneZoomOverride: number;
    withFreeTransformOverride: number;
    withSectionTitle: number;
    letterboxShots: number;
  };
  firstFiveShots: Array<{
    i: number;
    sceneType: string | undefined;
    thumbnailZoomTo: string | undefined;
    hasImageUrl: boolean;
    imageUrlHead: string | null;
    hasVideoUrl: boolean;
    sceneZoom: number | undefined;
    imageScalePct: number | undefined;
    imageXPct: number | undefined;
    imageYPct: number | undefined;
    imageRotationDeg: number | undefined;
    sectionTitle: string | undefined;
    sectionTitleLayout: string | undefined;
    regionZoomPaddingPct: number | undefined;
    startMs: number;
    durationMs: number;
  }>;
  /** EVERY shot (any index) that has at least one non-identity transform,
   *  scene-zoom, overlay section-title, or thumbnail-zoom assignment.
   *  Capped at 60 entries so a doc where the user globally overrode
   *  everything doesn't drown the log. When the rendered MP4 looks
   *  positioned differently than the editor preview for shot N, find
   *  shot N in this array on BOTH the client log and the server log —
   *  any field difference is the bug. */
  shotsWithOverrides: Array<{
    i: number;
    sectionTitleLayout: string | undefined;
    imageXPct: number | undefined;
    imageYPct: number | undefined;
    imageScalePct: number | undefined;
    imageRotationDeg: number | undefined;
    sceneZoom: number | undefined;
    thumbnailZoomTo: string | undefined;
    hasSectionTitle: boolean;
  }>;
  shotsWithOverridesTotal: number;
}

export function summarizeConfigForDiagnostics(
  config: VideoConfig,
): RenderConfigDiagnosticSummary {
  const bySceneType: Record<string, number> = {};
  let withThumbnailZoomTo = 0;
  let withImageUrl = 0;
  let withVideoUrl = 0;
  let withSceneZoomOverride = 0;
  let withFreeTransformOverride = 0;
  let withSectionTitle = 0;
  let letterboxShots = 0;

  const overrideEntries: RenderConfigDiagnosticSummary['shotsWithOverrides'] = [];
  let overrideTotal = 0;
  const OVERRIDE_DUMP_CAP = 60;

  for (let i = 0; i < config.shots.length; i++) {
    const s = config.shots[i];
    const t = s.sceneType ?? 'undefined';
    bySceneType[t] = (bySceneType[t] ?? 0) + 1;
    if (s.thumbnailZoomTo) withThumbnailZoomTo++;
    if (s.imageUrl) withImageUrl++;
    if (s.videoUrl) withVideoUrl++;
    const hasSceneZoomOverride =
      typeof s.sceneZoom === 'number' && s.sceneZoom !== 100;
    if (hasSceneZoomOverride) withSceneZoomOverride++;
    const freeIdentity =
      (s.imageXPct === undefined || s.imageXPct === 0) &&
      (s.imageYPct === undefined || s.imageYPct === 0) &&
      (s.imageScalePct === undefined || s.imageScalePct === 100) &&
      (s.imageRotationDeg === undefined || s.imageRotationDeg === 0);
    if (!freeIdentity) withFreeTransformOverride++;
    const hasOverlayTitle =
      Boolean(s.sectionTitle) && s.sectionTitleLayout === 'overlay';
    if (s.sectionTitle) {
      withSectionTitle++;
      if ((s.sectionTitleLayout ?? 'letterbox') === 'letterbox') letterboxShots++;
    }
    // Collect every shot that has ANY override the editor/render math
    // can disagree on — free-transform, scene-zoom, overlay layout, or
    // thumbnail-zoom. These are the shots most likely to render
    // differently between preview and MP4, so we dump full detail.
    const isOverrideShot =
      !freeIdentity || hasSceneZoomOverride || hasOverlayTitle || Boolean(s.thumbnailZoomTo);
    if (isOverrideShot) {
      overrideTotal++;
      if (overrideEntries.length < OVERRIDE_DUMP_CAP) {
        overrideEntries.push({
          i,
          sectionTitleLayout: s.sectionTitleLayout,
          imageXPct: s.imageXPct,
          imageYPct: s.imageYPct,
          imageScalePct: s.imageScalePct,
          imageRotationDeg: s.imageRotationDeg,
          sceneZoom: s.sceneZoom,
          thumbnailZoomTo: s.thumbnailZoomTo,
          hasSectionTitle: Boolean(s.sectionTitle),
        });
      }
    }
  }

  return {
    totalShots: config.shots.length,
    fps: config.fps,
    width: config.width,
    height: config.height,
    hasVoiceover: Boolean(config.voiceoverUrl),
    thumbnail: {
      present: Boolean(config.thumbnail),
      width: config.thumbnail?.width ?? null,
      height: config.thumbnail?.height ?? null,
      imageUrlHead: config.thumbnail?.imageUrl?.slice(0, 80) ?? null,
      regionCount: config.thumbnail?.regions?.length ?? 0,
    },
    counts: {
      bySceneType,
      withThumbnailZoomTo,
      withImageUrl,
      withVideoUrl,
      withSceneZoomOverride,
      withFreeTransformOverride,
      withSectionTitle,
      letterboxShots,
    },
    firstFiveShots: config.shots.slice(0, 5).map((s, i) => ({
      i,
      sceneType: s.sceneType,
      thumbnailZoomTo: s.thumbnailZoomTo,
      hasImageUrl: Boolean(s.imageUrl),
      imageUrlHead: s.imageUrl?.slice(0, 100) ?? null,
      hasVideoUrl: Boolean(s.videoUrl),
      sceneZoom: s.sceneZoom,
      imageScalePct: s.imageScalePct,
      imageXPct: s.imageXPct,
      imageYPct: s.imageYPct,
      imageRotationDeg: s.imageRotationDeg,
      sectionTitle: s.sectionTitle,
      sectionTitleLayout: s.sectionTitleLayout,
      regionZoomPaddingPct: s.regionZoomPaddingPct,
      startMs: s.startMs,
      durationMs: s.durationMs,
    })),
    shotsWithOverrides: overrideEntries,
    shotsWithOverridesTotal: overrideTotal,
  };
}

/**
 * Resolve the canonical built-in style slug for a doc. Drives every
 * downstream feature gate that asks "what built-in is this doc?" —
 * the dispatcher's LowerThird variant, the renderer's paint_explainer_v1
 * scene routing, future style-aware components.
 *
 * Priority:
 *
 *   1. `explicitSlug` — the caller passed `opts.effectiveStyleSlug`.
 *      Always wins because the caller had the saved-style→built-in
 *      registry available; we trust their resolution.
 *
 *   2. **Signal sniffing** — when `explicitSlug` is undefined, examine
 *      fields that ONLY exist on a specific built-in:
 *        - `paint_explainer_v1_settings` / `paint_explainer_v1_character_cache`
 *          / `paint_explainer_v1_prop_cache` → `'paint_explainer_v1'`.
 *        - `doodle_explainer_2_character_cache` /
 *          `doodle_explainer_2_scene_cache` → `'doodle_explainer_2'`.
 *      This is the load-bearing defense against the "user has a saved
 *      style derived from paint_explainer_v1, doc.style_preset is the
 *      UUID, dispatcher falls back to dark LowerThird" failure mode.
 *
 *   3. `doc.style_preset` — the raw value. May be a built-in slug, may
 *      be a saved-style UUID. If a UUID lands here, downstream feature
 *      gates that check `=== 'paint_explainer_v1'` won't match — but
 *      that's only reachable when the doc has no style-specific signals
 *      at all (e.g. legacy doc, never edited under a style-specific
 *      flow). Preserves back-compat.
 *
 * Pure helper, exported for unit testing.
 */
export function resolveEffectiveStyleSlug(
  doc: ProductionDoc,
  explicitSlug?: string,
): string | undefined {
  if (explicitSlug) return explicitSlug;

  // paint_explainer_v1 signals. ANY of these means the doc was
  // edited / generated under that style — even if `style_preset` is
  // a saved-style UUID derived from it.
  if (
    doc.paint_explainer_v1_settings ||
    (doc as { paint_explainer_v1_character_cache?: unknown }).paint_explainer_v1_character_cache ||
    doc.paint_explainer_v1_prop_cache
  ) {
    return 'paint_explainer_v1';
  }

  // doodle_explainer_2 signals — these caches are populated by the
  // doodle_explainer_2-specific image-gen path and only ever exist on
  // a doodle_explainer_2 doc.
  if (
    doc.doodle_explainer_2_character_cache ||
    doc.doodle_explainer_2_scene_cache
  ) {
    return 'doodle_explainer_2';
  }

  return doc.style_preset;
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
      // Editor-only fields — surfaced so the timeline / left-rail can
      // render shot-kind / base-vs-variant chips without a separate
      // doc.rows[i] lookup. Renderer ignores. (2026-06-02 user ask.)
      visualType: row.visual_type,
      groupId: row.group_id,
      variantIndex: row.variant_index,
      imageUrl,
      videoUrl,
      title: row.on_screen_text || undefined,
      onScreenText: ost.overlayText,
      // Multi-block per-row OST (PR 4 of OST plan). Pass-through; the
      // renderer ignores this until PR 6 wires the per-block composition
      // path. Clamped on write via migratePayload, so the field arrives
      // here as a well-formed array or undefined.
      onScreenTextBlocks: row.on_screen_text_blocks as VideoShot['onScreenTextBlocks'],
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
      // paint_explainer_v1 (2026-05-28). All four fields are
      // pass-through from the row; the renderer's SceneRouter inspects
      // `shotKind` to decide whether to mount `<MotionScene>`. Absent
      // ⇒ renderer behaves exactly as before. Cast `motion_beats`
      // through `unknown` because the row interface lives in
      // remotion/utils.ts (this file) and references the full
      // `MotionBeat` type, while the renderer-side VideoShot type
      // re-states a structurally-equivalent shape (no React-only
      // helpers carried through); a direct assignment confuses TS into
      // thinking the shapes diverge even though they don't.
      shotKind: row.shot_kind,
      motionBeats: row.motion_beats as VideoShot['motionBeats'],
      mouthRemovedUrl: row.mouth_removed_url,
      characterId: row.character_id,
      // Look up the cached vision-pass mouth anchor by character_id.
      // Missing cache, missing entry, missing anchors object, or
      // missing 'auto-mouth' key all leave mouthAnchor undefined —
      // the renderer falls back to MouthSwap's hardcoded centered
      // close-up default. Threaded HERE (not at render time) so the
      // composition's static config carries every value needed for
      // a frame-precise Lambda render.
      mouthAnchor: row.character_id
        ? doc.paint_explainer_v1_character_cache?.[row.character_id]?.anchors?.['auto-mouth']
        : undefined,
      // doodle_explainer_2 motion_collage panel URLs — populated by the
      // image-gen pipeline (`generateMotionCollage`). Undefined on
      // every other shot_kind. `<MotionCollageScene>` reads from here
      // to play the keyframes hard-cut across the row's window;
      // missing / empty array falls back to the held single-image
      // render path.
      motionCollagePanelUrls: row.motion_collage_panel_urls,
      motionCollagePanelTransforms: row.motion_collage_panel_transforms,
      // Grid layout threaded for editor thumbnails — the renderer
      // doesn't need it (every panel is hard-cut for an equal slice of
      // the window) but the editor's MotionCollageThumb uses it so
      // non-square grids (3×2 vs 2×3) display the way the user
      // configured them instead of falling back to a square-ish guess.
      // PR 1 of `_plans/2026-06-02-editor-motion-collage-support.md`.
      motionCollageGrid: row.motion_collage_grid,
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
    // Pass voiceover_segments through verbatim — YouTubeVideo.tsx
    // honours them with per-segment <Sequence><Audio startFrom>
    // when present, otherwise falls back to the single voiceoverUrl.
    voiceoverSegments: doc.voiceover_segments,
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
    // Phase 2 of _plans/2026-05-25-style-aware-overlay-text.md: forward
    // the doc's style preset so Remotion components can style-vary
    // their rendering. Undefined ⇒ all components use their defaults.
    //
    // PR 1 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`:
    // when the caller resolved a saved-style UUID to its built-in parent
    // (via `opts.effectiveStyleSlug`), prefer that slug so feature gates
    // like SceneRouter's yellow-LowerThird variant fire on saved styles
    // derived from doodle_explainer_2 / paint_explainer_v1.
    //
    // 2026-06-03 reliability fix: even when the caller forgets to pass
    // `effectiveStyleSlug` AND `doc.style_preset` is a saved-style UUID,
    // the dispatcher's `styleId === 'paint_explainer_v1'` check fails and
    // LowerThird falls back to its dark `default` variant — the user's
    // reported "rendering the dark bar instead of the yellow comic-bold
    // labels" bug. Defense-in-depth: when `effectiveStyleSlug` is
    // missing, sniff style-specific signals that only exist on a given
    // built-in (`paint_explainer_v1_settings`, the doodle character /
    // scene caches) and infer the slug from those. Falls through to the
    // raw `doc.style_preset` (possibly a UUID) only when no signal hits
    // — preserves legacy back-compat for docs that genuinely have no
    // style-specific fields populated yet.
    styleId: resolveEffectiveStyleSlug(doc, opts.effectiveStyleSlug),
    // paint_explainer_v1 (2026-05-28) — resolve the doc-level settings
    // once HERE so the renderer doesn't have to re-apply defaults on
    // every frame. Only populated when the doc actually carries
    // paint_explainer_v1 settings (or is on that style); other docs
    // get undefined and the renderer skips paint_explainer_v1 code
    // paths via existing shotKind / styleId guards.
    paintExplainerV1Settings:
      resolveEffectiveStyleSlug(doc, opts.effectiveStyleSlug) === 'paint_explainer_v1' ||
      doc.paint_explainer_v1_settings
        ? resolvePaintExplainerV1Settings(doc)
        : undefined,
    // Prop cache forwarded only when populated — the cache is the
    // result of a pipeline-time AI call, so an empty/undefined value
    // is the common "no prop_slide beats yet" case. Renderer falls
    // back to beat.payload.assetUrl when the cache is absent.
    paintExplainerV1PropCache:
      doc.paint_explainer_v1_prop_cache && Object.keys(doc.paint_explainer_v1_prop_cache).length > 0
        ? doc.paint_explainer_v1_prop_cache
        : undefined,
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
  const realigned = !pinnedShots.some((p) => p)
    ? realignVideoConfig(config, opts.alignment).config
    : realignVideoConfig(config, opts.alignment, { pinnedShots }).config;
  // paint_explainer_v1 (2026-05-28): attach per-shot word slices so
  // <MouthSwap> can build alignment-driven viseme sequences instead
  // of the constant-rate fallback. Only touches shots with
  // shotKind === 'motion'; no-op on every other style + shot kind.
  return attachPaintExplainerV1VisemeWords(realigned, opts.alignment);
}

/** Walk every paint_explainer_v1 motion shot and attach the slice of
 *  alignment words that fall within its time window. Pure function —
 *  returns a new config (shots are recreated; the rest is shared by
 *  reference). On non-paint_explainer_v1 docs (no motion shots), the
 *  returned config is reference-equal to the input.
 *
 *  Word inclusion rule: any word whose [startMs, endMs] window overlaps
 *  the shot window [shot.startMs, shot.startMs + shot.durationMs).
 *  The viseme helper (`visemeSequenceFromAlignment`) does its own
 *  clipping on words that extend past the row boundary, so a loose
 *  inclusion check here is safe and reduces edge cases.
 *
 *  Exported for unit testing. The function is the load-bearing bridge
 *  between forced-alignment data and the `<MouthSwap>` overlay; a
 *  regression on its slicing logic silently breaks every word-synced
 *  mouth-swap render. */
export function attachPaintExplainerV1VisemeWords(
  config: VideoConfig,
  alignment: ForcedAlignmentResponse,
): VideoConfig {
  // Fast-path: nothing to do if no motion shots in the config.
  const hasMotionShot = config.shots.some((s) => s.shotKind === 'motion');
  if (!hasMotionShot) return config;
  // Cheap conversion: walk the aligner's flat word array once,
  // produce a normalized millisecond shape. Subsequent per-shot
  // filtering is O(rows × words) which is fine at the doc scale
  // (few hundred words × tens of rows).
  const allWords = (alignment.words ?? [])
    .filter((w) => typeof w.start === 'number' && typeof w.end === 'number' && w.end > w.start)
    .map((w) => ({
      text: w.text,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
    }));
  if (allWords.length === 0) return config;

  const shots = config.shots.map((shot) => {
    if (shot.shotKind !== 'motion') return shot;
    const shotEndMs = shot.startMs + shot.durationMs;
    const slice = allWords.filter((w) => w.endMs > shot.startMs && w.startMs < shotEndMs);
    if (slice.length === 0) return shot;
    return { ...shot, visemeWords: slice };
  });
  return { ...config, shots };
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
