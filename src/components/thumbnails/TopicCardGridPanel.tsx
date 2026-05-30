'use client';

/**
 * Topic Card Grid format — UI component for the /thumbnails page.
 *
 * Two-step flow with mandatory user review by default, plus Pre-fill and
 * One-shot shortcut modes. See _plans/2026-05-19-thumbnail-format-topic-
 * card-grid.md for the contract this component implements.
 *
 * State A: editable card table after Step 1 (LLM card list).
 * State B: rendered image with region overlay after Step 2 (image gen).
 *
 * Parent (page.tsx) owns: title, niche, script, description, modelId,
 * referenceImageUrl, and the schedule-link saver. This component owns:
 * grid size, format mode, the card list editor, the result + regions.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { downloadHref } from '@/lib/download-file';
import type { ThumbnailRegion } from '@/remotion/types';
import {
  DEFAULT_FONT_ID,
  findFontById,
  fontBrowserUrl,
  THUMBNAIL_FONTS,
  THUMBNAIL_FONT_CATEGORIES,
  THUMBNAIL_FONT_CATEGORY_LABELS,
  type ThumbnailFont,
} from '@/lib/thumbnail-formats/topic-card-grid-fonts';

// ─── Types mirroring the API contract ───────────────────────────────────────

export interface FormatCard {
  index: number;
  label: string;
  icon_concept: string;
  accent_color?: string;
}

export interface FormatPalette {
  background: string;
  primary_accent: string;
  secondary_accent: string;
}

/** Visual shape of each card. `'square'` keeps the original layout
 *  (rectangle + label strip); `'circle'` renders each card as a disc on
 *  white with the label beneath. Mirrors the `CardShape` type in
 *  `src/lib/thumbnail-formats/topic-card-grid.ts`. */
export type CardShape = 'square' | 'circle';

export interface FormatGenerationResult {
  imageUrl: string;
  regions: ThumbnailRegion[];
  cards: FormatCard[];
  palette: FormatPalette;
  gridRows: number;
  gridCols: number;
  gridMode: 'preset' | 'custom';
  mode: 'review' | 'pre-fill' | 'one-shot';
  formatImageModel: string;
  referenceImageUrl?: string;
  outputWidth: number;
  outputHeight: number;
  /** Visual card shape used for this render. Defaults to `'square'` on
   *  history entries restored from before the shape toggle shipped. */
  cardShape?: CardShape;
  /** 1-based cell index → R2 download URL of the user-uploaded image
   *  that was composited into that cell. Empty when no cells had
   *  attached uploads. */
  uploads?: Record<number, string>;
}

/**
 * Snapshot of the panel's in-progress (pre-render) state. Saved into the
 * workflow draft so refreshing mid-edit returns the user to the editable
 * card list they were reviewing rather than starting over. The rendered
 * thumbnail itself lives in history, not the draft.
 */
export interface TopicCardGridDraftState {
  gridMode: 'preset' | 'custom';
  presetIdx: number;
  customRows: number;
  customCols: number;
  formatMode: 'review' | 'pre-fill' | 'one-shot';
  prefilledLabels: string;
  imageModelId: string;
  cards: FormatCard[] | null;
  palette: FormatPalette | null;
  notesForImageModel?: string;
  /** Visual card shape selected by the user. Defaults to `'square'` for
   *  drafts saved before the shape toggle shipped. */
  cardShape?: CardShape;
  /** 1-based cell index → R2 download URL of an uploaded image. Restored
   *  so a refresh mid-review keeps the user's attachments. */
  uploads?: Record<number, string>;
  /** 1-based cell index → per-upload fit strategy. Drafts saved before
   *  the fit picker shipped restore with this field undefined, which
   *  the panel treats as `'cover'` (the historical default). */
  uploadFit?: Record<number, PanelUploadFit>;
  /** 1-based cell index → per-upload image filter. Drafts saved before
   *  the filter picker shipped restore with this field undefined, which
   *  the panel treats as "no filter" (the historical default). */
  uploadFilter?: Record<number, PanelImageFilter>;
  /** Visual style preset the user picked. Drafts saved before the Style
   *  selector shipped restore as `'cartoon'`. */
  style?: ThumbnailStyle;
  /** Free-form style description, only used when `style === 'free-form'`.
   *  Persisted so a refresh mid-edit doesn't blow away the user's typed
   *  style sentence. */
  styleFreeForm?: string;
  /** Label-size multiplier (the slider value). Drafts saved before the
   *  slider shipped restore as 1.0. */
  labelSize?: number;
  /** Selected font id (see THUMBNAIL_FONTS). Drafts saved before the
   *  font picker shipped restore as Patrick Hand. */
  fontId?: string;
  /** Post-process effects (filter / vignette / grain). Drafts saved
   *  before the Post-process section shipped restore with this field
   *  undefined, which the panel treats as "all effects off". */
  postProcess?: PanelPostProcessState;
  /** Title-bar overlay (text + position + typography + optional shadow).
   *  Drafts saved before the Title bar section shipped restore with
   *  this field undefined, which the panel treats as "title bar off". */
  titleBar?: PanelTitleBarState;
}

/** Image-filter ids understood by the post-process pipeline. Mirrored
 *  from `ImageFilter` in `src/lib/thumbnail-formats/shared-overlay-pipeline.ts`
 *  so this client component doesn't depend on a server-only module. */
export type PanelImageFilter =
  | 'grayscale'
  | 'sepia'
  | 'high-contrast'
  | 'low-contrast'
  | 'invert';

/** Per-upload fit strategy. Mirrored from `UploadFit` in
 *  `src/lib/thumbnail-formats/topic-card-grid-composite.ts` for the
 *  same client-boundary reasons as `PanelImageFilter`. */
export type PanelUploadFit = 'cover' | 'contain' | 'fill';

/** Panel-side shape for the Post-process section's state. Granular
 *  fields (not a nested vignette / grain object) because each control
 *  binds to one field — flat state is easier to debug + survives
 *  partial JSON-restore from older drafts cleanly. The request body
 *  builder collapses this back into the server's
 *  `PostProcessConfig` shape before sending. */
export interface PanelPostProcessState {
  /** `null` means "no filter" (mapped to undefined server-side). */
  filter: PanelImageFilter | null;
  vignetteEnabled: boolean;
  /** Hex `#RRGGBB`. Validated server-side via `safeHexColor`. */
  vignetteColor: string;
  /** 0 - 1. */
  vignetteIntensity: number;
  /** 0.3 - 1. */
  vignetteRadius: number;
  grainEnabled: boolean;
  /** 0 - 1. */
  grainIntensity: number;
  /** 0.5 - 5. */
  grainSize: number;
  grainMonochrome: boolean;
}

/** Default Post-process state. Every effect off, sensible mid-values
 *  pre-filled for the controls that don't gate on an enable toggle so
 *  flipping a toggle on immediately produces a visible effect rather
 *  than landing on 0. */
const DEFAULT_POST_PROCESS_STATE: PanelPostProcessState = {
  filter: null,
  vignetteEnabled: false,
  vignetteColor: '#000000',
  vignetteIntensity: 0.4,
  vignetteRadius: 0.5,
  grainEnabled: false,
  grainIntensity: 0.3,
  grainSize: 1,
  grainMonochrome: true,
};

/** Title-bar position. Mirrored from `TitleBarPosition` in
 *  `src/lib/thumbnail-formats/shared-overlay-pipeline.ts` so this
 *  client component doesn't depend on a server-only module. */
export type PanelTitleBarPosition = 'top' | 'bottom' | 'overlay-top' | 'overlay-bottom';
export type PanelTitleAlignment = 'left' | 'center' | 'right';

/** Panel-side shape for the Title bar section's state. Flat fields
 *  (no nested shadow / typography sub-objects) for the same reasons
 *  the Post-process state is flat — granular fields are easier to
 *  bind to individual controls and survive partial JSON restore from
 *  older drafts cleanly. The wire-shape builder collapses these back
 *  into the server's `TitleBarRequestPayload`. */
export interface PanelTitleBarState {
  enabled: boolean;
  text: string;
  subtitle: string;
  position: PanelTitleBarPosition;
  /** 0.05 - 0.5 (fraction of canvas height). */
  heightFraction: number;
  align: PanelTitleAlignment;
  /** `'match-title'` means "use the title alignment". */
  subtitleAlign: PanelTitleAlignment | 'match-title';
  backgroundColor: string;
  /** 0 - 1. */
  backgroundOpacity: number;
  textColor: string;
  subtitleColor: string;
  fontId: string;
  /** Empty string means "use the title font". */
  subtitleFontId: string;
  shadowEnabled: boolean;
  /** 0 - 48 px. */
  shadowOffsetPx: number;
  /** 0 - 96 px (Sharp converts to a Gaussian sigma internally). */
  shadowBlurPx: number;
  /** 0 - 1. */
  shadowOpacity: number;
  shadowColor: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const GRID_PRESETS: { label: string; rows: number; cols: number }[] = [
  { label: '2×2', rows: 2, cols: 2 },
  { label: '2×3', rows: 2, cols: 3 },
  { label: '2×4', rows: 2, cols: 4 },
  { label: '3×3', rows: 3, cols: 3 },
  { label: '3×4', rows: 3, cols: 4 },
  { label: '4×3', rows: 4, cols: 3 },
  { label: '4×4', rows: 4, cols: 4 },
  { label: '3×6', rows: 3, cols: 6 },
  { label: '4×6', rows: 4, cols: 6 },
];

const IMAGE_MODELS = [
  { value: 'gpt-image-2-i2i', label: 'GPT Image 2 via Kie (recommended)' },
  { value: 'gpt-image-2-openai-i2i', label: 'GPT Image 2 via OpenAI (faster, emergency)' },
  { value: 'grok-imagine-i2i', label: 'Grok Imagine (image-to-image)' },
  { value: 'flux2-pro-i2i', label: 'Flux2 Pro (image-to-image)' },
  { value: 'flux2-flex-i2i', label: 'Flux2 Flex (image-to-image)' },
];

const REGION_OVERLAY_PREF_KEY = 'topic_card_grid_region_overlay';
const IMAGE_MODEL_PREF_KEY = 'topic_card_grid_default_image_model';
const CARD_SHAPE_PREF_KEY = 'topic_card_grid_default_card_shape';
const BRIGHTNESS_PREF_KEY = 'topic_card_grid_default_brightness';
const DETAIL_PREF_KEY = 'topic_card_grid_default_detail';
const STYLE_PREF_KEY = 'topic_card_grid_default_style';
const STYLE_FREE_FORM_PREF_KEY = 'topic_card_grid_default_style_free_form';
const LABEL_SIZE_PREF_KEY = 'topic_card_grid_default_label_size';
const FONT_ID_PREF_KEY = 'topic_card_grid_default_font_id';
/** Single localStorage key for the whole Post-process section. One JSON
 *  blob is cheaper to read / write than nine keys, and the panel only
 *  ever reads / writes the whole object, never individual fields. */
const POST_PROCESS_PREF_KEY = 'topic_card_grid_default_post_process';
/** Single localStorage key for the whole Title-bar section. Same shape
 *  as POST_PROCESS_PREF_KEY — one JSON blob covers eighteen fields. */
const TITLE_BAR_PREF_KEY = 'topic_card_grid_default_title_bar';

/** Default Title-bar state. Off by default. When the user flips the
 *  toggle on, sensible defaults are pre-filled so they see a working
 *  bar immediately rather than landing on an invisible 0-opacity
 *  empty rect. */
const DEFAULT_TITLE_BAR_STATE: PanelTitleBarState = {
  enabled: false,
  text: '',
  subtitle: '',
  position: 'bottom',
  heightFraction: 0.2,
  align: 'center',
  subtitleAlign: 'match-title',
  backgroundColor: '#000000',
  backgroundOpacity: 1,
  textColor: '#ffffff',
  subtitleColor: '#ffffff',
  fontId: DEFAULT_FONT_ID,
  subtitleFontId: '',
  shadowEnabled: false,
  shadowOffsetPx: 2,
  shadowBlurPx: 4,
  shadowOpacity: 0.5,
  shadowColor: '#000000',
};

/** Label-size multiplier bounds. Mirrored from
 *  `LABEL_SIZE_MIN` / `LABEL_SIZE_MAX` in
 *  `src/lib/thumbnail-formats/topic-card-grid.ts` so the slider UI
 *  doesn't need a server-only import. Server clamps to the same range. */
const LABEL_SIZE_MIN = 0.5;
const LABEL_SIZE_MAX = 1.5;
const DEFAULT_LABEL_SIZE = 1.0;
/** Slider step. Coarse enough to make small adjustments meaningful,
 *  fine enough that the user can hit any reasonable value without
 *  fighting the control. */
const LABEL_SIZE_STEP = 0.05;

/** Visual style register, mirrored from `ThumbnailStyle` in
 *  `src/lib/thumbnail-formats/topic-card-grid.ts`. Kept as a duplicate
 *  local type so this client component doesn't import server-only
 *  module surface. */
export type ThumbnailStyle =
  | 'cartoon'
  | 'photoreal'
  | 'flat-2d'
  | 'sketch'
  | 'cinematic'
  | 'free-form';

const STYLE_OPTIONS: { value: ThumbnailStyle; label: string; hint: string }[] = [
  { value: 'cartoon', label: 'Cartoon', hint: 'Bold flat illustration, sticker-like shapes. The current default look.' },
  { value: 'photoreal', label: 'Photoreal', hint: 'Real photos, real software screens, real product photos, real logos.' },
  { value: 'flat-2d', label: 'Flat 2D', hint: 'Clean vector flat illustration. Restrained palette, no gradients.' },
  { value: 'sketch', label: 'Sketch', hint: 'Hand-drawn ink line art on textured paper.' },
  { value: 'cinematic', label: 'Cinematic', hint: 'Moody, atmospheric, film-still feel. Darker palettes OK.' },
  { value: 'free-form', label: 'Free-form', hint: 'Describe the style yourself in plain English.' },
];

/** Hard cap on the free-form style description characters. Mirrors
 *  `STYLE_FREE_FORM_MAX_CHARS` on the server so the browser surfaces
 *  the limit before the round-trip. */
const STYLE_FREE_FORM_MAX_CHARS = 300;

/**
 * Style block for the icon_concept textarea on each review-card row.
 * Fixed 3-row preview with an inner scrollbar for longer text and a
 * vertical drag handle. We do NOT use `field-sizing: content` here —
 * at narrow column widths it ballooned rows to 10+ lines, which made
 * the review state unusable. The `rows={3}` JSX prop sets the visible
 * height; this style only handles the scroll + resize behaviour and
 * the disabled dim-out.
 */
function ICON_CONCEPT_TEXTAREA_STYLE(disabled: boolean): CSSProperties {
  return {
    resize: 'vertical',
    overflowY: 'auto',
    opacity: disabled ? 0.55 : undefined,
  };
}

/** Hard cap on per-cell upload size. Mirrors the presign route's cap so
 *  the browser surfaces the error before the round trip — the route is
 *  still the source of truth. */
const MAX_CELL_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Post-process filter chips. `null` value = "no filter" (renders as a
 *  selected chip when nothing else is picked). Order is chosen so the
 *  most common picks (None, Grayscale, Sepia) sit first. */
const POST_PROCESS_FILTER_OPTIONS: { value: PanelImageFilter | null; label: string }[] = [
  { value: null, label: 'None' },
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'high-contrast', label: 'High contrast' },
  { value: 'low-contrast', label: 'Low contrast' },
  { value: 'invert', label: 'Invert' },
];

/** Per-upload fit chips. Three options, same naming as Sharp's resize
 *  `fit` field — users who've seen image-software fit modes recognise
 *  the terms directly. */
const UPLOAD_FIT_OPTIONS: { value: PanelUploadFit; label: string }[] = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'fill', label: 'Fill' },
];

/** Coerce a raw localStorage JSON read back into a `PanelPostProcessState`.
 *  Defends against partial / corrupt payloads (older drafts, stale clients)
 *  by clamping every numeric field and dropping unknown filter ids — same
 *  forgiving shape the server's `parsePostProcessConfig` uses. */
function coercePostProcessState(raw: unknown): PanelPostProcessState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POST_PROCESS_STATE };
  const r = raw as Record<string, unknown>;
  const filter = r.filter;
  const filterValid = filter === 'grayscale' || filter === 'sepia'
    || filter === 'high-contrast' || filter === 'low-contrast' || filter === 'invert';
  const clamp = (n: unknown, lo: number, hi: number, fb: number): number => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return fb;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  };
  const hex = typeof r.vignetteColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.vignetteColor)
    ? r.vignetteColor
    : DEFAULT_POST_PROCESS_STATE.vignetteColor;
  return {
    filter: filterValid ? (filter as PanelImageFilter) : null,
    vignetteEnabled: r.vignetteEnabled === true,
    vignetteColor: hex,
    vignetteIntensity: clamp(r.vignetteIntensity, 0, 1, DEFAULT_POST_PROCESS_STATE.vignetteIntensity),
    vignetteRadius: clamp(r.vignetteRadius, 0.3, 1, DEFAULT_POST_PROCESS_STATE.vignetteRadius),
    grainEnabled: r.grainEnabled === true,
    grainIntensity: clamp(r.grainIntensity, 0, 1, DEFAULT_POST_PROCESS_STATE.grainIntensity),
    grainSize: clamp(r.grainSize, 0.5, 5, DEFAULT_POST_PROCESS_STATE.grainSize),
    grainMonochrome: r.grainMonochrome !== false,
  };
}

/** Build the wire-shape `postProcess` payload from the panel's state.
 *  Returns `undefined` when nothing would have a visible effect so the
 *  server can short-circuit the post-process pass entirely. Mirrors the
 *  empty-payload short-circuit in `parsePostProcessConfig`. */
function buildPostProcessRequestPayload(s: PanelPostProcessState): {
  filter?: PanelImageFilter;
  vignette?: { color: string; intensity: number; radius: number };
  grain?: { intensity: number; size: number; monochrome: boolean };
} | undefined {
  const out: {
    filter?: PanelImageFilter;
    vignette?: { color: string; intensity: number; radius: number };
    grain?: { intensity: number; size: number; monochrome: boolean };
  } = {};
  if (s.filter) out.filter = s.filter;
  if (s.vignetteEnabled && s.vignetteIntensity > 0) {
    out.vignette = { color: s.vignetteColor, intensity: s.vignetteIntensity, radius: s.vignetteRadius };
  }
  if (s.grainEnabled && s.grainIntensity > 0) {
    out.grain = { intensity: s.grainIntensity, size: s.grainSize, monochrome: s.grainMonochrome };
  }
  if (!out.filter && !out.vignette && !out.grain) return undefined;
  return out;
}

/** Title-bar position chips. Labels lean human ("Top overlay" vs the
 *  internal "overlay-top") so a lazy user doesn't need the docs to
 *  understand which option produces which look. */
const TITLE_BAR_POSITION_OPTIONS: { value: PanelTitleBarPosition; label: string }[] = [
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'overlay-top', label: 'Top overlay' },
  { value: 'overlay-bottom', label: 'Bottom overlay' },
];

const TITLE_ALIGN_OPTIONS: { value: PanelTitleAlignment; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

/** Coerce a raw localStorage JSON read into a `PanelTitleBarState`.
 *  Defends against partial / corrupt payloads by clamping every numeric
 *  field, dropping unknown position / alignment ids, and falling back
 *  invalid hex colours to documented defaults. Same forgiving shape
 *  the server's `parseTitleBarRequestPayload` uses. */
function coerceTitleBarState(raw: unknown): PanelTitleBarState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TITLE_BAR_STATE };
  const r = raw as Record<string, unknown>;
  const clamp = (n: unknown, lo: number, hi: number, fb: number): number => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return fb;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  };
  const hex = (v: unknown, fb: string): string =>
    typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fb;
  const positionValid = r.position === 'top' || r.position === 'bottom'
    || r.position === 'overlay-top' || r.position === 'overlay-bottom';
  const alignValid = (v: unknown): v is PanelTitleAlignment =>
    v === 'left' || v === 'center' || v === 'right';
  const subtitleAlignValid = r.subtitleAlign === 'match-title' || alignValid(r.subtitleAlign);
  return {
    enabled: r.enabled === true,
    text: typeof r.text === 'string' ? r.text : DEFAULT_TITLE_BAR_STATE.text,
    subtitle: typeof r.subtitle === 'string' ? r.subtitle : DEFAULT_TITLE_BAR_STATE.subtitle,
    position: positionValid ? (r.position as PanelTitleBarPosition) : DEFAULT_TITLE_BAR_STATE.position,
    heightFraction: clamp(r.heightFraction, 0.05, 0.5, DEFAULT_TITLE_BAR_STATE.heightFraction),
    align: alignValid(r.align) ? r.align : DEFAULT_TITLE_BAR_STATE.align,
    subtitleAlign: subtitleAlignValid
      ? (r.subtitleAlign as PanelTitleAlignment | 'match-title')
      : DEFAULT_TITLE_BAR_STATE.subtitleAlign,
    backgroundColor: hex(r.backgroundColor, DEFAULT_TITLE_BAR_STATE.backgroundColor),
    backgroundOpacity: clamp(r.backgroundOpacity, 0, 1, DEFAULT_TITLE_BAR_STATE.backgroundOpacity),
    textColor: hex(r.textColor, DEFAULT_TITLE_BAR_STATE.textColor),
    subtitleColor: hex(r.subtitleColor, DEFAULT_TITLE_BAR_STATE.subtitleColor),
    fontId: typeof r.fontId === 'string' && findFontById(r.fontId) ? r.fontId : DEFAULT_TITLE_BAR_STATE.fontId,
    subtitleFontId: typeof r.subtitleFontId === 'string' && (r.subtitleFontId === '' || findFontById(r.subtitleFontId))
      ? r.subtitleFontId
      : DEFAULT_TITLE_BAR_STATE.subtitleFontId,
    shadowEnabled: r.shadowEnabled === true,
    shadowOffsetPx: clamp(r.shadowOffsetPx, 0, 48, DEFAULT_TITLE_BAR_STATE.shadowOffsetPx),
    shadowBlurPx: clamp(r.shadowBlurPx, 0, 96, DEFAULT_TITLE_BAR_STATE.shadowBlurPx),
    shadowOpacity: clamp(r.shadowOpacity, 0, 1, DEFAULT_TITLE_BAR_STATE.shadowOpacity),
    shadowColor: hex(r.shadowColor, DEFAULT_TITLE_BAR_STATE.shadowColor),
  };
}

/** Wire-shape title-bar request payload. Mirrors
 *  `TitleBarRequestPayload` from `shared-overlay-pipeline.ts` minus the
 *  type-import dependency — kept local for the same client-boundary
 *  reasons as `PanelImageFilter`. */
interface TitleBarRequestPayloadShape {
  text: string;
  subtitle?: string;
  position: PanelTitleBarPosition;
  heightFraction: number;
  align: PanelTitleAlignment;
  subtitleAlign?: PanelTitleAlignment | 'match-title';
  backgroundColor: string;
  backgroundOpacity: number;
  textColor: string;
  subtitleColor?: string;
  fontId: string;
  subtitleFontId?: string;
  shadow?: { offsetPx: number; blurPx: number; opacity: number; color: string };
}

/** Build the wire-shape `titleBar` payload from the panel's state.
 *  Returns `undefined` when the bar is disabled or has no text — the
 *  server then short-circuits the overlay entirely. Subtitle-related
 *  fields only emit when subtitle text is non-empty so a stale
 *  subtitleColor / subtitleFontId from a previous edit doesn't leak
 *  into the request. */
function buildTitleBarRequestPayload(s: PanelTitleBarState): TitleBarRequestPayloadShape | undefined {
  const trimmedText = s.text.trim();
  if (!s.enabled || !trimmedText) return undefined;
  const trimmedSubtitle = s.subtitle.trim();
  const hasSubtitle = trimmedSubtitle.length > 0;
  return {
    text: trimmedText,
    subtitle: hasSubtitle ? trimmedSubtitle : undefined,
    position: s.position,
    heightFraction: s.heightFraction,
    align: s.align,
    subtitleAlign: hasSubtitle ? s.subtitleAlign : undefined,
    backgroundColor: s.backgroundColor,
    backgroundOpacity: s.backgroundOpacity,
    textColor: s.textColor,
    subtitleColor: hasSubtitle ? s.subtitleColor : undefined,
    fontId: s.fontId,
    subtitleFontId: hasSubtitle && s.subtitleFontId ? s.subtitleFontId : undefined,
    shadow: s.shadowEnabled && s.shadowOpacity > 0
      ? {
          offsetPx: s.shadowOffsetPx,
          blurPx: s.shadowBlurPx,
          opacity: s.shadowOpacity,
          color: s.shadowColor,
        }
      : undefined,
  };
}

/** Allowed MIME types for per-cell uploads. Matches the presign route's
 *  allowlist exactly. */
const ALLOWED_CELL_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  // Inputs from parent
  title: string;
  niche: string;
  script: string;
  description: string;
  modelId: string;
  referenceImageUrl: string;
  // Notifies parent when a generation completes (so parent can save to
  // history and patch the schedule-link saver).
  onResultChange: (result: FormatGenerationResult | null) => void;
  /** Hydrate State B from a history-restored result. When this prop changes
   *  to a new non-null value, the panel hydrates its internal grid + cards
   *  state and displays the restored image. Lets the parent re-open a past
   *  Topic Card Grid generation. */
  restoredResult?: FormatGenerationResult | null;
  /** Titles the user "picked" from the script textarea via the page-level
   *  selection-to-title picker. When the count matches the grid count, the
   *  next Step 1 run will use these as pre-fill labels — bypassing the
   *  LLM's free-form label generation entirely. Empty array = picker
   *  unused, normal flow. */
  pickedLabels?: string[];
  /** Called whenever the panel's serializable in-progress state changes.
   *  The page funnels this into the workflow draft so a refresh
   *  mid-review restores the editable card list. */
  onDraftStateChange?: (state: TopicCardGridDraftState) => void;
  /** One-shot hydration payload from the workflow draft. When provided,
   *  the panel restores its in-progress state from this snapshot on
   *  mount. Distinct from `restoredResult`, which restores a rendered
   *  history entry. */
  restoredDraftState?: TopicCardGridDraftState | null;
}

export function TopicCardGridPanel({
  title,
  niche,
  script,
  description,
  modelId,
  referenceImageUrl,
  onResultChange,
  restoredResult,
  pickedLabels = [],
  onDraftStateChange,
  restoredDraftState,
}: Props) {
  // Grid configuration
  const [gridMode, setGridMode] = useState<'preset' | 'custom'>('preset');
  // 3×3 default — its index shifts when GRID_PRESETS changes, so look it up
  // by value rather than hard-coding an index that's easy to break.
  const [presetIdx, setPresetIdx] = useState(
    () => GRID_PRESETS.findIndex((p) => p.rows === 3 && p.cols === 3),
  );
  const [customRows, setCustomRows] = useState(3);
  const [customCols, setCustomCols] = useState(3);

  const gridRows = gridMode === 'preset' ? GRID_PRESETS[presetIdx].rows : customRows;
  const gridCols = gridMode === 'preset' ? GRID_PRESETS[presetIdx].cols : customCols;
  const totalCards = gridRows * gridCols;

  // Format mode
  const [formatMode, setFormatMode] = useState<'review' | 'pre-fill' | 'one-shot'>('review');
  const [prefilledLabels, setPrefilledLabels] = useState('');

  // Image model — defaults to the recommended gpt-image-2-i2i, but
  // auto-remembers the user's last choice in localStorage so whatever they
  // picked last time becomes their personal default on the next page load.
  const [imageModelId, setImageModelId] = useState<string>(() => {
    if (typeof window === 'undefined') return 'gpt-image-2-i2i';
    try {
      const stored = localStorage.getItem(IMAGE_MODEL_PREF_KEY);
      if (stored && IMAGE_MODELS.some((m) => m.value === stored)) return stored;
    } catch {
      /* fall through to default */
    }
    return 'gpt-image-2-i2i';
  });
  useEffect(() => {
    try { localStorage.setItem(IMAGE_MODEL_PREF_KEY, imageModelId); } catch { /* ignore */ }
  }, [imageModelId]);

  // Card shape — defaults to 'square', remembers the user's last pick in
  // localStorage so a repeat-user lands back in their preferred mode.
  // Same pattern as the image-model preference above (see plan rule 15
  // for the rationale).
  const [cardShape, setCardShape] = useState<CardShape>(() => {
    if (typeof window === 'undefined') return 'square';
    try {
      const stored = localStorage.getItem(CARD_SHAPE_PREF_KEY);
      if (stored === 'circle' || stored === 'square') return stored;
    } catch {
      /* fall through to default */
    }
    return 'square';
  });
  useEffect(() => {
    try { localStorage.setItem(CARD_SHAPE_PREF_KEY, cardShape); } catch { /* ignore */ }
  }, [cardShape]);

  // Brightness / detail knobs. Defaults shift to bright + clean —
  // the Phase 1.7 design rebalance. Persisted to localStorage so a
  // repeat user who dialled back to moody / detailed lands back in
  // their preferred mode on the next session. New users still get
  // the bright + clean default on first load.
  const [brightness, setBrightness] = useState<'bright' | 'mixed' | 'moody'>(() => {
    if (typeof window === 'undefined') return 'bright';
    try {
      const v = localStorage.getItem(BRIGHTNESS_PREF_KEY);
      if (v === 'mixed' || v === 'moody' || v === 'bright') return v;
    } catch { /* fall through */ }
    return 'bright';
  });
  const [detailLevel, setDetailLevel] = useState<'clean' | 'detailed'>(() => {
    if (typeof window === 'undefined') return 'clean';
    try {
      const v = localStorage.getItem(DETAIL_PREF_KEY);
      if (v === 'detailed' || v === 'clean') return v;
    } catch { /* fall through */ }
    return 'clean';
  });
  useEffect(() => {
    try { localStorage.setItem(BRIGHTNESS_PREF_KEY, brightness); } catch { /* ignore */ }
  }, [brightness]);
  useEffect(() => {
    try { localStorage.setItem(DETAIL_PREF_KEY, detailLevel); } catch { /* ignore */ }
  }, [detailLevel]);

  // Style preset. Defaults to Cartoon so existing flows produce the
  // same visual on first generation. Persisted to localStorage so a
  // repeat user lands back in their preferred preset. Free-form text
  // is persisted separately — only consulted when style === 'free-form'.
  const [style, setStyle] = useState<ThumbnailStyle>(() => {
    if (typeof window === 'undefined') return 'cartoon';
    try {
      const v = localStorage.getItem(STYLE_PREF_KEY) as ThumbnailStyle | null;
      if (v && STYLE_OPTIONS.some((o) => o.value === v)) return v;
    } catch { /* fall through */ }
    return 'cartoon';
  });
  const [styleFreeForm, setStyleFreeForm] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      return localStorage.getItem(STYLE_FREE_FORM_PREF_KEY) ?? '';
    } catch { /* fall through */ }
    return '';
  });
  useEffect(() => {
    try { localStorage.setItem(STYLE_PREF_KEY, style); } catch { /* ignore */ }
  }, [style]);
  useEffect(() => {
    try { localStorage.setItem(STYLE_FREE_FORM_PREF_KEY, styleFreeForm); } catch { /* ignore */ }
  }, [styleFreeForm]);

  // Label-size multiplier. Default 1.0 matches the r2.4.1 per-cell
  // output on cleanly-detected cells, so users who don't touch the
  // slider see the same sizes they had before. Persisted to
  // localStorage so a repeat user lands back on their preferred scale.
  const [labelSize, setLabelSize] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_LABEL_SIZE;
    try {
      const raw = localStorage.getItem(LABEL_SIZE_PREF_KEY);
      if (raw === null) return DEFAULT_LABEL_SIZE;
      const v = Number.parseFloat(raw);
      if (!Number.isFinite(v)) return DEFAULT_LABEL_SIZE;
      return Math.min(LABEL_SIZE_MAX, Math.max(LABEL_SIZE_MIN, v));
    } catch { /* fall through */ }
    return DEFAULT_LABEL_SIZE;
  });
  useEffect(() => {
    try { localStorage.setItem(LABEL_SIZE_PREF_KEY, String(labelSize)); } catch { /* ignore */ }
  }, [labelSize]);

  // Font picker. Default is Patrick Hand (matches the bundled
  // reference's typography), so users who never touch the picker keep
  // their existing look. Persisted to localStorage so a repeat user
  // lands back on their preferred font.
  const [fontId, setFontId] = useState<string>(() => {
    if (typeof window === 'undefined') return DEFAULT_FONT_ID;
    try {
      const v = localStorage.getItem(FONT_ID_PREF_KEY);
      if (v && findFontById(v)) return v;
    } catch { /* fall through */ }
    return DEFAULT_FONT_ID;
  });
  useEffect(() => {
    try { localStorage.setItem(FONT_ID_PREF_KEY, fontId); } catch { /* ignore */ }
  }, [fontId]);
  const selectedFont: ThumbnailFont = findFontById(fontId) ?? findFontById(DEFAULT_FONT_ID)!;

  // Post-process knobs — filter / vignette / grain. Run server-side
  // AFTER the AI image returns, in a single Sharp composite call. Cheap
  // to tweak: each change re-runs only the post-process step, never the
  // AI call. Persisted as one JSON blob in localStorage per rule 15;
  // older drafts without the field default to all-off.
  const [postProcess, setPostProcess] = useState<PanelPostProcessState>(() => {
    if (typeof window === 'undefined') return { ...DEFAULT_POST_PROCESS_STATE };
    try {
      const raw = localStorage.getItem(POST_PROCESS_PREF_KEY);
      if (!raw) return { ...DEFAULT_POST_PROCESS_STATE };
      return coercePostProcessState(JSON.parse(raw));
    } catch {
      /* fall through */
    }
    return { ...DEFAULT_POST_PROCESS_STATE };
  });
  useEffect(() => {
    try {
      localStorage.setItem(POST_PROCESS_PREF_KEY, JSON.stringify(postProcess));
    } catch {
      /* ignore */
    }
  }, [postProcess]);
  /** Patch a subset of Post-process fields. Keeps the call sites tight
   *  (`updatePostProcess({ filter: 'sepia' })`) without spreading state
   *  by hand in every onChange. */
  function updatePostProcess(patch: Partial<PanelPostProcessState>) {
    setPostProcess((prev) => ({ ...prev, ...patch }));
  }

  // Title-bar overlay state. Same one-JSON-blob persistence shape as
  // Post-process; same `update<X>({ patch })` helper for granular
  // onChange wiring. Off by default so existing renders are unaffected
  // until the user explicitly flips the bar on.
  const [titleBar, setTitleBar] = useState<PanelTitleBarState>(() => {
    if (typeof window === 'undefined') return { ...DEFAULT_TITLE_BAR_STATE };
    try {
      const raw = localStorage.getItem(TITLE_BAR_PREF_KEY);
      if (!raw) return { ...DEFAULT_TITLE_BAR_STATE };
      return coerceTitleBarState(JSON.parse(raw));
    } catch {
      /* fall through */
    }
    return { ...DEFAULT_TITLE_BAR_STATE };
  });
  useEffect(() => {
    try {
      localStorage.setItem(TITLE_BAR_PREF_KEY, JSON.stringify(titleBar));
    } catch {
      /* ignore */
    }
  }, [titleBar]);
  function updateTitleBar(patch: Partial<PanelTitleBarState>) {
    setTitleBar((prev) => ({ ...prev, ...patch }));
  }

  // Per-cell uploads. Keyed by 1-based card index so the same number that
  // appears in the LLM's TopicCard.index is the lookup key. Values are
  // R2 download URLs returned by the presign upload route.
  const [uploads, setUploads] = useState<Record<number, string>>({});
  // Per-upload fit + filter overrides. Kept as parallel maps rather than
  // nesting under `uploads` so old drafts (uploads-as-URL-map) restore
  // cleanly without a shape migration — undefined entries fall back to
  // the documented defaults (cover, no filter). Same Record<number, ...>
  // keying so all three maps line up by cardIndex.
  const [uploadFit, setUploadFit] = useState<Record<number, PanelUploadFit>>({});
  const [uploadFilter, setUploadFilter] = useState<Record<number, PanelImageFilter>>({});
  function updateUploadFit(cardIndex: number, fit: PanelUploadFit) {
    console.info('[topic-card-grid panel upload-fit change]', {
      card_index: cardIndex,
      from: uploadFit[cardIndex] ?? 'cover',
      to: fit,
    });
    setUploadFit((prev) => ({ ...prev, [cardIndex]: fit }));
  }
  function updateUploadFilter(cardIndex: number, filter: PanelImageFilter | null) {
    console.info('[topic-card-grid panel upload-filter change]', {
      card_index: cardIndex,
      from: uploadFilter[cardIndex] ?? null,
      to: filter,
    });
    setUploadFilter((prev) => {
      const next = { ...prev };
      if (filter) next[cardIndex] = filter;
      else delete next[cardIndex];
      return next;
    });
  }
  // Card indexes currently mid-upload, used to render the spinner state
  // in the per-row upload UI. Separate from `uploads` so an in-flight
  // upload doesn't leave a stale URL in place if it fails.
  const [uploadingCells, setUploadingCells] = useState<Set<number>>(new Set());

  // Flow state
  const [busyStep, setBusyStep] = useState<'idle' | 'cards' | 'image'>('idle');
  const [cards, setCards] = useState<FormatCard[] | null>(null);
  const [palette, setPalette] = useState<FormatPalette | null>(null);
  const [notesForImageModel, setNotesForImageModel] = useState<string | undefined>();
  const [result, setResult] = useState<FormatGenerationResult | null>(null);

  // Hydrate from a history-restored result. Runs when `restoredResult`
  // changes to a new non-null value — typically the parent setting it on
  // history click. We sync grid mode, dimensions, image model, mode, cards,
  // palette, and the result itself so State B paints immediately.
  useEffect(() => {
    if (!restoredResult) return;
    setGridMode(restoredResult.gridMode);
    if (restoredResult.gridMode === 'preset') {
      const idx = GRID_PRESETS.findIndex(
        (p) => p.rows === restoredResult.gridRows && p.cols === restoredResult.gridCols,
      );
      if (idx >= 0) setPresetIdx(idx);
    } else {
      setCustomRows(restoredResult.gridRows);
      setCustomCols(restoredResult.gridCols);
    }
    setFormatMode(restoredResult.mode);
    setImageModelId(restoredResult.formatImageModel);
    setCardShape(restoredResult.cardShape ?? 'square');
    setUploads(restoredResult.uploads ?? {});
    setCards(restoredResult.cards);
    setPalette(restoredResult.palette);
    setResult(restoredResult);
  }, [restoredResult]);

  // Hydrate the in-progress (pre-render) state from the workflow draft.
  // Re-runs whenever the parent supplies a new non-null snapshot
  // reference. The parent only changes the reference on explicit
  // hydration triggers (mount, resumeDraft) — never on the panel's own
  // writeback — so this can't loop. Distinct from the `restoredResult`
  // path above: that brings back a fully-rendered history entry; this
  // restores mid-review work so a refresh doesn't blow away an edited
  // card list.
  const lastHydratedRef = useRef<TopicCardGridDraftState | null>(null);
  useEffect(() => {
    if (!restoredDraftState) return;
    if (lastHydratedRef.current === restoredDraftState) return;
    lastHydratedRef.current = restoredDraftState;
    setGridMode(restoredDraftState.gridMode);
    setPresetIdx(restoredDraftState.presetIdx);
    setCustomRows(restoredDraftState.customRows);
    setCustomCols(restoredDraftState.customCols);
    setFormatMode(restoredDraftState.formatMode);
    setPrefilledLabels(restoredDraftState.prefilledLabels);
    setImageModelId(restoredDraftState.imageModelId);
    setCardShape(restoredDraftState.cardShape ?? 'square');
    setUploads(restoredDraftState.uploads ?? {});
    setUploadFit(restoredDraftState.uploadFit ?? {});
    setUploadFilter(restoredDraftState.uploadFilter ?? {});
    setCards(restoredDraftState.cards);
    setPalette(restoredDraftState.palette);
    setNotesForImageModel(restoredDraftState.notesForImageModel);
    if (restoredDraftState.style && STYLE_OPTIONS.some((o) => o.value === restoredDraftState.style)) {
      setStyle(restoredDraftState.style);
    }
    if (typeof restoredDraftState.styleFreeForm === 'string') {
      setStyleFreeForm(restoredDraftState.styleFreeForm);
    }
    if (typeof restoredDraftState.labelSize === 'number' && Number.isFinite(restoredDraftState.labelSize)) {
      setLabelSize(Math.min(LABEL_SIZE_MAX, Math.max(LABEL_SIZE_MIN, restoredDraftState.labelSize)));
    }
    if (typeof restoredDraftState.fontId === 'string' && findFontById(restoredDraftState.fontId)) {
      setFontId(restoredDraftState.fontId);
    }
    if (restoredDraftState.postProcess) {
      // coerce so an older draft with a partial / corrupt payload
      // doesn't poison the panel state. Same path the localStorage
      // boot reads through.
      setPostProcess(coercePostProcessState(restoredDraftState.postProcess));
    }
    if (restoredDraftState.titleBar) {
      setTitleBar(coerceTitleBarState(restoredDraftState.titleBar));
    }
    console.info('[topic-card-grid panel draft] hydrated', {
      card_count: restoredDraftState.cards?.length ?? 0,
      grid_mode: restoredDraftState.gridMode,
      format_mode: restoredDraftState.formatMode,
      card_shape: restoredDraftState.cardShape ?? 'square',
      uploads_count: Object.keys(restoredDraftState.uploads ?? {}).length,
      style: restoredDraftState.style ?? 'cartoon',
    });
  }, [restoredDraftState]);

  // Report serializable in-progress state to the parent on every change
  // so the page can fold it into the workflow draft and survive a
  // refresh. The parent debounces before writing.
  useEffect(() => {
    if (!onDraftStateChange) return;
    onDraftStateChange({
      gridMode,
      presetIdx,
      customRows,
      customCols,
      formatMode,
      prefilledLabels,
      imageModelId,
      cards,
      palette,
      notesForImageModel,
      cardShape,
      uploads,
      uploadFit,
      uploadFilter,
      style,
      styleFreeForm,
      labelSize,
      fontId,
      postProcess,
      titleBar,
    });
  }, [
    gridMode, presetIdx, customRows, customCols, formatMode,
    prefilledLabels, imageModelId, cards, palette, notesForImageModel,
    cardShape, uploads, uploadFit, uploadFilter, style, styleFreeForm, labelSize, fontId,
    postProcess, titleBar,
    onDraftStateChange,
  ]);

  // Region overlay preference — persists across sessions per the plan.
  const [regionOverlayOn, setRegionOverlayOn] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(REGION_OVERLAY_PREF_KEY);
      if (stored === 'off') setRegionOverlayOn(false);
    } catch {
      /* default ON */
    }
  }, []);
  function toggleRegionOverlay() {
    const next = !regionOverlayOn;
    setRegionOverlayOn(next);
    try {
      localStorage.setItem(REGION_OVERLAY_PREF_KEY, next ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }

  // Validation
  const prefilledLabelsList = useMemo(
    () =>
      prefilledLabels
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [prefilledLabels],
  );

  // Reference image is optional — the server falls back to the bundled
  // curated default (public/thumbnail-formats/topic-card-grid-default.png)
  // when no upload is provided. If neither is available the server returns
  // a clear error; we don't pre-block the click for that case so the user
  // sees the actionable server message.
  const canGenerateCards =
    !!title.trim() &&
    !!niche.trim() &&
    gridRows >= 1 &&
    gridCols >= 1 &&
    (formatMode !== 'pre-fill' || prefilledLabelsList.length === totalCards);

  const cardListMismatch = cards && cards.length !== totalCards;
  // A card is renderable if it has a label AND either an icon_concept OR
  // an attached upload (the composite step paints the upload regardless
  // of what the icon_concept says).
  const canRenderImage =
    !!cards &&
    !cardListMismatch &&
    cards.every((c) => c.label.trim() && (c.icon_concept.trim() || !!uploads[c.index]));

  // ─── Actions ──────────────────────────────────────────────────────────────

  /**
   * Direct browser → R2 presigned-PUT upload for a per-cell image. Same
   * pattern as the page-level reference uploader (see `uploadReferenceImage`
   * in `src/app/(app)/thumbnails/page.tsx`). The presign route enforces the
   * size cap, allowed MIME types, and auth; this function mirrors those
   * checks for instant feedback before the round-trip.
   *
   * `cardIndex` is 1-based to match `TopicCard.index`. On success the
   * resulting R2 download URL is written into the `uploads` map under that
   * key. On failure the toast surfaces the specific reason and the cell
   * stays unattached.
   */
  async function uploadCellImage(cardIndex: number, file: File) {
    if (!ALLOWED_CELL_UPLOAD_TYPES.has(file.type)) {
      toast.error('Cell upload must be JPEG, PNG, WebP, or GIF.');
      return;
    }
    if (file.size > MAX_CELL_UPLOAD_BYTES) {
      toast.error('Cell upload must be under 8MB.');
      return;
    }
    console.info('[topic-card-grid panel] upload start', {
      cardIndex, sizeBytes: file.size, contentType: file.type,
    });
    setUploadingCells((prev) => {
      const next = new Set(prev);
      next.add(cardIndex);
      return next;
    });
    const startedAt = Date.now();
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const presignRes = await fetch('/api/uploads/topic-card-grid-cell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!presignRes.ok) {
        const data: { error?: string } = await presignRes.json().catch(() => ({}));
        throw new Error(data.error || `Presign failed (${presignRes.status})`);
      }
      const { uploadUrl, downloadUrl } = await presignRes.json();
      // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC - awaits and uses response
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`);
      setUploads((prev) => ({ ...prev, [cardIndex]: downloadUrl }));
      console.info('[topic-card-grid panel] upload done', {
        cardIndex, durationMs: Date.now() - startedAt,
      });
      toast.success(`Card ${cardIndex} image attached`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[topic-card-grid panel] upload error', { cardIndex, reason });
      toast.error(reason || 'Cell upload failed');
    } finally {
      setUploadingCells((prev) => {
        const next = new Set(prev);
        next.delete(cardIndex);
        return next;
      });
    }
  }

  function clearCellUpload(cardIndex: number) {
    console.info('[topic-card-grid panel] upload clear', { cardIndex });
    setUploads((prev) => {
      const next = { ...prev };
      delete next[cardIndex];
      return next;
    });
  }

  async function runStep1() {
    if (!canGenerateCards) {
      if (formatMode === 'pre-fill' && prefilledLabelsList.length !== totalCards) {
        toast.error(`Pre-fill mode needs exactly ${totalCards} labels (one per line). You have ${prefilledLabelsList.length}.`);
      } else {
        toast.error('Title and niche are required.');
      }
      return;
    }
    // Picked labels take precedence when the count matches the grid count.
    // The user is signalling "use these exact words". We route the request
    // as pre-fill with these as the canonical labels, regardless of the
    // formatMode chip the user has selected.
    const usePicked = pickedLabels.length === totalCards;
    const effectiveMode = usePicked ? 'pre-fill' : formatMode;
    const effectivePrefill = usePicked
      ? pickedLabels
      : (formatMode === 'pre-fill' ? prefilledLabelsList : undefined);

    // Drop any uploads whose cell index has fallen outside the current
    // grid (the user can shrink the grid after attaching an image). Send
    // only the still-valid set to the LLM so it doesn't get told about
    // ghost cells it isn't being asked to render.
    const liveUploadedIndexes = Object.keys(uploads)
      .map((k) => Number(k))
      .filter((i) => Number.isInteger(i) && i >= 1 && i <= totalCards)
      .sort((a, b) => a - b);
    console.info('[thumbnails format-grid cards] requesting', {
      gridRows, gridCols, modelId, mode: effectiveMode, usingPickedLabels: usePicked,
      cardShape, uploadedIndexes: liveUploadedIndexes,
    });
    setBusyStep('cards');
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/thumbnails/format/topic-card-grid/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          title: title.trim(),
          niche,
          script: script.trim() || undefined,
          description: description.trim() || undefined,
          gridRows,
          gridCols,
          mode: effectiveMode,
          prefilledLabels: effectivePrefill,
          referenceImageUrl: referenceImageUrl.trim(),
          cardShape,
          uploadedCellIndexes: liveUploadedIndexes.length > 0 ? liveUploadedIndexes : undefined,
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Card list generation failed (${res.status})`);
      }
      const data: { result: { cards: FormatCard[]; global_palette: FormatPalette; notes_for_image_model?: string } } = await res.json();
      console.info('[thumbnails format-grid cards] received', { cardsCount: data.result.cards.length });
      setCards(data.result.cards);
      setPalette(data.result.global_palette);
      setNotesForImageModel(data.result.notes_for_image_model);
      // One-shot mode: don't stop here, chain into Step 2.
      if (formatMode === 'one-shot') {
        await runStep2(data.result.cards, data.result.global_palette, data.result.notes_for_image_model);
        return;
      }
      toast.success(`Generated ${data.result.cards.length} card${data.result.cards.length === 1 ? '' : 's'} — review and edit before rendering.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Card list generation failed.');
    } finally {
      setBusyStep('idle');
    }
  }

  async function runStep2(
    cardsToUse: FormatCard[] | null = cards,
    paletteToUse: FormatPalette | null = palette,
    notesToUse: string | undefined = notesForImageModel,
  ) {
    if (!cardsToUse || !paletteToUse) {
      toast.error('Generate the card list first.');
      return;
    }
    if (cardsToUse.length !== totalCards) {
      toast.error(`Card count (${cardsToUse.length}) does not match the grid (${totalCards}). Add or remove cards before rendering.`);
      return;
    }
    // Build the uploads payload — keep only entries still inside the
    // grid. Same de-stale filter as runStep1; cells the user attached
    // before shrinking the grid get dropped here so the server never
    // sees out-of-range indexes.
    const liveUploadsPayload = Object.entries(uploads)
      .map(([k, v]) => {
        const idx = Number(k);
        return {
          cardIndex: idx,
          imageUrl: v,
          fit: uploadFit[idx],
          filter: uploadFilter[idx],
        };
      })
      .filter((u) => Number.isInteger(u.cardIndex) && u.cardIndex >= 1 && u.cardIndex <= totalCards && !!u.imageUrl)
      .sort((a, b) => a.cardIndex - b.cardIndex);
    console.info('[thumbnails format-grid image] requesting', {
      cardsCount: cardsToUse.length,
      imageModelId,
      editsApplied: 0,
      cardShape,
      uploadsCount: liveUploadsPayload.length,
    });
    setBusyStep('image');
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/thumbnails/format/topic-card-grid/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageModelId,
          cards: cardsToUse,
          globalPalette: paletteToUse,
          notesForImageModel: notesToUse,
          gridRows,
          gridCols,
          referenceImageUrl: referenceImageUrl.trim(),
          cardShape,
          uploads: liveUploadsPayload.length > 0 ? liveUploadsPayload : undefined,
          brightness,
          detail: detailLevel,
          style,
          styleFreeForm: style === 'free-form' ? styleFreeForm.trim() : undefined,
          labelSize,
          fontId,
          postProcess: buildPostProcessRequestPayload(postProcess),
          titleBar: buildTitleBarRequestPayload(titleBar),
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Image generation failed (${res.status})`);
      }
      const data: {
        imageUrl: string;
        regions: ThumbnailRegion[];
        layout: { width: number; height: number };
        uploadsApplied?: number;
      } = await res.json();
      console.info('[thumbnails format-grid image] received', {
        imageUrl: data.imageUrl,
        regionsCount: data.regions.length,
        // Critical diagnostic: how many user uploads the server actually
        // composited onto the AI base. If we sent N uploads in the request
        // (uploadsCount above) and this comes back 0 — or lower than N —
        // the user's images are NOT in the final thumbnail and we need to
        // chase the gap on the server side. Without this we'd be guessing.
        uploadsApplied: data.uploadsApplied ?? 'absent',
        uploadsSent: liveUploadsPayload.length,
      });
      if (
        liveUploadsPayload.length > 0 &&
        (data.uploadsApplied ?? 0) < liveUploadsPayload.length
      ) {
        console.warn('[thumbnails format-grid image] uploads_applied_mismatch', {
          sent: liveUploadsPayload.length,
          applied: data.uploadsApplied ?? 0,
          sentCardIndexes: liveUploadsPayload.map((u) => u.cardIndex),
        });
      }
      const generation: FormatGenerationResult = {
        imageUrl: data.imageUrl,
        regions: data.regions,
        cards: cardsToUse,
        palette: paletteToUse,
        gridRows,
        gridCols,
        gridMode,
        mode: formatMode,
        formatImageModel: imageModelId,
        referenceImageUrl: referenceImageUrl.trim() || undefined,
        outputWidth: data.layout.width,
        outputHeight: data.layout.height,
        cardShape,
        uploads: liveUploadsPayload.length > 0
          ? Object.fromEntries(liveUploadsPayload.map((u) => [u.cardIndex, u.imageUrl]))
          : undefined,
      };
      setResult(generation);
      onResultChange(generation);
      toast.success('Thumbnail generated!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Image generation failed.');
    } finally {
      setBusyStep('idle');
    }
  }

  function updateCard(idx: number, patch: Partial<FormatCard>) {
    setCards((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function deleteCard(idx: number) {
    if (gridMode !== 'custom') {
      toast.error('Cards can only be deleted in Custom grid mode. Switch to Custom to add or remove cards.');
      return;
    }
    setCards((prev) => prev?.filter((_, i) => i !== idx).map((c, i) => ({ ...c, index: i + 1 })) ?? null);
    // Uploads travel with their card. Drop the entry at the deleted
    // position (1-based = idx + 1) and shift every entry above it down
    // by one so the keys still match the post-renumber card.index values.
    setUploads((prev) => {
      const deletedCardIndex = idx + 1;
      const next: Record<number, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        const n = Number(k);
        if (n === deletedCardIndex) continue;
        next[n > deletedCardIndex ? n - 1 : n] = v;
      }
      return next;
    });
    // Shrink the grid by 1 column or row to match. Simplest: drop one cell off
    // the last row by decreasing cols if possible.
    setCustomCols((c) => Math.max(1, c - 1));
  }

  function addCard() {
    if (gridMode !== 'custom') {
      toast.error('Cards can only be added in Custom grid mode.');
      return;
    }
    setCards((prev) => {
      if (!prev) return prev;
      const next = [...prev, { index: prev.length + 1, label: 'New card', icon_concept: 'a single bold central icon on dark background' }];
      return next;
    });
    setCustomCols((c) => c + 1);
  }

  function moveCard(idx: number, dir: -1 | 1) {
    setCards((prev) => {
      if (!prev) return prev;
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next.map((c, i) => ({ ...c, index: i + 1 }));
    });
    // Uploads travel with their card — swap the entries at the same
    // 1-based positions so an uploaded image stays bound to the card the
    // user attached it to, not to a fixed cell slot.
    setUploads((prev) => {
      const j = idx + dir;
      if (j < 0) return prev;
      const aKey = idx + 1;
      const bKey = j + 1;
      if (prev[aKey] === undefined && prev[bKey] === undefined) return prev;
      const next = { ...prev };
      const tmp = next[aKey];
      if (next[bKey] !== undefined) next[aKey] = next[bKey]; else delete next[aKey];
      if (tmp !== undefined) next[bKey] = tmp; else delete next[bKey];
      return next;
    });
  }

  function clearCards() {
    if (cards && !confirm('Discard the current card list and regenerate? Per-cell uploads will be cleared too.')) return;
    setCards(null);
    setPalette(null);
    setNotesForImageModel(undefined);
    setUploads({});
    setResult(null);
    onResultChange(null);
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex gap-6" style={{ alignItems: 'flex-start' }}>
      {/* LEFT PANEL — format controls */}
      <div className="shrink-0" style={{ width: 380 }}>
        <div className="glass p-5 space-y-4" style={{ borderColor: 'rgba(236,72,153,0.15)' }}>
          {/* Grid size */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Grid size
            </label>
            <div className="flex flex-wrap gap-1.5">
              {GRID_PRESETS.map((p, i) => {
                const active = gridMode === 'preset' && presetIdx === i;
                return (
                  <button
                    key={p.label}
                    onClick={() => { setGridMode('preset'); setPresetIdx(i); }}
                    className="text-[11px] px-2.5 py-1 rounded transition-all"
                    style={{
                      background: active ? 'rgba(236,72,153,0.2)' : 'var(--bg-card)',
                      border: `1px solid ${active ? 'rgba(236,72,153,0.4)' : 'var(--border)'}`,
                      color: active ? 'var(--accent-pink)' : 'var(--text-muted)',
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
              <button
                onClick={() => setGridMode('custom')}
                className="text-[11px] px-2.5 py-1 rounded transition-all"
                style={{
                  background: gridMode === 'custom' ? 'rgba(236,72,153,0.2)' : 'var(--bg-card)',
                  border: `1px solid ${gridMode === 'custom' ? 'rgba(236,72,153,0.4)' : 'var(--border)'}`,
                  color: gridMode === 'custom' ? 'var(--accent-pink)' : 'var(--text-muted)',
                }}
              >
                Custom…
              </button>
            </div>
            {gridMode === 'custom' && (
              <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <label className="flex items-center gap-1">
                  Rows
                  <input
                    type="number"
                    min={1}
                    value={customRows}
                    onChange={(e) => setCustomRows(Math.max(1, Number(e.target.value) || 1))}
                    className="input-field w-16 text-xs"
                  />
                </label>
                <label className="flex items-center gap-1">
                  Cols
                  <input
                    type="number"
                    min={1}
                    value={customCols}
                    onChange={(e) => setCustomCols(Math.max(1, Number(e.target.value) || 1))}
                    className="input-field w-16 text-xs"
                  />
                </label>
                <span style={{ color: 'var(--text-muted)' }}>= {totalCards} cards</span>
              </div>
            )}
            {totalCards > 64 && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--accent-yellow)' }}>
                Grids above 8×8 may render inconsistently — the model has more cards to keep aligned.
              </p>
            )}
          </div>

          {/* Card shape — square (rectangle + label strip) vs. circle
              (disc on white with label beneath). The composite module
              supports both; the toggle simply forwards the choice into
              the prompts and region math. */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Card shape
            </label>
            <div className="flex gap-1.5">
              {(['square', 'circle'] as const).map((s) => {
                const active = cardShape === s;
                const labelText = s === 'square' ? 'Square' : 'Circle';
                return (
                  <button
                    key={s}
                    onClick={() => {
                      console.info('[topic-card-grid panel] shape toggle', { from: cardShape, to: s });
                      setCardShape(s);
                    }}
                    className="text-[11px] px-2.5 py-1 rounded transition-all"
                    style={{
                      background: active ? 'rgba(236,72,153,0.2)' : 'var(--bg-card)',
                      border: `1px solid ${active ? 'rgba(236,72,153,0.4)' : 'var(--border)'}`,
                      color: active ? 'var(--accent-pink)' : 'var(--text-muted)',
                    }}
                  >
                    {labelText}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {cardShape === 'square'
                ? 'Each card is a black-bordered rectangle with a white label strip.'
                : 'Each card is a disc on a white canvas, label centred beneath it.'}
            </p>
          </div>

          {/* Image model */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Image Model
            </label>
            <select
              className="input-field w-full text-sm"
              value={imageModelId}
              onChange={(e) => setImageModelId(e.target.value)}
            >
              {IMAGE_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            {imageModelId === 'gpt-image-2-openai-i2i' && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                OpenAI direct — synchronous, ~20–60s, no polling timeouts. Quality is medium (≈$0.04/image). Same GPT Image 2 model as the Kie path, different route.
              </p>
            )}
            {imageModelId !== 'gpt-image-2-i2i' && imageModelId !== 'gpt-image-2-openai-i2i' && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--accent-yellow)' }}>
                This format is calibrated for GPT Image 2. Other models will produce a different style and likely mangle the per-card typography.
              </p>
            )}
          </div>

          {/* Brightness + detail */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Brightness
            </label>
            <div className="flex gap-1.5">
              {(['bright', 'mixed', 'moody'] as const).map((v) => {
                const active = brightness === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setBrightness(v)}
                    className="px-2.5 py-1 rounded text-xs"
                    style={{
                      background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                      color: active ? '#fff' : 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {v[0].toUpperCase() + v.slice(1)}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              Bright (default) forces vibrant palettes across the whole grid. Use Moody for editorial / horror niches.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Detail
            </label>
            <div className="flex gap-1.5">
              {(['clean', 'detailed'] as const).map((v) => {
                const active = detailLevel === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setDetailLevel(v)}
                    className="px-2.5 py-1 rounded text-xs"
                    style={{
                      background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                      color: active ? '#fff' : 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {v[0].toUpperCase() + v.slice(1)}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              Clean (default) favours one iconic subject per card. Detailed allows photoreal / multi-element compositions.
            </p>
          </div>

          {/* Style preset. Cartoon stays the default so existing flows
              don't change on first generation. Photoreal sits second so
              the most common "I want something other than cartoon" pick
              is one click away. Free-form is last and reveals a text
              input for users who want to describe the style themselves. */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Style
            </label>
            <div className="flex flex-wrap gap-1.5">
              {STYLE_OPTIONS.map((opt) => {
                const active = style === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      console.info('[topic-card-grid panel style change]', {
                        from: style,
                        to: opt.value,
                        free_form_chars: opt.value === 'free-form' ? styleFreeForm.length : 0,
                      });
                      setStyle(opt.value);
                    }}
                    className="px-2.5 py-1 rounded text-xs"
                    style={{
                      background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                      color: active ? '#fff' : 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {STYLE_OPTIONS.find((o) => o.value === style)?.hint}
            </p>
            {style === 'free-form' && (
              <div className="mt-2">
                <textarea
                  className="input-field w-full text-xs"
                  rows={3}
                  maxLength={STYLE_FREE_FORM_MAX_CHARS}
                  value={styleFreeForm}
                  onChange={(e) => setStyleFreeForm(e.target.value)}
                  placeholder={'e.g. "1990s polaroid photographs, slight overexposure, scanned with dust and creases"'}
                />
                <p
                  className="text-[10px] mt-0.5"
                  style={{
                    color: styleFreeForm.trim()
                      ? 'var(--text-muted)'
                      : 'var(--accent-yellow)',
                  }}
                >
                  {styleFreeForm.length} / {STYLE_FREE_FORM_MAX_CHARS} chars
                  {!styleFreeForm.trim() && ' — empty description falls back to Cartoon.'}
                </p>
              </div>
            )}
          </div>

          {/* Font + label size — one section with the font picker on
              top, the size slider in the middle, and the live preview
              band at the bottom showing both together. @font-face for
              every bundled font is injected once so the dropdown can
              render each option's name in its own typeface AND the
              preview band can swap fonts without a flash. */}
          <div>
            <style>{THUMBNAIL_FONTS.map((f) => `@font-face { font-family: '${f.family}'; src: url('${fontBrowserUrl(f)}') format('woff2'); font-display: swap; }`).join('\n')}</style>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Font
            </label>
            <select
              className="input-field w-full text-sm"
              value={fontId}
              onChange={(e) => {
                const next = e.target.value;
                if (!findFontById(next)) return;
                console.info('[topic-card-grid panel font change]', { from: fontId, to: next });
                setFontId(next);
              }}
              style={{ fontFamily: `'${selectedFont.family}', system-ui, sans-serif` }}
            >
              {THUMBNAIL_FONT_CATEGORIES.map((cat) => (
                <optgroup key={cat} label={THUMBNAIL_FONT_CATEGORY_LABELS[cat]}>
                  {THUMBNAIL_FONTS.filter((f) => f.category === cat).map((f) => (
                    <option
                      key={f.id}
                      value={f.id}
                      style={{ fontFamily: `'${f.family}', system-ui, sans-serif` }}
                    >
                      {f.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <div className="flex items-center justify-between mt-3 mb-1.5">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Label size
              </label>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {Math.round(labelSize * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={LABEL_SIZE_MIN}
              max={LABEL_SIZE_MAX}
              step={LABEL_SIZE_STEP}
              value={labelSize}
              onChange={(e) => {
                const next = Number.parseFloat(e.target.value);
                if (!Number.isFinite(next)) return;
                console.info('[topic-card-grid panel label-size change]', { from: labelSize, to: next });
                setLabelSize(next);
              }}
              className="w-full"
              style={{ accentColor: 'var(--accent-pink)' }}
            />
            <div
              style={{
                background: 'white',
                border: '2px solid black',
                width: '100%',
                height: 56,
                marginTop: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: `'${selectedFont.family}', system-ui, sans-serif`,
                fontSize: `${Math.max(8, Math.round(56 * 0.55 * labelSize))}px`,
                lineHeight: 1,
                color: 'black',
                userSelect: 'none',
                overflow: 'hidden',
              }}
              aria-label={`Label preview in ${selectedFont.name} at ${Math.round(labelSize * 100)}%`}
            >
              Sample Label
            </div>
            <div className="flex justify-between mt-1">
              <button
                type="button"
                onClick={() => { setLabelSize(DEFAULT_LABEL_SIZE); setFontId(DEFAULT_FONT_ID); }}
                className="text-[10px] underline"
                style={{ color: 'var(--text-muted)' }}
              >
                Reset to defaults
              </button>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Same font &amp; size across all cells.
              </span>
            </div>
          </div>

          {/* Post-process — vignette, grain, and image filters that run
              AFTER the AI image returns. Cheap to tweak: no AI re-render
              required, each change re-runs only the server-side Sharp
              pipeline. Three sub-sections: Filter (chip row), Vignette
              (toggle + color/intensity/radius), Grain (toggle + intensity/
              size + monochrome). All effects default to off. */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Post-process
            </label>

            {/* Filter chip row */}
            <div className="mb-3">
              <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>
                Filter
              </p>
              <div className="flex flex-wrap gap-1.5">
                {POST_PROCESS_FILTER_OPTIONS.map((opt) => {
                  const active = postProcess.filter === opt.value;
                  return (
                    <button
                      key={opt.value ?? 'none'}
                      type="button"
                      onClick={() => {
                        console.info('[topic-card-grid panel post-process filter change]', {
                          from: postProcess.filter,
                          to: opt.value,
                        });
                        updatePostProcess({ filter: opt.value });
                      }}
                      className="px-2.5 py-1 rounded text-xs"
                      style={{
                        background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                        color: active ? '#fff' : 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Vignette */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Vignette
                </p>
                <button
                  type="button"
                  onClick={() => {
                    console.info('[topic-card-grid panel post-process vignette toggle]', {
                      from: postProcess.vignetteEnabled,
                      to: !postProcess.vignetteEnabled,
                    });
                    updatePostProcess({ vignetteEnabled: !postProcess.vignetteEnabled });
                  }}
                  className="px-2 py-0.5 rounded text-[10px]"
                  style={{
                    background: postProcess.vignetteEnabled ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                    color: postProcess.vignetteEnabled ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                  aria-pressed={postProcess.vignetteEnabled}
                >
                  {postProcess.vignetteEnabled ? 'On' : 'Off'}
                </button>
              </div>
              {postProcess.vignetteEnabled && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={postProcess.vignetteColor}
                      onChange={(e) => updatePostProcess({ vignetteColor: e.target.value })}
                      className="rounded cursor-pointer"
                      style={{ width: 32, height: 24, border: '1px solid var(--border)' }}
                      aria-label="Vignette colour"
                    />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {postProcess.vignetteColor}
                    </span>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Intensity</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {Math.round(postProcess.vignetteIntensity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={postProcess.vignetteIntensity}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        if (Number.isFinite(v)) updatePostProcess({ vignetteIntensity: v });
                      }}
                      className="w-full"
                      style={{ accentColor: 'var(--accent-pink)' }}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Radius</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {Math.round(postProcess.vignetteRadius * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.3}
                      max={1}
                      step={0.05}
                      value={postProcess.vignetteRadius}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        if (Number.isFinite(v)) updatePostProcess({ vignetteRadius: v });
                      }}
                      className="w-full"
                      style={{ accentColor: 'var(--accent-pink)' }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Grain */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Grain
                </p>
                <button
                  type="button"
                  onClick={() => {
                    console.info('[topic-card-grid panel post-process grain toggle]', {
                      from: postProcess.grainEnabled,
                      to: !postProcess.grainEnabled,
                    });
                    updatePostProcess({ grainEnabled: !postProcess.grainEnabled });
                  }}
                  className="px-2 py-0.5 rounded text-[10px]"
                  style={{
                    background: postProcess.grainEnabled ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                    color: postProcess.grainEnabled ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                  aria-pressed={postProcess.grainEnabled}
                >
                  {postProcess.grainEnabled ? 'On' : 'Off'}
                </button>
              </div>
              {postProcess.grainEnabled && (
                <div className="space-y-2">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Intensity</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {Math.round(postProcess.grainIntensity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={postProcess.grainIntensity}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        if (Number.isFinite(v)) updatePostProcess({ grainIntensity: v });
                      }}
                      className="w-full"
                      style={{ accentColor: 'var(--accent-pink)' }}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Size</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {postProcess.grainSize.toFixed(1)}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.5}
                      max={5}
                      step={0.1}
                      value={postProcess.grainSize}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        if (Number.isFinite(v)) updatePostProcess({ grainSize: v });
                      }}
                      className="w-full"
                      style={{ accentColor: 'var(--accent-pink)' }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => updatePostProcess({ grainMonochrome: !postProcess.grainMonochrome })}
                    className="px-2 py-0.5 rounded text-[10px]"
                    style={{
                      background: postProcess.grainMonochrome ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                      color: postProcess.grainMonochrome ? '#fff' : 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                    }}
                    aria-pressed={postProcess.grainMonochrome}
                  >
                    {postProcess.grainMonochrome ? 'Monochrome grain' : 'Colour grain'}
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between mt-2">
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Runs after the AI image. Tweaks re-render in seconds, no new AI call.
              </p>
              <button
                type="button"
                onClick={() => setPostProcess({ ...DEFAULT_POST_PROCESS_STATE })}
                className="text-[10px] underline"
                style={{ color: 'var(--text-muted)' }}
              >
                Reset
              </button>
            </div>
          </div>

          {/* Title bar — text + position + typography overlay drawn on
              top of the composited image. Same Sharp pipeline as the
              Post-process section above, so tweaks re-render without
              an AI call. Off by default so existing renders are
              unaffected. The hasSubtitle gating below hides subtitle-
              specific controls (alignment, colour, font) until the
              user actually types a subtitle, keeping the section short
              for the common single-line case. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Title bar
              </label>
              <button
                type="button"
                onClick={() => {
                  console.info('[topic-card-grid panel title-bar toggle]', {
                    from: titleBar.enabled,
                    to: !titleBar.enabled,
                  });
                  updateTitleBar({ enabled: !titleBar.enabled });
                }}
                className="px-2 py-0.5 rounded text-[10px]"
                style={{
                  background: titleBar.enabled ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                  color: titleBar.enabled ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
                aria-pressed={titleBar.enabled}
              >
                {titleBar.enabled ? 'On' : 'Off'}
              </button>
            </div>
            {titleBar.enabled && (
              <div className="space-y-3">
                {/* Text + subtitle inputs */}
                <div>
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Text</p>
                  <input
                    type="text"
                    className="input-field w-full text-xs"
                    value={titleBar.text}
                    onChange={(e) => updateTitleBar({ text: e.target.value })}
                    placeholder="MAIN TITLE"
                    maxLength={200}
                  />
                </div>
                <div>
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Subtitle (optional)</p>
                  <input
                    type="text"
                    className="input-field w-full text-xs"
                    value={titleBar.subtitle}
                    onChange={(e) => updateTitleBar({ subtitle: e.target.value })}
                    placeholder="subtitle line"
                    maxLength={200}
                  />
                </div>

                {/* Position chips */}
                <div>
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Position</p>
                  <div className="flex flex-wrap gap-1.5">
                    {TITLE_BAR_POSITION_OPTIONS.map((opt) => {
                      const active = titleBar.position === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => updateTitleBar({ position: opt.value })}
                          className="px-2.5 py-1 rounded text-xs"
                          style={{
                            background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                            color: active ? '#fff' : 'var(--text-secondary)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Height % */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Height</p>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {Math.round(titleBar.heightFraction * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.05}
                    max={0.5}
                    step={0.01}
                    value={titleBar.heightFraction}
                    onChange={(e) => {
                      const v = Number.parseFloat(e.target.value);
                      if (Number.isFinite(v)) updateTitleBar({ heightFraction: v });
                    }}
                    className="w-full"
                    style={{ accentColor: 'var(--accent-pink)' }}
                  />
                </div>

                {/* Alignment chips */}
                <div>
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Alignment</p>
                  <div className="flex gap-1.5">
                    {TITLE_ALIGN_OPTIONS.map((opt) => {
                      const active = titleBar.align === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => updateTitleBar({ align: opt.value })}
                          className="px-2.5 py-1 rounded text-xs"
                          style={{
                            background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                            color: active ? '#fff' : 'var(--text-secondary)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Subtitle alignment — only when subtitle has content */}
                {titleBar.subtitle.trim() && (
                  <div>
                    <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Subtitle alignment</p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => updateTitleBar({ subtitleAlign: 'match-title' })}
                        className="px-2.5 py-1 rounded text-xs"
                        style={{
                          background: titleBar.subtitleAlign === 'match-title' ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                          color: titleBar.subtitleAlign === 'match-title' ? '#fff' : 'var(--text-secondary)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        Match title
                      </button>
                      {TITLE_ALIGN_OPTIONS.map((opt) => {
                        const active = titleBar.subtitleAlign === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => updateTitleBar({ subtitleAlign: opt.value })}
                            className="px-2.5 py-1 rounded text-xs"
                            style={{
                              background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                              color: active ? '#fff' : 'var(--text-secondary)',
                              border: '1px solid var(--border)',
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Colours: background + opacity, text, subtitle text */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={titleBar.backgroundColor}
                      onChange={(e) => updateTitleBar({ backgroundColor: e.target.value })}
                      className="rounded cursor-pointer"
                      style={{ width: 32, height: 24, border: '1px solid var(--border)' }}
                      aria-label="Background colour"
                    />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      Background {titleBar.backgroundColor}
                    </span>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Background opacity</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {Math.round(titleBar.backgroundOpacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={titleBar.backgroundOpacity}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        if (Number.isFinite(v)) updateTitleBar({ backgroundOpacity: v });
                      }}
                      className="w-full"
                      style={{ accentColor: 'var(--accent-pink)' }}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={titleBar.textColor}
                      onChange={(e) => updateTitleBar({ textColor: e.target.value })}
                      className="rounded cursor-pointer"
                      style={{ width: 32, height: 24, border: '1px solid var(--border)' }}
                      aria-label="Text colour"
                    />
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      Text {titleBar.textColor}
                    </span>
                  </div>
                  {titleBar.subtitle.trim() && (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={titleBar.subtitleColor}
                        onChange={(e) => updateTitleBar({ subtitleColor: e.target.value })}
                        className="rounded cursor-pointer"
                        style={{ width: 32, height: 24, border: '1px solid var(--border)' }}
                        aria-label="Subtitle colour"
                      />
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Subtitle {titleBar.subtitleColor}
                      </span>
                    </div>
                  )}
                </div>

                {/* Font picker. Reuses the same THUMBNAIL_FONTS registry
                    + @font-face declarations already injected by the
                    Font section above, so dropdown options render in
                    their own typeface without an extra style block. */}
                <div>
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Title font</p>
                  <select
                    className="input-field w-full text-sm"
                    value={titleBar.fontId}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (!findFontById(next)) return;
                      updateTitleBar({ fontId: next });
                    }}
                    style={{ fontFamily: `'${(findFontById(titleBar.fontId) ?? findFontById(DEFAULT_FONT_ID)!).family}', system-ui, sans-serif` }}
                  >
                    {THUMBNAIL_FONT_CATEGORIES.map((cat) => (
                      <optgroup key={cat} label={THUMBNAIL_FONT_CATEGORY_LABELS[cat]}>
                        {THUMBNAIL_FONTS.filter((f) => f.category === cat).map((f) => (
                          <option
                            key={f.id}
                            value={f.id}
                            style={{ fontFamily: `'${f.family}', system-ui, sans-serif` }}
                          >
                            {f.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                {/* Subtitle font — only when subtitle has content. Empty
                    string value = "match title font", same convention
                    `subtitleAlign === 'match-title'` uses. */}
                {titleBar.subtitle.trim() && (
                  <div>
                    <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Subtitle font</p>
                    <select
                      className="input-field w-full text-sm"
                      value={titleBar.subtitleFontId}
                      onChange={(e) => {
                        const next = e.target.value;
                        if (next === '' || findFontById(next)) {
                          updateTitleBar({ subtitleFontId: next });
                        }
                      }}
                      style={{
                        fontFamily: titleBar.subtitleFontId
                          ? `'${(findFontById(titleBar.subtitleFontId) ?? findFontById(DEFAULT_FONT_ID)!).family}', system-ui, sans-serif`
                          : 'system-ui, sans-serif',
                      }}
                    >
                      <option value="">Match title font</option>
                      {THUMBNAIL_FONT_CATEGORIES.map((cat) => (
                        <optgroup key={cat} label={THUMBNAIL_FONT_CATEGORY_LABELS[cat]}>
                          {THUMBNAIL_FONTS.filter((f) => f.category === cat).map((f) => (
                            <option
                              key={f.id}
                              value={f.id}
                              style={{ fontFamily: `'${f.family}', system-ui, sans-serif` }}
                            >
                              {f.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                )}

                {/* Shadow toggle + sliders. Mirrors Vignette / Grain
                    pattern — toggle on the top row, sub-controls only
                    render when the toggle is on. */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Text shadow</p>
                    <button
                      type="button"
                      onClick={() => updateTitleBar({ shadowEnabled: !titleBar.shadowEnabled })}
                      className="px-2 py-0.5 rounded text-[10px]"
                      style={{
                        background: titleBar.shadowEnabled ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                        color: titleBar.shadowEnabled ? '#fff' : 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                      }}
                      aria-pressed={titleBar.shadowEnabled}
                    >
                      {titleBar.shadowEnabled ? 'On' : 'Off'}
                    </button>
                  </div>
                  {titleBar.shadowEnabled && (
                    <div className="space-y-2">
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Offset</span>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {titleBar.shadowOffsetPx}px
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={20}
                          step={1}
                          value={titleBar.shadowOffsetPx}
                          onChange={(e) => {
                            const v = Number.parseInt(e.target.value, 10);
                            if (Number.isFinite(v)) updateTitleBar({ shadowOffsetPx: v });
                          }}
                          className="w-full"
                          style={{ accentColor: 'var(--accent-pink)' }}
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Blur</span>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {titleBar.shadowBlurPx}px
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={48}
                          step={1}
                          value={titleBar.shadowBlurPx}
                          onChange={(e) => {
                            const v = Number.parseInt(e.target.value, 10);
                            if (Number.isFinite(v)) updateTitleBar({ shadowBlurPx: v });
                          }}
                          className="w-full"
                          style={{ accentColor: 'var(--accent-pink)' }}
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Opacity</span>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {Math.round(titleBar.shadowOpacity * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={titleBar.shadowOpacity}
                          onChange={(e) => {
                            const v = Number.parseFloat(e.target.value);
                            if (Number.isFinite(v)) updateTitleBar({ shadowOpacity: v });
                          }}
                          className="w-full"
                          style={{ accentColor: 'var(--accent-pink)' }}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={titleBar.shadowColor}
                          onChange={(e) => updateTitleBar({ shadowColor: e.target.value })}
                          className="rounded cursor-pointer"
                          style={{ width: 32, height: 24, border: '1px solid var(--border)' }}
                          aria-label="Shadow colour"
                        />
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Shadow {titleBar.shadowColor}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Drawn on top after the AI image. Re-renders without a new AI call.
                  </p>
                  <button
                    type="button"
                    onClick={() => setTitleBar({ ...DEFAULT_TITLE_BAR_STATE })}
                    className="text-[10px] underline"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Reset
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Mode chips */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Flow
            </label>
            <div className="flex gap-1.5">
              {(['review', 'pre-fill', 'one-shot'] as const).map((m) => {
                const active = formatMode === m;
                const labelText = m === 'review' ? 'Review cards' : m === 'pre-fill' ? 'Pre-fill cards' : 'One-shot';
                return (
                  <button
                    key={m}
                    onClick={() => setFormatMode(m)}
                    className="text-[11px] px-2.5 py-1 rounded transition-all"
                    style={{
                      background: active ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
                      border: `1px solid ${active ? 'rgba(124,58,237,0.3)' : 'var(--border)'}`,
                      color: active ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                    }}
                  >
                    {labelText}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {formatMode === 'review' && 'Generate card list → review and edit → render image. Default.'}
              {formatMode === 'pre-fill' && 'You type the labels below; the LLM only fills in icon concepts.'}
              {formatMode === 'one-shot' && 'Generate card list and image back-to-back without a review step.'}
            </p>
            {formatMode === 'review' && script.trim() && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Tip: if the LLM picks titles that paraphrase your script, switch to <strong>Pre-fill cards</strong> and type the exact labels — the model will only fill in icon concepts and leave your wording intact.
              </p>
            )}
          </div>

          {formatMode === 'pre-fill' && (
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Card labels — one per line, exactly {totalCards}
              </label>
              <textarea
                className="input-field w-full text-xs"
                rows={Math.min(10, Math.max(4, totalCards))}
                value={prefilledLabels}
                onChange={(e) => setPrefilledLabels(e.target.value)}
                placeholder={'Morris Worm\nILOVEYOU\nStuxnet\n…'}
              />
              <p className="text-[10px] mt-0.5" style={{ color: prefilledLabelsList.length === totalCards ? 'var(--text-muted)' : 'var(--accent-yellow)' }}>
                {prefilledLabelsList.length} / {totalCards} labels
              </p>
            </div>
          )}

          {/* Reference image notice — optional, server falls back to a
              curated default when nothing is uploaded. */}
          {!referenceImageUrl.trim() && (
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              No reference uploaded — we&apos;ll use a bundled curated default. Upload one above (Image Generation section) to lock the typography to your own font.
            </p>
          )}
          {referenceImageUrl.trim() && (
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Reference image will guide the layout, typography, and overall style of the rendered thumbnail.
            </p>
          )}

          {/* Primary CTA */}
          <button
            className="btn-primary w-full flex items-center justify-center gap-2"
            onClick={runStep1}
            disabled={!canGenerateCards || busyStep !== 'idle'}
          >
            {busyStep === 'cards' && (
              <>
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                Generating card list…
              </>
            )}
            {busyStep === 'image' && (
              <>
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                Rendering image…
              </>
            )}
            {busyStep === 'idle' && 'Generate thumbnail'}
          </button>
          {cards && (
            <button
              onClick={clearCards}
              className="text-[11px] underline w-full text-center"
              style={{ color: 'var(--text-muted)' }}
            >
              Discard current card list
            </button>
          )}
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            ≈ $0.05–$0.11 per generation. Step 1 (card list) is &lt; $0.01; Step 2 (image) is the bulk.
          </p>
        </div>
      </div>

      {/* RIGHT PANEL — State A (editable cards) OR State B (result) */}
      <div className="flex-1 min-w-0">
        {!cards && !result && (
          <div className="glass p-12 text-center">
            <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              Topic Card Grid
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Upload a reference image, set the grid size, and click <strong>Generate thumbnail</strong>.
            </p>
          </div>
        )}

        {cards && !result && (
          <CardTableState
            cards={cards}
            totalCards={totalCards}
            gridMismatch={cardListMismatch ?? false}
            canRender={canRenderImage}
            busy={busyStep === 'image'}
            allowDelete={gridMode === 'custom'}
            allowAdd={gridMode === 'custom'}
            uploads={uploads}
            uploadFit={uploadFit}
            uploadFilter={uploadFilter}
            uploadingCells={uploadingCells}
            onUpdate={updateCard}
            onMove={moveCard}
            onDelete={deleteCard}
            onAdd={addCard}
            onUpload={uploadCellImage}
            onClearUpload={clearCellUpload}
            onUploadFitChange={updateUploadFit}
            onUploadFilterChange={updateUploadFilter}
            onRender={() => runStep2()}
            onRegenerate={() => { setCards(null); runStep1(); }}
          />
        )}

        {result && (
          <ResultState
            result={result}
            regionOverlayOn={regionOverlayOn}
            onToggleOverlay={toggleRegionOverlay}
            onEditCards={() => setResult(null)}
            onRegenerateImage={() => runStep2()}
            busy={busyStep === 'image'}
          />
        )}
      </div>
    </div>
  );
}

// ─── State A subcomponent — editable card table ─────────────────────────────

interface CardTableProps {
  cards: FormatCard[];
  totalCards: number;
  gridMismatch: boolean;
  canRender: boolean;
  busy: boolean;
  allowDelete: boolean;
  allowAdd: boolean;
  /** Map of 1-based card index → R2 download URL for that card's
   *  attached image. A missing entry means the card will be rendered
   *  from its icon_concept prompt as normal. */
  uploads: Record<number, string>;
  /** Per-upload fit overrides. Missing entries fall back to `'cover'`
   *  in the composite — same shape as the wire format. */
  uploadFit: Record<number, PanelUploadFit>;
  /** Per-upload filter overrides. Missing entries fall back to "no
   *  filter" in the composite. */
  uploadFilter: Record<number, PanelImageFilter>;
  /** Set of 1-based card indexes currently mid-upload. Drives the
   *  spinner state on the per-row upload button. */
  uploadingCells: Set<number>;
  onUpdate: (idx: number, patch: Partial<FormatCard>) => void;
  onMove: (idx: number, dir: -1 | 1) => void;
  onDelete: (idx: number) => void;
  onAdd: () => void;
  /** Trigger an upload for the given card index (1-based). The handler
   *  owns the presign + R2 PUT flow and the state writeback. */
  onUpload: (cardIndex: number, file: File) => void;
  /** Clear the attached upload for the given card index (1-based). */
  onClearUpload: (cardIndex: number) => void;
  /** Set the fit strategy for an uploaded cell. */
  onUploadFitChange: (cardIndex: number, fit: PanelUploadFit) => void;
  /** Set or clear (with `null`) the filter for an uploaded cell. */
  onUploadFilterChange: (cardIndex: number, filter: PanelImageFilter | null) => void;
  onRender: () => void;
  onRegenerate: () => void;
}

function CardTableState(props: CardTableProps) {
  const {
    cards, totalCards, gridMismatch, canRender, busy, allowDelete, allowAdd,
    uploads, uploadFit, uploadFilter, uploadingCells,
  } = props;
  return (
    <div className="glass p-5 space-y-3" style={{ borderColor: 'rgba(124,58,237,0.2)' }}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
          Review cards
        </h3>
        <span
          className="text-xs px-2 py-0.5 rounded"
          style={{
            background: gridMismatch ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
            color: gridMismatch ? '#ef4444' : '#22c55e',
          }}
        >
          {cards.length} / {totalCards} cards
        </span>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Edit any label or icon concept. Reorder with the arrows. {allowDelete ? 'Add or remove cards using the buttons below (Custom grid mode).' : 'Switch to Custom grid mode to add or remove cards.'}
      </p>

      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {cards.map((card, i) => (
          <div
            key={i}
            className="p-2 rounded-lg space-y-1.5"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono w-6 text-right" style={{ color: 'var(--text-muted)' }}>
                {card.index}
              </span>
              <input
                className="input-field flex-1 text-xs font-medium"
                placeholder="Card label"
                // Labels are 1-4 words by spec (max 60 chars). Stay
                // single-line so the row height matches the buttons next
                // to it, and surface the full text via the native tooltip
                // for the narrow-column case where the label doesn't fit
                // visually.
                title={card.label}
                value={card.label}
                onChange={(e) => props.onUpdate(i, { label: e.target.value })}
                maxLength={60}
              />
              {card.accent_color ? (
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={card.accent_color}
                    onChange={(e) => props.onUpdate(i, { accent_color: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer"
                    style={{ border: '1px solid var(--border)', background: 'none' }}
                    title="Accent color"
                  />
                  <button
                    onClick={() => props.onUpdate(i, { accent_color: undefined })}
                    className="text-[9px] px-1 rounded"
                    style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                    title="Clear accent — let the model pick natural colors"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => props.onUpdate(i, { accent_color: '#ff3b3b' })}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px dashed var(--border)' }}
                  title="Add an accent color hint for this card (optional)"
                >
                  + color
                </button>
              )}
              <button
                onClick={() => props.onMove(i, -1)}
                disabled={i === 0}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-card)', color: i === 0 ? 'var(--text-muted)' : 'var(--text-secondary)', border: '1px solid var(--border)', opacity: i === 0 ? 0.4 : 1 }}
                title="Move up"
              >
                ↑
              </button>
              <button
                onClick={() => props.onMove(i, 1)}
                disabled={i === cards.length - 1}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-card)', color: i === cards.length - 1 ? 'var(--text-muted)' : 'var(--text-secondary)', border: '1px solid var(--border)', opacity: i === cards.length - 1 ? 0.4 : 1 }}
                title="Move down"
              >
                ↓
              </button>
              {allowDelete && (
                <button
                  onClick={() => props.onDelete(i)}
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-card)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
                  title="Delete card"
                >
                  ✕
                </button>
              )}
            </div>
            {(() => {
              const uploadedUrl = uploads[card.index];
              const isUploading = uploadingCells.has(card.index);
              const conceptDisabled = !!uploadedUrl;
              const currentFit = uploadFit[card.index] ?? 'cover';
              const currentFilter = uploadFilter[card.index] ?? null;
              return (
                <div className="flex items-start gap-2">
                  {conceptDisabled ? (
                    // Upload mode: replace the disabled textarea with
                    // compact fit + filter pickers in the same horizontal
                    // slot. Keeps the row height roughly the same as the
                    // 3-row textarea while exposing the new per-cell
                    // controls without an extra disclosure click.
                    <div
                      className="flex-1 rounded px-2 py-1.5 space-y-1.5"
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)', minWidth: 28 }}>Fit</span>
                        <div className="flex gap-1">
                          {UPLOAD_FIT_OPTIONS.map((opt) => {
                            const active = currentFit === opt.value;
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => props.onUploadFitChange(card.index, opt.value)}
                                className="px-1.5 py-0.5 rounded text-[10px]"
                                style={{
                                  background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                                  color: active ? '#fff' : 'var(--text-secondary)',
                                  border: '1px solid var(--border)',
                                }}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)', minWidth: 28 }}>Filter</span>
                        <div className="flex gap-1 flex-wrap">
                          {POST_PROCESS_FILTER_OPTIONS.map((opt) => {
                            const active = currentFilter === opt.value;
                            return (
                              <button
                                key={opt.value ?? 'none'}
                                type="button"
                                onClick={() => props.onUploadFilterChange(card.index, opt.value)}
                                className="px-1.5 py-0.5 rounded text-[10px]"
                                style={{
                                  background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                                  color: active ? '#fff' : 'var(--text-secondary)',
                                  border: '1px solid var(--border)',
                                }}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <textarea
                      className="input-field flex-1 text-xs"
                      placeholder="Icon concept — one bold central symbol, no text, no scene"
                      value={card.icon_concept}
                      onChange={(e) => props.onUpdate(i, { icon_concept: e.target.value })}
                      maxLength={200}
                      rows={3}
                      // Fixed 3-row preview (covers most icon concepts) with
                      // an inner scrollbar for longer text, and a vertical
                      // resize grip so the user can drag taller when they
                      // need to read all 200 chars at once. Avoids the
                      // `field-sizing: content` trap where narrow columns
                      // would balloon the row to 10+ lines.
                      style={ICON_CONCEPT_TEXTAREA_STYLE(false)}
                    />
                  )}
                  <CellUploadControl
                    cardIndex={card.index}
                    uploadedUrl={uploadedUrl}
                    isUploading={isUploading}
                    onUpload={props.onUpload}
                    onClear={props.onClearUpload}
                  />
                </div>
              );
            })()}
          </div>
        ))}
        {allowAdd && (
          <button
            onClick={props.onAdd}
            className="w-full text-xs py-1.5 rounded"
            style={{ background: 'var(--bg-card)', border: '1px dashed var(--border)', color: 'var(--text-muted)' }}
          >
            + Add card
          </button>
        )}
      </div>

      {gridMismatch && (
        <div
          className="text-xs px-3 py-2 rounded-lg"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}
        >
          Card count ({cards.length}) does not match the grid ({totalCards}). Adjust the grid size or add/remove cards before rendering.
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={props.onRender}
          disabled={!canRender || busy}
          className="btn-primary text-xs flex-1 flex items-center justify-center gap-1.5"
        >
          {busy ? (
            <>
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
              Rendering…
            </>
          ) : (
            'Render image'
          )}
        </button>
        <button
          onClick={props.onRegenerate}
          className="btn-secondary text-xs"
        >
          Regenerate card list
        </button>
      </div>
    </div>
  );
}

// ─── Per-cell upload control (used inside CardTableState) ───────────────────

interface CellUploadControlProps {
  cardIndex: number;
  uploadedUrl: string | undefined;
  isUploading: boolean;
  onUpload: (cardIndex: number, file: File) => void;
  onClear: (cardIndex: number) => void;
}

/**
 * Three-state per-card upload affordance, slotted next to the
 * icon_concept input:
 *   - **none**: paperclip "+ Image" button kicks off the file picker.
 *   - **uploading**: small spinner replaces the button.
 *   - **uploaded**: 32px thumbnail + Replace + Clear (×) controls.
 *
 * The file `<input type="file" hidden>` is owned by this component so
 * each row has its own ref — sharing one input across rows would race
 * the `onChange` event when the user uploads quickly to multiple cells.
 */
function CellUploadControl({
  cardIndex, uploadedUrl, isUploading, onUpload, onClear,
}: CellUploadControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const open = () => inputRef.current?.click();

  if (isUploading) {
    return (
      <div
        className="flex items-center justify-center text-xs px-2 rounded shrink-0"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', minWidth: 84, color: 'var(--text-muted)' }}
        title={`Uploading image for card ${cardIndex}…`}
      >
        <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" opacity="0.25" />
          <path d="M12 2a10 10 0 0 1 10 10" />
        </svg>
      </div>
    );
  }

  if (uploadedUrl) {
    return (
      <div
        className="flex items-center gap-1 px-1.5 rounded shrink-0"
        style={{ background: 'var(--bg-card)', border: '1px solid rgba(34,197,94,0.35)' }}
      >
        <img
          src={uploadedUrl}
          alt={`Card ${cardIndex} upload`}
          className="rounded"
          style={{ width: 28, height: 28, objectFit: 'cover', display: 'block' }}
        />
        <button
          onClick={open}
          className="text-[10px] px-1 py-0.5 rounded"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          title="Replace image"
        >
          Replace
        </button>
        <button
          onClick={() => onClear(cardIndex)}
          className="text-[10px] px-1 py-0.5 rounded"
          style={{ background: 'var(--bg-secondary)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
          title="Clear upload — restore the icon concept prompt"
        >
          ×
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(cardIndex, file);
            e.target.value = '';
          }}
        />
      </div>
    );
  }

  return (
    <>
      <button
        onClick={open}
        className="text-[10px] px-2 rounded shrink-0 flex items-center gap-1"
        style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px dashed var(--border)' }}
        title="Attach an image to use for this card instead of generating one"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        Image
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(cardIndex, file);
          e.target.value = '';
        }}
      />
    </>
  );
}

// ─── State B subcomponent — result with region overlay ──────────────────────

interface ResultProps {
  result: FormatGenerationResult;
  regionOverlayOn: boolean;
  onToggleOverlay: () => void;
  onEditCards: () => void;
  onRegenerateImage: () => void;
  busy: boolean;
}

function ResultState({ result, regionOverlayOn, onToggleOverlay, onEditCards, onRegenerateImage, busy }: ResultProps) {
  const aspect = result.outputHeight / result.outputWidth;
  return (
    <div className="glass p-5 space-y-3" style={{ borderColor: 'rgba(34,197,94,0.2)' }}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
          Generated thumbnail
        </h3>
        <label className="flex items-center gap-2 cursor-pointer text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={regionOverlayOn}
            onChange={onToggleOverlay}
            style={{ accentColor: 'var(--accent-pink)' }}
          />
          Region overlay
        </label>
      </div>

      <div
        className="relative w-full rounded-lg overflow-hidden"
        style={{ border: '1px solid var(--border)', aspectRatio: `${result.outputWidth} / ${result.outputHeight}` }}
      >
        <img
          src={result.imageUrl}
          alt="Generated thumbnail"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        {regionOverlayOn && (
          <svg
            viewBox={`0 0 ${result.outputWidth} ${result.outputHeight}`}
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            {result.regions.map((r, i) => {
              // Circle mode: regions describe disc bounding boxes, so we
              // draw an ellipse that fills the box. Square mode keeps the
              // dashed rectangle behaviour. This matches what the user
              // actually sees in the rendered thumbnail (rule 16: clear).
              const isCircle = result.cardShape === 'circle';
              const stroke = 'rgba(236,72,153,0.85)';
              const strokeWidth = Math.max(2, result.outputWidth * 0.003);
              const dashArray = `${Math.max(6, result.outputWidth * 0.01)} ${Math.max(4, result.outputWidth * 0.006)}`;
              return (
                <g key={r.id}>
                  {isCircle ? (
                    <ellipse
                      cx={r.x + r.w / 2}
                      cy={r.y + r.h / 2}
                      rx={r.w / 2}
                      ry={r.h / 2}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={strokeWidth}
                      strokeDasharray={dashArray}
                    />
                  ) : (
                    <rect
                      x={r.x}
                      y={r.y}
                      width={r.w}
                      height={r.h}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={strokeWidth}
                      strokeDasharray={dashArray}
                    />
                  )}
                  <text
                    x={isCircle ? r.x + r.w / 2 : r.x + 8}
                    y={isCircle ? r.y + r.h / 2 + Math.max(7, result.outputWidth * 0.009) : r.y + Math.max(20, result.outputWidth * 0.025)}
                    fill="rgba(236,72,153,1)"
                    fontSize={Math.max(14, result.outputWidth * 0.018)}
                    fontFamily="ui-monospace, monospace"
                    textAnchor={isCircle ? 'middle' : 'start'}
                  >
                    {i + 1}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Aspect {Math.round(1 / aspect * 10) / 10}:1 · {result.outputWidth}×{result.outputHeight} · {result.regions.length} region{result.regions.length === 1 ? '' : 's'} ready for production-doc.
      </p>

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => { navigator.clipboard.writeText(result.imageUrl); toast.success('Image URL copied'); }}
          className="btn-secondary text-xs px-2 py-1"
        >
          Copy URL
        </button>
        <a
          href={downloadHref(result.imageUrl, `thumbnail-grid.png`)}
          download="thumbnail-grid.png"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary text-xs px-2 py-1 inline-flex items-center gap-1"
        >
          Download
        </a>
        <button
          onClick={() => {
            navigator.clipboard.writeText(JSON.stringify(result.regions, null, 2));
            toast.success('Regions JSON copied');
          }}
          className="btn-secondary text-xs px-2 py-1"
        >
          Copy regions JSON
        </button>
        <button
          onClick={onEditCards}
          className="btn-secondary text-xs px-2 py-1"
        >
          Edit cards
        </button>
        <button
          onClick={onRegenerateImage}
          disabled={busy}
          className="btn-secondary text-xs px-2 py-1"
        >
          Regenerate image
        </button>
      </div>

      {/* Read-only card list reference */}
      <details className="text-xs">
        <summary className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>
          Cards rendered ({result.cards.length})
        </summary>
        <div className="mt-2 space-y-1">
          {result.cards.map((c) => (
            <div key={c.index} className="flex gap-2" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-mono w-6 text-right" style={{ color: 'var(--text-muted)' }}>{c.index}</span>
              <span className="font-medium">{c.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>— {c.icon_concept}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
