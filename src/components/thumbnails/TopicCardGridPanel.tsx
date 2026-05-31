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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  ChipPicker,
  ColorAndSlider,
  FinishingPresetRow,
  HexInput,
  OverlayCard,
  RangeRow,
  SubToggle,
  type FinishingOverlaysPatch,
  type PanelColorGradeBlend,
  type PanelFrameStyle,
  type PanelHalftoneBlend,
  type PanelInnerGlowBlend,
  type PanelLightLeakPosition,
} from '@/components/thumbnails/_overlay-controls';
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
  // r2.8: tint (flat-colour wash with optional split-tone).
  tintEnabled: boolean;
  tintColor: string;
  /** 0 - 1. */
  tintIntensity: number;
  tintBlendMode: PanelColorGradeBlend;
  tintShadowsEnabled: boolean;
  tintShadows: string;
  tintHighlightsEnabled: boolean;
  tintHighlights: string;
  /** 0 - 1. Strength of the split-tone shadows + highlights layers
   *  relative to the base wash. Defaults to 0.5 (each split layer at
   *  half the base wash's intensity). */
  tintSplitStrength: number;
  // r2.8: light leak (radial gradient anchored to a canvas edge).
  lightLeakEnabled: boolean;
  lightLeakColor: string;
  /** 0 - 1. */
  lightLeakIntensity: number;
  /** 0.2 - 1. Fraction of the canvas's short half-axis. */
  lightLeakRadius: number;
  lightLeakPosition: PanelLightLeakPosition;
  lightLeakBlendMode: PanelColorGradeBlend;
  // r2.8: inner glow (radial gradient centred on the canvas).
  innerGlowEnabled: boolean;
  innerGlowColor: string;
  /** 0 - 1. */
  innerGlowIntensity: number;
  /** 0.3 - 1.5. */
  innerGlowRadius: number;
  innerGlowBlendMode: PanelInnerGlowBlend;
  // r2.8: dust / scratches (sparse specks via turbulence).
  dustEnabled: boolean;
  dustColor: string;
  /** 0 - 1. */
  dustIntensity: number;
  /** 0 - 1. */
  dustDensity: number;
  /** 0 - 9999. */
  dustSeed: number;
  // r2.8: halftone (uniform dot pattern with optional rotation).
  halftoneEnabled: boolean;
  halftoneColor: string;
  /** 0 - 1. */
  halftoneOpacity: number;
  /** 0.5 - 10 px. */
  halftoneDotSize: number;
  /** 2 - 40 px. */
  halftoneSpacing: number;
  halftoneBlendMode: PanelHalftoneBlend;
  /** 0 - 90 degrees. */
  halftoneAngle: number;
  // r2.8: letterbox (4-sided bars).
  letterboxEnabled: boolean;
  letterboxColor: string;
  /** 0 - 240 px per side. */
  letterboxTop: number;
  letterboxBottom: number;
  letterboxLeft: number;
  letterboxRight: number;
  /** 0 - 1. */
  letterboxOpacity: number;
  // r2.8: frame (outer canvas stroke).
  frameEnabled: boolean;
  frameColor: string;
  /** 1 - 40 px. */
  frameThickness: number;
  /** 0 - 80 px. */
  frameInset: number;
  frameStyle: PanelFrameStyle;
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
  tintEnabled: false,
  tintColor: '#ffb27a',
  tintIntensity: 0.25,
  tintBlendMode: 'soft-light',
  tintShadowsEnabled: false,
  tintShadows: '#0a3a5a',
  tintHighlightsEnabled: false,
  tintHighlights: '#ffd28a',
  tintSplitStrength: 0.5,
  lightLeakEnabled: false,
  lightLeakColor: '#ffd28a',
  lightLeakIntensity: 0.4,
  lightLeakRadius: 0.6,
  lightLeakPosition: 'top-right',
  lightLeakBlendMode: 'screen',
  innerGlowEnabled: false,
  innerGlowColor: '#ffffff',
  innerGlowIntensity: 0.2,
  innerGlowRadius: 0.9,
  innerGlowBlendMode: 'soft-light',
  dustEnabled: false,
  dustColor: '#ffffff',
  dustIntensity: 0.4,
  dustDensity: 0.25,
  dustSeed: 41,
  halftoneEnabled: false,
  halftoneColor: '#000000',
  halftoneOpacity: 0.3,
  halftoneDotSize: 1.5,
  halftoneSpacing: 6,
  halftoneBlendMode: 'multiply',
  halftoneAngle: 0,
  letterboxEnabled: false,
  letterboxColor: '#000000',
  letterboxTop: 0,
  letterboxBottom: 0,
  letterboxLeft: 0,
  letterboxRight: 0,
  letterboxOpacity: 1,
  frameEnabled: false,
  frameColor: '#ffffff',
  frameThickness: 4,
  frameInset: 8,
  frameStyle: 'solid',
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
  const coerceHex = (raw: unknown, fb: string): string =>
    typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fb;
  const coerceColorGradeBlend = (raw: unknown, fb: PanelColorGradeBlend): PanelColorGradeBlend =>
    raw === 'multiply' || raw === 'screen' || raw === 'overlay' || raw === 'soft-light'
      ? (raw as PanelColorGradeBlend)
      : fb;
  const coerceHalftoneBlend = (raw: unknown, fb: PanelHalftoneBlend): PanelHalftoneBlend =>
    raw === 'multiply' ||
    raw === 'screen' ||
    raw === 'overlay' ||
    raw === 'soft-light' ||
    raw === 'normal'
      ? (raw as PanelHalftoneBlend)
      : fb;
  const coerceInnerGlowBlend = (raw: unknown, fb: PanelInnerGlowBlend): PanelInnerGlowBlend =>
    raw === 'screen' || raw === 'overlay' || raw === 'soft-light'
      ? (raw as PanelInnerGlowBlend)
      : fb;
  const coerceLightLeakPosition = (
    raw: unknown,
    fb: PanelLightLeakPosition,
  ): PanelLightLeakPosition =>
    raw === 'top-left' ||
    raw === 'top-right' ||
    raw === 'bottom-left' ||
    raw === 'bottom-right' ||
    raw === 'top' ||
    raw === 'bottom' ||
    raw === 'left' ||
    raw === 'right'
      ? (raw as PanelLightLeakPosition)
      : fb;
  const coerceFrameStyle = (raw: unknown, fb: PanelFrameStyle): PanelFrameStyle =>
    raw === 'solid' || raw === 'double' || raw === 'dashed' ? (raw as PanelFrameStyle) : fb;
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
    tintEnabled: r.tintEnabled === true,
    tintColor: coerceHex(r.tintColor, DEFAULT_POST_PROCESS_STATE.tintColor),
    tintIntensity: clamp(r.tintIntensity, 0, 1, DEFAULT_POST_PROCESS_STATE.tintIntensity),
    tintBlendMode: coerceColorGradeBlend(r.tintBlendMode, DEFAULT_POST_PROCESS_STATE.tintBlendMode),
    tintShadowsEnabled: r.tintShadowsEnabled === true,
    tintShadows: coerceHex(r.tintShadows, DEFAULT_POST_PROCESS_STATE.tintShadows),
    tintHighlightsEnabled: r.tintHighlightsEnabled === true,
    tintHighlights: coerceHex(r.tintHighlights, DEFAULT_POST_PROCESS_STATE.tintHighlights),
    tintSplitStrength: clamp(r.tintSplitStrength, 0, 1, DEFAULT_POST_PROCESS_STATE.tintSplitStrength),
    lightLeakEnabled: r.lightLeakEnabled === true,
    lightLeakColor: coerceHex(r.lightLeakColor, DEFAULT_POST_PROCESS_STATE.lightLeakColor),
    lightLeakIntensity: clamp(
      r.lightLeakIntensity,
      0,
      1,
      DEFAULT_POST_PROCESS_STATE.lightLeakIntensity,
    ),
    lightLeakRadius: clamp(r.lightLeakRadius, 0.2, 1, DEFAULT_POST_PROCESS_STATE.lightLeakRadius),
    lightLeakPosition: coerceLightLeakPosition(
      r.lightLeakPosition,
      DEFAULT_POST_PROCESS_STATE.lightLeakPosition,
    ),
    lightLeakBlendMode: coerceColorGradeBlend(
      r.lightLeakBlendMode,
      DEFAULT_POST_PROCESS_STATE.lightLeakBlendMode,
    ),
    innerGlowEnabled: r.innerGlowEnabled === true,
    innerGlowColor: coerceHex(r.innerGlowColor, DEFAULT_POST_PROCESS_STATE.innerGlowColor),
    innerGlowIntensity: clamp(
      r.innerGlowIntensity,
      0,
      1,
      DEFAULT_POST_PROCESS_STATE.innerGlowIntensity,
    ),
    innerGlowRadius: clamp(r.innerGlowRadius, 0.3, 1.5, DEFAULT_POST_PROCESS_STATE.innerGlowRadius),
    innerGlowBlendMode: coerceInnerGlowBlend(
      r.innerGlowBlendMode,
      DEFAULT_POST_PROCESS_STATE.innerGlowBlendMode,
    ),
    dustEnabled: r.dustEnabled === true,
    dustColor: coerceHex(r.dustColor, DEFAULT_POST_PROCESS_STATE.dustColor),
    dustIntensity: clamp(r.dustIntensity, 0, 1, DEFAULT_POST_PROCESS_STATE.dustIntensity),
    dustDensity: clamp(r.dustDensity, 0, 1, DEFAULT_POST_PROCESS_STATE.dustDensity),
    dustSeed: clamp(r.dustSeed, 0, 9999, DEFAULT_POST_PROCESS_STATE.dustSeed),
    halftoneEnabled: r.halftoneEnabled === true,
    halftoneColor: coerceHex(r.halftoneColor, DEFAULT_POST_PROCESS_STATE.halftoneColor),
    halftoneOpacity: clamp(r.halftoneOpacity, 0, 1, DEFAULT_POST_PROCESS_STATE.halftoneOpacity),
    halftoneDotSize: clamp(r.halftoneDotSize, 0.5, 10, DEFAULT_POST_PROCESS_STATE.halftoneDotSize),
    halftoneSpacing: clamp(r.halftoneSpacing, 2, 40, DEFAULT_POST_PROCESS_STATE.halftoneSpacing),
    halftoneBlendMode: coerceHalftoneBlend(
      r.halftoneBlendMode,
      DEFAULT_POST_PROCESS_STATE.halftoneBlendMode,
    ),
    halftoneAngle: clamp(r.halftoneAngle, 0, 90, DEFAULT_POST_PROCESS_STATE.halftoneAngle),
    letterboxEnabled: r.letterboxEnabled === true,
    letterboxColor: coerceHex(r.letterboxColor, DEFAULT_POST_PROCESS_STATE.letterboxColor),
    letterboxTop: clamp(r.letterboxTop, 0, 240, DEFAULT_POST_PROCESS_STATE.letterboxTop),
    letterboxBottom: clamp(r.letterboxBottom, 0, 240, DEFAULT_POST_PROCESS_STATE.letterboxBottom),
    letterboxLeft: clamp(r.letterboxLeft, 0, 240, DEFAULT_POST_PROCESS_STATE.letterboxLeft),
    letterboxRight: clamp(r.letterboxRight, 0, 240, DEFAULT_POST_PROCESS_STATE.letterboxRight),
    letterboxOpacity: clamp(r.letterboxOpacity, 0, 1, DEFAULT_POST_PROCESS_STATE.letterboxOpacity),
    frameEnabled: r.frameEnabled === true,
    frameColor: coerceHex(r.frameColor, DEFAULT_POST_PROCESS_STATE.frameColor),
    frameThickness: clamp(r.frameThickness, 1, 40, DEFAULT_POST_PROCESS_STATE.frameThickness),
    frameInset: clamp(r.frameInset, 0, 80, DEFAULT_POST_PROCESS_STATE.frameInset),
    frameStyle: coerceFrameStyle(r.frameStyle, DEFAULT_POST_PROCESS_STATE.frameStyle),
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
  tint?: {
    color: string;
    intensity: number;
    blendMode: PanelColorGradeBlend;
    shadows?: string;
    highlights?: string;
    splitToneStrength?: number;
  };
  lightLeak?: {
    color: string;
    intensity: number;
    radius: number;
    position: PanelLightLeakPosition;
    blendMode?: PanelColorGradeBlend;
  };
  innerGlow?: { color: string; intensity: number; radius: number; blendMode?: PanelInnerGlowBlend };
  dust?: { color: string; intensity: number; density: number; seed?: number };
  halftone?: {
    color: string;
    opacity: number;
    dotSize: number;
    spacing: number;
    blendMode: PanelHalftoneBlend;
    angle?: number;
  };
  letterbox?: {
    color: string;
    top: number;
    bottom: number;
    left: number;
    right: number;
    opacity?: number;
  };
  frame?: { color: string; thickness: number; inset: number; style?: PanelFrameStyle };
} | undefined {
  const out: {
    filter?: PanelImageFilter;
    vignette?: { color: string; intensity: number; radius: number };
    grain?: { intensity: number; size: number; monochrome: boolean };
    tint?: {
      color: string;
      intensity: number;
      blendMode: PanelColorGradeBlend;
      shadows?: string;
      highlights?: string;
      splitToneStrength?: number;
    };
    lightLeak?: {
      color: string;
      intensity: number;
      radius: number;
      position: PanelLightLeakPosition;
      blendMode?: PanelColorGradeBlend;
    };
    innerGlow?: {
      color: string;
      intensity: number;
      radius: number;
      blendMode?: PanelInnerGlowBlend;
    };
    dust?: { color: string; intensity: number; density: number; seed?: number };
    halftone?: {
      color: string;
      opacity: number;
      dotSize: number;
      spacing: number;
      blendMode: PanelHalftoneBlend;
      angle?: number;
    };
    letterbox?: {
      color: string;
      top: number;
      bottom: number;
      left: number;
      right: number;
      opacity?: number;
    };
    frame?: { color: string; thickness: number; inset: number; style?: PanelFrameStyle };
  } = {};
  if (s.filter) out.filter = s.filter;
  if (s.vignetteEnabled && s.vignetteIntensity > 0) {
    out.vignette = { color: s.vignetteColor, intensity: s.vignetteIntensity, radius: s.vignetteRadius };
  }
  if (s.grainEnabled && s.grainIntensity > 0) {
    out.grain = { intensity: s.grainIntensity, size: s.grainSize, monochrome: s.grainMonochrome };
  }
  if (s.tintEnabled && s.tintIntensity > 0) {
    out.tint = {
      color: s.tintColor,
      intensity: s.tintIntensity,
      blendMode: s.tintBlendMode,
      ...(s.tintShadowsEnabled ? { shadows: s.tintShadows } : {}),
      ...(s.tintHighlightsEnabled ? { highlights: s.tintHighlights } : {}),
      ...(s.tintShadowsEnabled || s.tintHighlightsEnabled
        ? { splitToneStrength: s.tintSplitStrength }
        : {}),
    };
  }
  if (s.lightLeakEnabled && s.lightLeakIntensity > 0) {
    out.lightLeak = {
      color: s.lightLeakColor,
      intensity: s.lightLeakIntensity,
      radius: s.lightLeakRadius,
      position: s.lightLeakPosition,
      blendMode: s.lightLeakBlendMode,
    };
  }
  if (s.innerGlowEnabled && s.innerGlowIntensity > 0) {
    out.innerGlow = {
      color: s.innerGlowColor,
      intensity: s.innerGlowIntensity,
      radius: s.innerGlowRadius,
      blendMode: s.innerGlowBlendMode,
    };
  }
  if (s.dustEnabled && s.dustIntensity > 0 && s.dustDensity > 0) {
    out.dust = {
      color: s.dustColor,
      intensity: s.dustIntensity,
      density: s.dustDensity,
      seed: s.dustSeed,
    };
  }
  if (s.halftoneEnabled && s.halftoneOpacity > 0) {
    out.halftone = {
      color: s.halftoneColor,
      opacity: s.halftoneOpacity,
      dotSize: s.halftoneDotSize,
      spacing: s.halftoneSpacing,
      blendMode: s.halftoneBlendMode,
      ...(s.halftoneAngle !== 0 ? { angle: s.halftoneAngle } : {}),
    };
  }
  if (
    s.letterboxEnabled &&
    (s.letterboxTop > 0 || s.letterboxBottom > 0 || s.letterboxLeft > 0 || s.letterboxRight > 0)
  ) {
    out.letterbox = {
      color: s.letterboxColor,
      top: s.letterboxTop,
      bottom: s.letterboxBottom,
      left: s.letterboxLeft,
      right: s.letterboxRight,
      ...(s.letterboxOpacity < 1 ? { opacity: s.letterboxOpacity } : {}),
    };
  }
  if (s.frameEnabled && s.frameThickness >= 1) {
    out.frame = {
      color: s.frameColor,
      thickness: s.frameThickness,
      inset: s.frameInset,
      style: s.frameStyle,
    };
  }
  if (
    !out.filter &&
    !out.vignette &&
    !out.grain &&
    !out.tint &&
    !out.lightLeak &&
    !out.innerGlow &&
    !out.dust &&
    !out.halftone &&
    !out.letterbox &&
    !out.frame
  ) {
    return undefined;
  }
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

/** Clipboard envelope shape for "thumbnail style" payloads. Wraps
 *  postProcess + titleBar in a versioned object so future schema
 *  changes can be detected and migrated. Designed to be cross-format:
 *  Topic Card Grid and N Levels share the exact same postProcess +
 *  titleBar shapes, so a style copied from one pastes cleanly into the
 *  other. */
export interface ThumbnailStyleClipboardEnvelope {
  type: 'thumbnail-style';
  version: 1;
  postProcess: PanelPostProcessState;
  titleBar: PanelTitleBarState;
}

/** Clipboard envelope shape for full-draft export. Wraps a complete
 *  `TopicCardGridDraftState` plus a timestamp + version so a future
 *  schema change can be detected and migrated. The `type` field is
 *  format-specific (NOT shareable between Topic Card Grid and N Levels
 *  — drafts include format-specific fields like cards / palette /
 *  uploads that don't translate between formats). */
export interface TopicCardGridDraftExportEnvelope {
  type: 'topic-card-grid-draft';
  version: 1;
  exportedAt: string;
  draft: TopicCardGridDraftState;
}

/** Parse a full-draft clipboard payload. Returns null when the payload
 *  is not a recognised Topic Card Grid draft envelope. Strict on `type`
 *  to prevent cross-format pastes (an N Levels draft would silently
 *  hydrate the wrong fields if we accepted it). */
export function parseTopicCardGridDraftEnvelope(raw: string): TopicCardGridDraftState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (r.type !== 'topic-card-grid-draft') return null;
  if (r.version !== 1) return null;
  if (!r.draft || typeof r.draft !== 'object') return null;
  return r.draft as TopicCardGridDraftState;
}

/** Build a clipboard envelope from the current panel style. Both
 *  postProcess and titleBar are always included (even when disabled)
 *  so paste preserves the exact panel state the user copied — including
 *  off-but-pre-filled values. */
export function buildStyleClipboardEnvelope(
  postProcess: PanelPostProcessState,
  titleBar: PanelTitleBarState,
): ThumbnailStyleClipboardEnvelope {
  return {
    type: 'thumbnail-style',
    version: 1,
    postProcess,
    titleBar,
  };
}

/** Parse a clipboard payload back into panel state. Returns null when
 *  the payload is not a recognised thumbnail-style envelope. Forgiving
 *  on internal shapes — postProcess and titleBar pass through their
 *  own coerce helpers so partial / corrupt sub-payloads degrade to
 *  defaults rather than failing the paste. */
export function parseStyleClipboardEnvelope(
  raw: string,
): { postProcess: PanelPostProcessState; titleBar: PanelTitleBarState } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (r.type !== 'thumbnail-style') return null;
  if (r.version !== 1) return null;
  return {
    postProcess: coercePostProcessState(r.postProcess),
    titleBar: coerceTitleBarState(r.titleBar),
  };
}

/** Panel-side shape of a saved-preset list-item from the server. The
 *  server returns more fields (workspace_id, created_at, created_by);
 *  the panel only needs id + name + preset + updated_at to render the
 *  list. */
export interface SavedPresetSummary {
  id: string;
  name: string;
  preset: unknown;
  updated_at: string;
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

  // Saved presets — workspace-scoped persisted style envelopes (Phase 4d).
  // Fetched on mount, refreshed after save / delete. Empty list and
  // loading flag drive the picker's three states: loading, empty,
  // populated. Save is gated by a flag so a double-click doesn't fire
  // two POSTs.
  const [savedPresets, setSavedPresets] = useState<SavedPresetSummary[]>([]);
  const [loadingPresets, setLoadingPresets] = useState(true);
  const [savingPreset, setSavingPreset] = useState(false);
  const refreshPresets = useCallback(async () => {
    try {
      const res = await fetch('/api/thumbnails/format/topic-card-grid/saved-presets');
      if (!res.ok) {
        // Auth or server error — keep the picker in "empty" state
        // gracefully. Surface only in the console so a logged-out
        // session doesn't spam toasts on every panel mount.
        console.warn('[topic-card-grid panel saved-presets fetch] not_ok', {
          status: res.status,
        });
        setSavedPresets([]);
        return;
      }
      const data = await res.json() as { presets?: SavedPresetSummary[] };
      setSavedPresets(Array.isArray(data.presets) ? data.presets : []);
    } catch (err) {
      console.warn('[topic-card-grid panel saved-presets fetch] error', {
        detail: err instanceof Error ? err.message : String(err),
      });
      setSavedPresets([]);
    } finally {
      setLoadingPresets(false);
    }
  }, []);
  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

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
  // r2.8+ live preview: data URL of the rendered thumbnail with the
  // current post-process / title-bar config applied client-side via the
  // /api/thumbnails/post-process-preview endpoint. Falls back to
  // `result.imageUrl` (the last fully-rendered AI image) when no
  // preview has been generated yet OR when the user changes a control
  // and we're still fetching the new preview.
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const previewAbortRef = useRef<AbortController | null>(null);

  // r2.8+ live preview: debounced re-render of post-process + title-bar
  // overlays on top of the LAST RENDERED AI image. Calls
  // `/api/thumbnails/post-process-preview` 400 ms after the user stops
  // tweaking; cancels any in-flight request when a new tweak comes in.
  // Updates `previewImageUrl` with the preview's data URL; the image
  // display swaps to that URL when present.
  //
  // No-op when there's no rendered result yet (the preview needs an AI
  // image as its base) OR when neither postProcess nor titleBar would
  // produce a visible effect (avoids burning a roundtrip on an all-off
  // state).
  useEffect(() => {
    if (!result?.imageUrl) {
      setPreviewImageUrl(null);
      return;
    }
    const postProcessPayload = buildPostProcessRequestPayload(postProcess);
    const titleBarPayload = titleBar.enabled
      ? {
          text: titleBar.text,
          subtitle: titleBar.subtitle,
          position: titleBar.position,
          heightFraction: titleBar.heightFraction,
          align: titleBar.align,
          subtitleAlign: titleBar.subtitleAlign,
          backgroundColor: titleBar.backgroundColor,
          backgroundOpacity: titleBar.backgroundOpacity,
          textColor: titleBar.textColor,
          subtitleColor: titleBar.subtitleColor,
          fontId: titleBar.fontId,
          subtitleFontId: titleBar.subtitleFontId || undefined,
          shadow: titleBar.shadowEnabled
            ? {
                offsetPx: titleBar.shadowOffsetPx,
                blurPx: titleBar.shadowBlurPx,
                opacity: titleBar.shadowOpacity,
                color: titleBar.shadowColor,
              }
            : undefined,
        }
      : null;
    if (!postProcessPayload && !titleBarPayload) {
      setPreviewImageUrl(null);
      return;
    }
    const handle = setTimeout(() => {
      previewAbortRef.current?.abort();
      const ctrl = new AbortController();
      previewAbortRef.current = ctrl;
      setPreviewLoading(true);
      fetch('/api/thumbnails/post-process-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseImageUrl: result.imageUrl,
          postProcess: postProcessPayload,
          titleBar: titleBarPayload,
          canvasWidth: result.outputWidth,
          canvasHeight: result.outputHeight,
        }),
        signal: ctrl.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            console.warn('[topic-card-grid preview]', { status: res.status, detail });
            return;
          }
          const data = (await res.json()) as { imageUrl?: string };
          if (typeof data.imageUrl === 'string') setPreviewImageUrl(data.imageUrl);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          console.warn('[topic-card-grid preview]', { detail: String(err) });
        })
        .finally(() => {
          if (previewAbortRef.current === ctrl) setPreviewLoading(false);
        });
    }, 400);
    return () => clearTimeout(handle);
  }, [postProcess, titleBar, result]);

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
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Post-process
              </label>
              {/* Copy / Paste style — clipboard envelope covering BOTH
                  post-process and title-bar state. Lives at the top of
                  the Post-process section because Post-process is the
                  first visual-style section; cross-format (Topic Card
                  Grid <-> N Levels) compatible because both panels share
                  the exact same envelope shape. */}
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const envelope = buildStyleClipboardEnvelope(postProcess, titleBar);
                      await navigator.clipboard.writeText(JSON.stringify(envelope));
                      toast.success('Style copied to clipboard');
                      console.info('[topic-card-grid panel style copy]', {
                        post_process_filter: postProcess.filter,
                        post_process_vignette: postProcess.vignetteEnabled,
                        post_process_grain: postProcess.grainEnabled,
                        title_bar_enabled: titleBar.enabled,
                      });
                    } catch (err) {
                      toast.error('Could not copy style — clipboard access denied.');
                      console.warn('[topic-card-grid panel style copy] error', {
                        detail: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                  title="Copy post-process + title-bar settings to clipboard"
                >
                  Copy style
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      const parsed = parseStyleClipboardEnvelope(text);
                      if (!parsed) {
                        toast.error('Clipboard does not contain a thumbnail style.');
                        console.info('[topic-card-grid panel style paste] rejected', {
                          length: text.length,
                        });
                        return;
                      }
                      setPostProcess(parsed.postProcess);
                      setTitleBar(parsed.titleBar);
                      toast.success('Style pasted');
                      console.info('[topic-card-grid panel style paste]', {
                        post_process_filter: parsed.postProcess.filter,
                        post_process_vignette: parsed.postProcess.vignetteEnabled,
                        post_process_grain: parsed.postProcess.grainEnabled,
                        title_bar_enabled: parsed.titleBar.enabled,
                      });
                    } catch (err) {
                      toast.error('Could not paste style — clipboard access denied.');
                      console.warn('[topic-card-grid panel style paste] error', {
                        detail: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                  title="Apply a thumbnail style from the clipboard"
                >
                  Paste style
                </button>
              </div>
            </div>

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

            {/* r2.8: seven finishing overlays ported from Flex Icon Grid —
                tint, light leak, inner glow, dust, halftone, letterbox,
                frame. Each section follows the vignette/grain pattern:
                enable toggle + collapsed body when off. Server-side parsers
                clamp / drop malformed values, so the controls are forgiving
                about edge cases. Finishing presets sit above the 7 cards
                for one-click "vintage film" / "cinematic 2.39" / etc.
                application. */}
            <FinishingPresetRow
              onApply={(patch: FinishingOverlaysPatch) => updatePostProcess(patch)}
            />
            <OverlayCard
              title="Tint"
              hint="Flat colour wash + optional split-tone shadows/highlights."
              enabled={postProcess.tintEnabled}
              onToggle={() => updatePostProcess({ tintEnabled: !postProcess.tintEnabled })}
            >
              <ColorAndSlider
                label="Tint"
                color={postProcess.tintColor}
                onColor={(v) => updatePostProcess({ tintColor: v })}
                value={postProcess.tintIntensity}
                onValue={(v) => updatePostProcess({ tintIntensity: v })}
                min={0}
                max={1}
                step={0.05}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
              <ChipPicker
                label="Blend"
                value={postProcess.tintBlendMode}
                onChange={(v) => updatePostProcess({ tintBlendMode: v as PanelColorGradeBlend })}
                options={[
                  { value: 'multiply', label: 'Multiply' },
                  { value: 'screen', label: 'Screen' },
                  { value: 'overlay', label: 'Overlay' },
                  { value: 'soft-light', label: 'Soft light' },
                ]}
              />
              <SubToggle
                label="Split-tone shadows"
                enabled={postProcess.tintShadowsEnabled}
                onToggle={() =>
                  updatePostProcess({ tintShadowsEnabled: !postProcess.tintShadowsEnabled })
                }
              >
                <HexInput
                  value={postProcess.tintShadows}
                  onChange={(v) => updatePostProcess({ tintShadows: v })}
                />
              </SubToggle>
              <SubToggle
                label="Split-tone highlights"
                enabled={postProcess.tintHighlightsEnabled}
                onToggle={() =>
                  updatePostProcess({
                    tintHighlightsEnabled: !postProcess.tintHighlightsEnabled,
                  })
                }
              >
                <HexInput
                  value={postProcess.tintHighlights}
                  onChange={(v) => updatePostProcess({ tintHighlights: v })}
                />
              </SubToggle>
              {(postProcess.tintShadowsEnabled || postProcess.tintHighlightsEnabled) && (
                <RangeRow
                  label="Split-tone strength"
                  value={postProcess.tintSplitStrength}
                  onChange={(v) => updatePostProcess({ tintSplitStrength: v })}
                  min={0}
                  max={1}
                  step={0.05}
                  fmt={(v) => `${Math.round(v * 100)}%`}
                />
              )}
            </OverlayCard>

            <OverlayCard
              title="Light leak"
              hint="Radial gradient anchored to one canvas edge."
              enabled={postProcess.lightLeakEnabled}
              onToggle={() =>
                updatePostProcess({ lightLeakEnabled: !postProcess.lightLeakEnabled })
              }
            >
              <ColorAndSlider
                label="Leak"
                color={postProcess.lightLeakColor}
                onColor={(v) => updatePostProcess({ lightLeakColor: v })}
                value={postProcess.lightLeakIntensity}
                onValue={(v) => updatePostProcess({ lightLeakIntensity: v })}
                min={0}
                max={1}
                step={0.05}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
              <RangeRow
                label="Radius"
                value={postProcess.lightLeakRadius}
                onChange={(v) => updatePostProcess({ lightLeakRadius: v })}
                min={0.2}
                max={1}
                step={0.05}
                fmt={(v) => v.toFixed(2)}
              />
              <ChipPicker
                label="Position"
                value={postProcess.lightLeakPosition}
                onChange={(v) =>
                  updatePostProcess({ lightLeakPosition: v as PanelLightLeakPosition })
                }
                options={[
                  { value: 'top-left', label: '↖' },
                  { value: 'top', label: '↑' },
                  { value: 'top-right', label: '↗' },
                  { value: 'left', label: '←' },
                  { value: 'right', label: '→' },
                  { value: 'bottom-left', label: '↙' },
                  { value: 'bottom', label: '↓' },
                  { value: 'bottom-right', label: '↘' },
                ]}
              />
              <ChipPicker
                label="Blend"
                value={postProcess.lightLeakBlendMode}
                onChange={(v) =>
                  updatePostProcess({ lightLeakBlendMode: v as PanelColorGradeBlend })
                }
                options={[
                  { value: 'screen', label: 'Screen' },
                  { value: 'multiply', label: 'Multiply' },
                  { value: 'overlay', label: 'Overlay' },
                  { value: 'soft-light', label: 'Soft light' },
                ]}
              />
            </OverlayCard>

            <OverlayCard
              title="Inner glow"
              hint="Radial brightening at canvas centre."
              enabled={postProcess.innerGlowEnabled}
              onToggle={() =>
                updatePostProcess({ innerGlowEnabled: !postProcess.innerGlowEnabled })
              }
            >
              <ColorAndSlider
                label="Glow"
                color={postProcess.innerGlowColor}
                onColor={(v) => updatePostProcess({ innerGlowColor: v })}
                value={postProcess.innerGlowIntensity}
                onValue={(v) => updatePostProcess({ innerGlowIntensity: v })}
                min={0}
                max={1}
                step={0.05}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
              <RangeRow
                label="Radius"
                value={postProcess.innerGlowRadius}
                onChange={(v) => updatePostProcess({ innerGlowRadius: v })}
                min={0.3}
                max={1.5}
                step={0.05}
                fmt={(v) => v.toFixed(2)}
              />
              <ChipPicker
                label="Blend"
                value={postProcess.innerGlowBlendMode}
                onChange={(v) =>
                  updatePostProcess({ innerGlowBlendMode: v as PanelInnerGlowBlend })
                }
                options={[
                  { value: 'screen', label: 'Screen' },
                  { value: 'overlay', label: 'Overlay' },
                  { value: 'soft-light', label: 'Soft light' },
                ]}
              />
            </OverlayCard>

            <OverlayCard
              title="Dust & scratches"
              hint="Sparse film-stock specks. Deterministic seed for round-trip stability."
              enabled={postProcess.dustEnabled}
              onToggle={() => updatePostProcess({ dustEnabled: !postProcess.dustEnabled })}
            >
              <ColorAndSlider
                label="Specks"
                color={postProcess.dustColor}
                onColor={(v) => updatePostProcess({ dustColor: v })}
                value={postProcess.dustIntensity}
                onValue={(v) => updatePostProcess({ dustIntensity: v })}
                min={0}
                max={1}
                step={0.05}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
              <RangeRow
                label="Density"
                value={postProcess.dustDensity}
                onChange={(v) => updatePostProcess({ dustDensity: v })}
                min={0}
                max={1}
                step={0.05}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
              <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span>Seed</span>
                <input
                  type="number"
                  min={0}
                  max={9999}
                  step={1}
                  value={postProcess.dustSeed}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(v)) updatePostProcess({ dustSeed: v });
                  }}
                  className="w-16 px-1 py-0.5 rounded text-[10px]"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                  }}
                />
              </div>
            </OverlayCard>

            <OverlayCard
              title="Halftone"
              hint="Uniform dot pattern. Increase spacing for chunkier dots."
              enabled={postProcess.halftoneEnabled}
              onToggle={() => updatePostProcess({ halftoneEnabled: !postProcess.halftoneEnabled })}
            >
              <ColorAndSlider
                label="Dots"
                color={postProcess.halftoneColor}
                onColor={(v) => updatePostProcess({ halftoneColor: v })}
                value={postProcess.halftoneOpacity}
                onValue={(v) => updatePostProcess({ halftoneOpacity: v })}
                min={0}
                max={1}
                step={0.05}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
              <RangeRow
                label="Dot size"
                value={postProcess.halftoneDotSize}
                onChange={(v) => updatePostProcess({ halftoneDotSize: v })}
                min={0.5}
                max={10}
                step={0.1}
                fmt={(v) => `${v.toFixed(1)}px`}
              />
              <RangeRow
                label="Spacing"
                value={postProcess.halftoneSpacing}
                onChange={(v) => updatePostProcess({ halftoneSpacing: v })}
                min={2}
                max={40}
                step={1}
                fmt={(v) => `${Math.round(v)}px`}
              />
              <RangeRow
                label="Angle"
                value={postProcess.halftoneAngle}
                onChange={(v) => updatePostProcess({ halftoneAngle: v })}
                min={0}
                max={90}
                step={1}
                fmt={(v) => `${Math.round(v)}°`}
              />
              <ChipPicker
                label="Blend"
                value={postProcess.halftoneBlendMode}
                onChange={(v) =>
                  updatePostProcess({ halftoneBlendMode: v as PanelHalftoneBlend })
                }
                options={[
                  { value: 'multiply', label: 'Multiply' },
                  { value: 'screen', label: 'Screen' },
                  { value: 'overlay', label: 'Overlay' },
                  { value: 'soft-light', label: 'Soft light' },
                  { value: 'normal', label: 'Normal' },
                ]}
              />
            </OverlayCard>

            <OverlayCard
              title="Letterbox"
              hint="Crop bars on each canvas edge. Set independent thicknesses per side."
              enabled={postProcess.letterboxEnabled}
              onToggle={() =>
                updatePostProcess({ letterboxEnabled: !postProcess.letterboxEnabled })
              }
            >
              <div className="flex items-center gap-2 text-[10px]">
                <span style={{ color: 'var(--text-muted)' }}>Colour</span>
                <HexInput
                  value={postProcess.letterboxColor}
                  onChange={(v) => updatePostProcess({ letterboxColor: v })}
                />
              </div>
              <RangeRow
                label="Top"
                value={postProcess.letterboxTop}
                onChange={(v) => updatePostProcess({ letterboxTop: v })}
                min={0}
                max={240}
                step={1}
                fmt={(v) => `${Math.round(v)}px`}
              />
              <RangeRow
                label="Bottom"
                value={postProcess.letterboxBottom}
                onChange={(v) => updatePostProcess({ letterboxBottom: v })}
                min={0}
                max={240}
                step={1}
                fmt={(v) => `${Math.round(v)}px`}
              />
              <RangeRow
                label="Left"
                value={postProcess.letterboxLeft}
                onChange={(v) => updatePostProcess({ letterboxLeft: v })}
                min={0}
                max={240}
                step={1}
                fmt={(v) => `${Math.round(v)}px`}
              />
              <RangeRow
                label="Right"
                value={postProcess.letterboxRight}
                onChange={(v) => updatePostProcess({ letterboxRight: v })}
                min={0}
                max={240}
                step={1}
                fmt={(v) => `${Math.round(v)}px`}
              />
              <RangeRow
                label="Opacity"
                value={postProcess.letterboxOpacity}
                onChange={(v) => updatePostProcess({ letterboxOpacity: v })}
                min={0}
                max={1}
                step={0.05}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
            </OverlayCard>

            <OverlayCard
              title="Frame"
              hint="Outer stroke around the canvas. Solid / double / dashed."
              enabled={postProcess.frameEnabled}
              onToggle={() => updatePostProcess({ frameEnabled: !postProcess.frameEnabled })}
            >
              <div className="flex items-center gap-2 text-[10px]">
                <span style={{ color: 'var(--text-muted)' }}>Colour</span>
                <HexInput
                  value={postProcess.frameColor}
                  onChange={(v) => updatePostProcess({ frameColor: v })}
                />
              </div>
              <RangeRow
                label="Thickness"
                value={postProcess.frameThickness}
                onChange={(v) => updatePostProcess({ frameThickness: v })}
                min={1}
                max={40}
                step={1}
                fmt={(v) => `${Math.round(v)}px`}
              />
              <RangeRow
                label="Inset"
                value={postProcess.frameInset}
                onChange={(v) => updatePostProcess({ frameInset: v })}
                min={0}
                max={80}
                step={1}
                fmt={(v) => `${Math.round(v)}px`}
              />
              <ChipPicker
                label="Style"
                value={postProcess.frameStyle}
                onChange={(v) => updatePostProcess({ frameStyle: v as PanelFrameStyle })}
                options={[
                  { value: 'solid', label: 'Solid' },
                  { value: 'double', label: 'Double' },
                  { value: 'dashed', label: 'Dashed' },
                ]}
              />
            </OverlayCard>

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

          {/* Workspace — full-draft export / import via clipboard. Wraps
              the entire panel state (grid, cards, palette, uploads,
              post-process, title bar, font picker, etc.) in a versioned
              JSON envelope so users can back up, share, or transfer a
              draft between sessions. Format-specific: an N Levels draft
              cannot be imported here and vice-versa (the parser checks
              `type` strictly). */}
          <div>
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Draft
              </label>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const envelope: TopicCardGridDraftExportEnvelope = {
                        type: 'topic-card-grid-draft',
                        version: 1,
                        exportedAt: new Date().toISOString(),
                        draft: {
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
                        },
                      };
                      await navigator.clipboard.writeText(JSON.stringify(envelope, null, 2));
                      toast.success('Draft exported to clipboard');
                      console.info('[topic-card-grid panel draft export]', {
                        cards_count: cards?.length ?? 0,
                        uploads_count: Object.keys(uploads).length,
                        bytes: JSON.stringify(envelope).length,
                      });
                    } catch (err) {
                      toast.error('Could not export draft — clipboard access denied.');
                      console.warn('[topic-card-grid panel draft export] error', {
                        detail: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                  title="Copy the whole draft state (cards, palette, uploads, style, all settings) to clipboard"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      const draft = parseTopicCardGridDraftEnvelope(text);
                      if (!draft) {
                        toast.error('Clipboard does not contain a Topic Card Grid draft.');
                        console.info('[topic-card-grid panel draft import] rejected', {
                          length: text.length,
                        });
                        return;
                      }
                      // Apply the imported draft via the same setter
                      // sequence the restoredDraftState useEffect uses.
                      // Keeping this inline (rather than extracting into
                      // a shared function) avoids a refactor of the
                      // existing hydration logic — the cost is verbose
                      // duplication that's easy to spot if either path
                      // grows a new field.
                      setGridMode(draft.gridMode);
                      setPresetIdx(draft.presetIdx);
                      setCustomRows(draft.customRows);
                      setCustomCols(draft.customCols);
                      setFormatMode(draft.formatMode);
                      setPrefilledLabels(draft.prefilledLabels);
                      setImageModelId(draft.imageModelId);
                      setCardShape(draft.cardShape ?? 'square');
                      setUploads(draft.uploads ?? {});
                      setUploadFit(draft.uploadFit ?? {});
                      setUploadFilter(draft.uploadFilter ?? {});
                      setCards(draft.cards);
                      setPalette(draft.palette);
                      setNotesForImageModel(draft.notesForImageModel);
                      if (draft.style && STYLE_OPTIONS.some((o) => o.value === draft.style)) {
                        setStyle(draft.style);
                      }
                      if (typeof draft.styleFreeForm === 'string') setStyleFreeForm(draft.styleFreeForm);
                      if (typeof draft.labelSize === 'number' && Number.isFinite(draft.labelSize)) {
                        setLabelSize(Math.min(LABEL_SIZE_MAX, Math.max(LABEL_SIZE_MIN, draft.labelSize)));
                      }
                      if (typeof draft.fontId === 'string' && findFontById(draft.fontId)) {
                        setFontId(draft.fontId);
                      }
                      if (draft.postProcess) setPostProcess(coercePostProcessState(draft.postProcess));
                      if (draft.titleBar) setTitleBar(coerceTitleBarState(draft.titleBar));
                      toast.success('Draft imported');
                      console.info('[topic-card-grid panel draft import]', {
                        cards_count: draft.cards?.length ?? 0,
                        uploads_count: Object.keys(draft.uploads ?? {}).length,
                      });
                    } catch (err) {
                      toast.error('Could not import draft — clipboard access denied.');
                      console.warn('[topic-card-grid panel draft import] error', {
                        detail: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                  title="Hydrate the panel from a Topic Card Grid draft JSON in the clipboard"
                >
                  Import
                </button>
              </div>
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              Export copies the whole draft (cards, palette, uploads, style, all settings) as JSON.
              Import hydrates the panel from a previously-exported draft.
            </p>
          </div>

          {/* Saved style presets — workspace-scoped named versions of
              the Post-process + Title-bar settings. Load applies the
              preset's style to the current panel; Save snapshots the
              current style under a new name; Delete removes a preset
              from the workspace library. Different from Copy / Paste
              style (transient, current-session clipboard) in being
              persistent + shared across sessions and devices. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Saved presets
              </label>
              <button
                type="button"
                disabled={savingPreset}
                onClick={async () => {
                  const name = typeof window !== 'undefined'
                    ? window.prompt('Save current style as preset — pick a name (max 60 chars):')
                    : null;
                  if (!name || !name.trim()) return;
                  setSavingPreset(true);
                  try {
                    const res = await fetch('/api/thumbnails/format/topic-card-grid/saved-presets', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        name: name.trim(),
                        preset: { postProcess, titleBar },
                      }),
                    });
                    if (res.status === 409) {
                      toast.error('A preset with that name already exists.');
                      return;
                    }
                    if (!res.ok) {
                      const data = await res.json().catch(() => ({})) as { error?: string };
                      toast.error(data.error || `Save failed (${res.status})`);
                      return;
                    }
                    toast.success(`Preset "${name.trim()}" saved`);
                    console.info('[topic-card-grid panel saved-preset save]', {
                      name: name.trim(),
                      post_process_filter: postProcess.filter,
                      title_bar_enabled: titleBar.enabled,
                    });
                    await refreshPresets();
                  } catch (err) {
                    toast.error('Save failed.');
                    console.warn('[topic-card-grid panel saved-preset save] error', {
                      detail: err instanceof Error ? err.message : String(err),
                    });
                  } finally {
                    setSavingPreset(false);
                  }
                }}
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  opacity: savingPreset ? 0.5 : 1,
                }}
              >
                {savingPreset ? 'Saving…' : 'Save current'}
              </button>
            </div>
            {loadingPresets ? (
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Loading presets…
              </p>
            ) : savedPresets.length === 0 ? (
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                No saved presets yet. &ldquo;Save current&rdquo; stores the active
                Post-process + Title-bar settings under a name you pick.
              </p>
            ) : (
              <ul className="space-y-1">
                {savedPresets.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2 px-2 py-1 rounded"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                  >
                    <span className="text-[11px] truncate" style={{ color: 'var(--text-secondary)' }} title={p.name}>
                      {p.name}
                    </span>
                    <div className="flex gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          // Apply the preset's style to the current
                          // panel. Both shape fields pass through their
                          // coerce helpers so a malformed payload from
                          // a stale schema degrades to defaults rather
                          // than throwing.
                          const raw = p.preset as { postProcess?: unknown; titleBar?: unknown } | null;
                          if (!raw || typeof raw !== 'object') {
                            toast.error('Preset payload is malformed.');
                            return;
                          }
                          setPostProcess(coercePostProcessState(raw.postProcess));
                          setTitleBar(coerceTitleBarState(raw.titleBar));
                          toast.success(`Loaded "${p.name}"`);
                          console.info('[topic-card-grid panel saved-preset load]', {
                            id: p.id,
                            name: p.name,
                          });
                        }}
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-secondary)',
                          border: '1px solid var(--border)',
                        }}
                        title={`Apply "${p.name}" to the current panel`}
                      >
                        Load
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (typeof window !== 'undefined' &&
                              !window.confirm(`Delete preset "${p.name}"? This can't be undone.`)) {
                            return;
                          }
                          try {
                            const res = await fetch(
                              `/api/thumbnails/format/topic-card-grid/saved-presets/${encodeURIComponent(p.id)}`,
                              { method: 'DELETE' },
                            );
                            if (!res.ok) {
                              toast.error('Delete failed.');
                              return;
                            }
                            toast.success(`Deleted "${p.name}"`);
                            console.info('[topic-card-grid panel saved-preset delete]', {
                              id: p.id,
                              name: p.name,
                            });
                            await refreshPresets();
                          } catch (err) {
                            toast.error('Delete failed.');
                            console.warn('[topic-card-grid panel saved-preset delete] error', {
                              detail: err instanceof Error ? err.message : String(err),
                            });
                          }
                        }}
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: 'var(--bg-secondary)',
                          color: '#ef4444',
                          border: '1px solid rgba(239,68,68,0.3)',
                        }}
                        title={`Delete "${p.name}"`}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
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
            previewImageUrl={previewImageUrl}
            previewLoading={previewLoading}
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
  /** r2.8+ live-preview data URL. When set, the image display swaps to
   *  it instead of `result.imageUrl` — lets the user see post-process /
   *  title-bar tweaks land in ~500 ms without a new AI render. */
  previewImageUrl: string | null;
  previewLoading: boolean;
}

/** Preview zoom presets (per Flex Icon Grid convention). Custom values
 *  via the slider land between presets; preset chips snap to known
 *  reference points. */
const PREVIEW_ZOOM_PRESETS = [0.5, 1, 1.5, 2, 3] as const;

function ResultState({ result, regionOverlayOn, onToggleOverlay, onEditCards, onRegenerateImage, busy, previewImageUrl, previewLoading }: ResultProps) {
  const aspect = result.outputHeight / result.outputWidth;
  // Preview zoom on the rendered image. 1.0 = fits container width
  // (default). Above 1.0 the inner image is wider than the outer
  // viewport, triggering horizontal scroll. Below 1.0 the image sits
  // centred at reduced size. State is ephemeral per ResultState mount —
  // a user who clicks "Edit cards" and comes back lands on 100% again,
  // which matches how Flex Icon Grid's preview zoom works in its own
  // unmount path.
  const [previewZoom, setPreviewZoom] = useState(1);
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

      {/* Zoom controls — preset chips + fine slider. Slider step matches
          Flex Icon Grid's 5% increments. */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div className="flex gap-1 flex-wrap">
            {PREVIEW_ZOOM_PRESETS.map((z) => {
              const active = Math.abs(previewZoom - z) < 0.001;
              return (
                <button
                  key={z}
                  type="button"
                  onClick={() => setPreviewZoom(z)}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                    color: active ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {Math.round(z * 100)}%
                </button>
              );
            })}
          </div>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {Math.round(previewZoom * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0.25}
          max={3}
          step={0.05}
          value={previewZoom}
          onChange={(e) => {
            const v = Number.parseFloat(e.target.value);
            if (Number.isFinite(v)) setPreviewZoom(v);
          }}
          className="w-full"
          style={{ accentColor: 'var(--accent-pink)' }}
        />
      </div>

      {/* Scrollable viewport. The outer div has overflow:auto so values
          above 100% trigger horizontal (and vertical, on very tall
          aspects) scroll. The inner div carries the aspect ratio and the
          zoom-scaled width — at 100% it fills the viewport, at 200% it's
          twice as wide. Below 100% the image sits centred via margin auto. */}
      <div
        className="rounded-lg"
        style={{
          border: '1px solid var(--border)',
          overflow: previewZoom > 1 ? 'auto' : 'hidden',
          background: 'var(--bg-card)',
        }}
      >
        <div
          className="relative"
          style={{
            width: `${Math.round(previewZoom * 100)}%`,
            aspectRatio: `${result.outputWidth} / ${result.outputHeight}`,
            margin: previewZoom < 1 ? '0 auto' : undefined,
          }}
        >
          <img
            src={previewImageUrl ?? result.imageUrl}
            alt="Generated thumbnail"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              // Subtle loading hint while the preview is being fetched —
              // the displayed image stays usable but signals "stale".
              opacity: previewLoading ? 0.75 : 1,
              transition: 'opacity 120ms ease-out',
            }}
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
