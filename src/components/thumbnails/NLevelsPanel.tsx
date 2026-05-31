'use client';

/**
 * N Levels Explained format — UI component for the /thumbnails page.
 *
 * Mirrors the architecture of TopicCardGridPanel: two-step flow with
 * mandatory user review by default, plus Pre-fill and One-shot shortcut
 * modes. State A is an editable level table; State B is the rendered image
 * with deterministic region overlay (one region per slice).
 *
 * See `_plans/2026-05-19-thumbnail-format-topic-card-grid.md` for the
 * shared pipeline contract (this file follows it).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { downloadHref } from '@/lib/download-file';
import {
  DEFAULT_FONT_ID,
  findFontById,
  fontBrowserUrl,
  THUMBNAIL_FONTS,
  THUMBNAIL_FONT_CATEGORIES,
  THUMBNAIL_FONT_CATEGORY_LABELS,
  type ThumbnailFont,
} from '@/lib/thumbnail-formats/topic-card-grid-fonts';
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
import {
  ThumbnailRenderer,
  type TitleBarRendererInput,
} from '@/components/thumbnails/ThumbnailRenderer';
import {
  FreeFormPreviewPanel,
  type FreeFormCellInput,
  type FreeFormCellState,
} from '@/components/thumbnails/_FreeFormPreviewPanel';
import type { PostProcessConfig } from '@/lib/thumbnail-formats/shared-overlay-pipeline';
import type { ThumbnailRegion } from '@/remotion/types';

// ─── Types mirroring the API contract ───────────────────────────────────────

export interface FormatLevel {
  level: number;
  label: string;
  illustration_concept: string;
  accent_color?: string;
  /** When true, the image model is instructed to use `accent_color` as the
   *  slice's dominant background at full saturation. When false / undefined,
   *  the color is a soft hint the model may freely reinterpret. Defaults to
   *  locked when the user adds a color via the "+ color" button; LLM-
   *  suggested colors come in unlocked. */
  accent_color_locked?: boolean;
}

/**
 * Snapshot of the panel's in-progress (pre-render) state. Saved into the
 * workflow draft so refreshing mid-edit returns the user to the editable
 * level list they were reviewing rather than starting over. The rendered
 * thumbnail itself lives in history, not the draft.
 */
export interface NLevelsDraftState {
  count: number;
  showBottomTitle: boolean;
  showLevelLabels: boolean;
  titleTopic: string;
  titleTagline: string;
  taglineEnabled: boolean;
  formatMode: 'review' | 'pre-fill' | 'one-shot';
  prefilledLabels: string;
  imageModelId: string;
  levels: FormatLevel[] | null;
  refinedTopic: string;
  notesForImageModel?: string;
  /** Post-process effects (filter / vignette / grain). Drafts saved
   *  before the Post-process section shipped restore with this field
   *  undefined, which the panel treats as "all effects off". */
  postProcess?: PanelPostProcessState;
  /** Title-bar overlay (text + position + typography + optional shadow).
   *  When this overlay is enabled, the route forces the LLM's
   *  `showBottomTitle` flag to false so the AI image leaves edge-to-edge
   *  slices and the overlay paints on top. Drafts saved before this
   *  section shipped restore with the field undefined. */
  titleBar?: PanelTitleBarState;
}

/** Image-filter ids understood by the post-process pipeline. Mirrored
 *  from `ImageFilter` in `src/lib/thumbnail-formats/shared-overlay-pipeline.ts`
 *  so this client component doesn't depend on a server-only module.
 *  Identical to the same-named type in TopicCardGridPanel — kept local
 *  per the format-panel convention (each panel duplicates its small
 *  client-side enums rather than sharing across format directories). */
export type PanelImageFilter =
  | 'grayscale'
  | 'sepia'
  | 'high-contrast'
  | 'low-contrast'
  | 'invert';

/** Panel-side shape for the Post-process section's state. Flat fields
 *  (not a nested vignette / grain object) because each control binds to
 *  one field — flat state is easier to debug + survives partial
 *  JSON-restore from older drafts cleanly. r2.8 ports 7 finishing
 *  overlays (tint, light-leak, inner-glow, dust, halftone, letterbox,
 *  frame) from TopicCardGridPanel so the two formats share the same
 *  post-process surface. The wire-shape builder collapses these back
 *  into the server's `PostProcessConfig` shape before sending. */
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
  // r2.8 finishing overlays — same shape as TopicCardGridPanel.
  tintEnabled: boolean;
  tintColor: string;
  tintIntensity: number;
  tintBlendMode: PanelColorGradeBlend;
  tintShadowsEnabled: boolean;
  tintShadows: string;
  tintHighlightsEnabled: boolean;
  tintHighlights: string;
  tintSplitStrength: number;
  lightLeakEnabled: boolean;
  lightLeakColor: string;
  lightLeakIntensity: number;
  lightLeakRadius: number;
  lightLeakPosition: PanelLightLeakPosition;
  lightLeakBlendMode: PanelColorGradeBlend;
  innerGlowEnabled: boolean;
  innerGlowColor: string;
  innerGlowIntensity: number;
  innerGlowRadius: number;
  innerGlowBlendMode: PanelInnerGlowBlend;
  dustEnabled: boolean;
  dustColor: string;
  dustIntensity: number;
  dustDensity: number;
  dustSeed: number;
  halftoneEnabled: boolean;
  halftoneColor: string;
  halftoneOpacity: number;
  halftoneDotSize: number;
  halftoneSpacing: number;
  halftoneBlendMode: PanelHalftoneBlend;
  halftoneAngle: number;
  letterboxEnabled: boolean;
  letterboxColor: string;
  letterboxTop: number;
  letterboxBottom: number;
  letterboxLeft: number;
  letterboxRight: number;
  letterboxOpacity: number;
  frameEnabled: boolean;
  frameColor: string;
  frameThickness: number;
  frameInset: number;
  frameStyle: PanelFrameStyle;
}

/** Default Post-process state. Every effect off, sensible mid-values
 *  pre-filled so flipping a toggle on immediately produces a visible
 *  effect rather than landing on 0. */
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

/** Panel-side shape for the Title bar section's state. Identical to the
 *  same-named interface in TopicCardGridPanel — kept local per the
 *  format-panel convention. */
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
  /** 0 - 96 px. */
  shadowBlurPx: number;
  /** 0 - 1. */
  shadowOpacity: number;
  shadowColor: string;
}

export interface NLevelsGenerationResult {
  imageUrl: string;
  regions: ThumbnailRegion[];
  levels: FormatLevel[];
  count: number;
  /** Whether this generation included the grunge bottom title bar.
   *  When false, the slices fill the whole canvas and titleTopic /
   *  titleTagline are unused (kept on the type for shape stability). */
  showBottomTitle: boolean;
  /** Whether per-slice labels under each LEVEL N were rendered. When
   *  false, every slice renders as just "LEVEL N" regardless of any
   *  label text in the data. Per-slice labels are still preserved on the
   *  record so the user can flip the toggle back on without losing data. */
  showLevelLabels: boolean;
  titleTopic: string;
  titleTagline: string;
  mode: 'review' | 'pre-fill' | 'one-shot';
  formatImageModel: string;
  referenceImageUrl?: string;
  outputWidth: number;
  outputHeight: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const COUNT_PRESETS = [3, 5, 7, 10];

const IMAGE_MODELS = [
  { value: 'gpt-image-2-i2i', label: 'GPT Image 2 via Kie (recommended)' },
  { value: 'gpt-image-2-openai-i2i', label: 'GPT Image 2 via OpenAI (faster, emergency)' },
  { value: 'grok-imagine-i2i', label: 'Grok Imagine (image-to-image)' },
  { value: 'flux2-pro-i2i', label: 'Flux2 Pro (image-to-image)' },
  { value: 'flux2-flex-i2i', label: 'Flux2 Flex (image-to-image)' },
];

const REGION_OVERLAY_PREF_KEY = 'n_levels_region_overlay';
const IMAGE_MODEL_PREF_KEY = 'n_levels_default_image_model';
const BRIGHTNESS_PREF_KEY = 'n_levels_default_brightness';
const DETAIL_PREF_KEY = 'n_levels_default_detail';
/** Single localStorage key for the whole Post-process section. One JSON
 *  blob is cheaper to read / write than nine keys, and the panel only
 *  ever reads / writes the whole object, never individual fields. */
const POST_PROCESS_PREF_KEY = 'n_levels_default_post_process';
/** Single localStorage key for the whole Title-bar section. Same shape
 *  as POST_PROCESS_PREF_KEY — one JSON blob covers eighteen fields. */
const TITLE_BAR_PREF_KEY = 'n_levels_default_title_bar';

/** Default Title-bar state. Off by default; sensible defaults pre-filled
 *  so flipping on shows a working bar immediately. */
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

/** Post-process filter chips. `null` value = "no filter" (renders as a
 *  selected chip when nothing else is picked). Order chosen so the
 *  most common picks (None, Grayscale, Sepia) sit first. */
const POST_PROCESS_FILTER_OPTIONS: { value: PanelImageFilter | null; label: string }[] = [
  { value: null, label: 'None' },
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'high-contrast', label: 'High contrast' },
  { value: 'low-contrast', label: 'Low contrast' },
  { value: 'invert', label: 'Invert' },
];

/** Coerce a raw localStorage JSON read back into a `PanelPostProcessState`.
 *  Defends against partial / corrupt payloads by clamping every numeric
 *  field and dropping unknown filter ids — same forgiving shape the
 *  server's `parsePostProcessConfig` uses. */
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

/** Title-bar position chips. Human-readable labels (e.g. "Top overlay"
 *  for the internal "overlay-top"). Same surface as the
 *  TopicCardGridPanel sibling. */
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
 *  Identical logic to the same-named helper in TopicCardGridPanel —
 *  kept local per the format-panel convention. */
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

/** Clipboard envelope shape for "thumbnail style" payloads. Identical
 *  to `ThumbnailStyleClipboardEnvelope` in TopicCardGridPanel — both
 *  panels share the same wire shape so a Copy from one pastes into the
 *  other. Kept local per the format-panel convention. */
export interface ThumbnailStyleClipboardEnvelope {
  type: 'thumbnail-style';
  version: 1;
  postProcess: PanelPostProcessState;
  titleBar: PanelTitleBarState;
}

/** Clipboard envelope shape for full-draft export. Wraps a complete
 *  `NLevelsDraftState` in a versioned object. Format-specific (NOT
 *  shareable with the Topic Card Grid envelope) because N Levels drafts
 *  carry level lists, title topic, tagline — fields a card-grid draft
 *  doesn't have. */
export interface NLevelsDraftExportEnvelope {
  type: 'n-levels-draft';
  version: 1;
  exportedAt: string;
  draft: NLevelsDraftState;
}

/** Parse a full-draft clipboard payload. Returns null when the payload
 *  is not a recognised N Levels draft envelope. */
export function parseNLevelsDraftEnvelope(raw: string): NLevelsDraftState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (r.type !== 'n-levels-draft') return null;
  if (r.version !== 1) return null;
  if (!r.draft || typeof r.draft !== 'object') return null;
  return r.draft as NLevelsDraftState;
}

/** Build a clipboard envelope from the current panel style. */
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
 *  the payload is not a recognised thumbnail-style envelope. */
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

/** Panel-side shape of a saved-preset list-item from the server.
 *  Identical to the same-named interface in TopicCardGridPanel — kept
 *  local per the format-panel convention. */
export interface SavedPresetSummary {
  id: string;
  name: string;
  preset: unknown;
  updated_at: string;
}

/** Build the wire-shape `titleBar` payload from the panel's state.
 *  Returns `undefined` when the bar is disabled or has no text. */
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

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  title: string;
  niche: string;
  script: string;
  description: string;
  modelId: string;
  referenceImageUrl: string;
  onResultChange: (result: NLevelsGenerationResult | null) => void;
  restoredResult?: NLevelsGenerationResult | null;
  /** Titles the user picked from the script textarea (page-level picker).
   *  When the count matches the level count, the next Step 1 run uses
   *  these as pre-fill labels verbatim. Empty = picker unused. */
  pickedLabels?: string[];
  /** Called whenever the panel's serializable in-progress state changes.
   *  The page funnels this into the workflow draft so a refresh
   *  mid-review restores the editable level list. */
  onDraftStateChange?: (state: NLevelsDraftState) => void;
  /** One-shot hydration payload from the workflow draft. When provided,
   *  the panel restores its in-progress state from this snapshot on
   *  mount. Distinct from `restoredResult`, which restores a rendered
   *  history entry. */
  restoredDraftState?: NLevelsDraftState | null;
}

export function NLevelsPanel({
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
  // Level count
  const [count, setCount] = useState(7);

  // Phase B4: Free-form mode — bypasses the AI entirely. The user picks
  // per-level content (emoji + bg colour) and the panel renders the
  // slices client-side via `<ThumbnailRenderer cells={…}>`. Same shape
  // as TopicCardGridPanel's `renderMode`. Persisted to localStorage.
  const [renderMode, setRenderMode] = useState<'ai' | 'free-form'>(() => {
    if (typeof window === 'undefined') return 'ai';
    const stored = localStorage.getItem('n_levels_render_mode');
    return stored === 'free-form' ? 'free-form' : 'ai';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('n_levels_render_mode', renderMode);
    } catch {
      /* ignore */
    }
  }, [renderMode]);
  const [freeFormLevels, setFreeFormLevels] = useState<
    Record<number, FreeFormCellState>
  >({});
  function updateFreeFormLevel(levelIndex: number, patch: Partial<FreeFormCellState>) {
    setFreeFormLevels((prev) => {
      const existing =
        prev[levelIndex] ??
        ({
          emoji: '',
          bgColor: '#ffffff',
          emojiRotation: 0,
          emojiFlipX: false,
          emojiFlipY: false,
          emojiOffsetX: 0,
          emojiOffsetY: 0,
        } satisfies FreeFormCellState);
      return { ...prev, [levelIndex]: { ...existing, ...patch } };
    });
  }
  // Bottom title bar — defaults OFF because the most successful "N Levels
  // of" thumbnails on YouTube run without one (just slices filling the
  // canvas). When the user wants the grunge-title style, they flip this
  // on and the topic / tagline fields appear.
  const [showBottomTitle, setShowBottomTitle] = useState(false);
  // Global toggle for per-slice labels (e.g. "PASSIVE RECONNAISSANCE"
  // under "LEVEL 1"). Default ON. Flip OFF for the bare "LEVEL 1, LEVEL 2,
  // ..." style where each slice is just its number + the illustration.
  // Per-slice label data is preserved when the toggle is off — flipping
  // it back on restores the labels without re-running Step 1.
  const [showLevelLabels, setShowLevelLabels] = useState(true);
  const [titleTopic, setTitleTopic] = useState('');
  const [titleTagline, setTitleTagline] = useState('EXPLAINED');
  const [taglineEnabled, setTaglineEnabled] = useState(true);

  // Format mode
  const [formatMode, setFormatMode] = useState<'review' | 'pre-fill' | 'one-shot'>('review');
  const [prefilledLabels, setPrefilledLabels] = useState('');

  // Image model — defaults to gpt-image-2-i2i but auto-remembers the user's
  // last choice in localStorage so their personal default sticks.
  const [imageModelId, setImageModelId] = useState<string>(() => {
    if (typeof window === 'undefined') return 'gpt-image-2-i2i';
    try {
      const stored = localStorage.getItem(IMAGE_MODEL_PREF_KEY);
      if (stored && IMAGE_MODELS.some((m) => m.value === stored)) return stored;
    } catch {
      /* fall through */
    }
    return 'gpt-image-2-i2i';
  });
  useEffect(() => {
    try { localStorage.setItem(IMAGE_MODEL_PREF_KEY, imageModelId); } catch { /* ignore */ }
  }, [imageModelId]);

  // Brightness / detail knobs. Defaults shift to bright + clean —
  // bright explicitly kills the "later slices fade darker" pattern.
  // Persisted to localStorage so a repeat user lands back in their
  // preferred register without re-picking each session.
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
  // Identical pattern to TopicCardGridPanel's savedPresets state.
  const [savedPresets, setSavedPresets] = useState<SavedPresetSummary[]>([]);
  const [loadingPresets, setLoadingPresets] = useState(true);
  const [savingPreset, setSavingPreset] = useState(false);
  const refreshPresets = useCallback(async () => {
    try {
      const res = await fetch('/api/thumbnails/format/n-levels/saved-presets');
      if (!res.ok) {
        console.warn('[n-levels panel saved-presets fetch] not_ok', { status: res.status });
        setSavedPresets([]);
        return;
      }
      const data = await res.json() as { presets?: SavedPresetSummary[] };
      setSavedPresets(Array.isArray(data.presets) ? data.presets : []);
    } catch (err) {
      console.warn('[n-levels panel saved-presets fetch] error', {
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

  // Title-bar overlay state. When enabled, the route forces
  // `showBottomTitle: false` on the LLM prompt so the AI image leaves
  // edge-to-edge slices and the overlay paints on top. The UI shows a
  // small note when both the LLM-baked toggle and the overlay are on
  // so the user knows which one wins.
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
  const selectedTitleFont: ThumbnailFont = findFontById(titleBar.fontId) ?? findFontById(DEFAULT_FONT_ID)!;

  // Flow state
  const [busyStep, setBusyStep] = useState<'idle' | 'list' | 'image'>('idle');
  const [levels, setLevels] = useState<FormatLevel[] | null>(null);
  const [refinedTopic, setRefinedTopic] = useState('');
  const [notesForImageModel, setNotesForImageModel] = useState<string | undefined>();
  const [result, setResult] = useState<NLevelsGenerationResult | null>(null);
  // r2.8+ live preview — mirrors the TopicCardGridPanel wiring.
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const previewAbortRef = useRef<AbortController | null>(null);

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
            console.warn('[n-levels preview]', { status: res.status, detail });
            return;
          }
          const data = (await res.json()) as { imageUrl?: string };
          if (typeof data.imageUrl === 'string') setPreviewImageUrl(data.imageUrl);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          console.warn('[n-levels preview]', { detail: String(err) });
        })
        .finally(() => {
          if (previewAbortRef.current === ctrl) setPreviewLoading(false);
        });
    }, 400);
    return () => clearTimeout(handle);
  }, [postProcess, titleBar, result]);

  // Hydrate from history-restored result.
  useEffect(() => {
    if (!restoredResult) return;
    setCount(restoredResult.count);
    setShowBottomTitle(restoredResult.showBottomTitle);
    setShowLevelLabels(restoredResult.showLevelLabels);
    setTitleTopic(restoredResult.titleTopic);
    setTitleTagline(restoredResult.titleTagline);
    setTaglineEnabled(restoredResult.titleTagline.length > 0);
    setFormatMode(restoredResult.mode);
    setImageModelId(restoredResult.formatImageModel);
    setLevels(restoredResult.levels);
    setRefinedTopic(restoredResult.titleTopic);
    setResult(restoredResult);
  }, [restoredResult]);

  // Hydrate the in-progress (pre-render) state from the workflow draft.
  // Re-runs whenever the parent supplies a new non-null snapshot
  // reference. The parent only changes the reference on explicit
  // hydration triggers (mount, resumeDraft) — never on the panel's own
  // writeback — so this can't loop. Distinct from the `restoredResult`
  // path above: that brings back a fully-rendered history entry; this
  // restores mid-review work so a refresh doesn't blow away an edited
  // level list.
  const lastHydratedRef = useRef<NLevelsDraftState | null>(null);
  useEffect(() => {
    if (!restoredDraftState) return;
    if (lastHydratedRef.current === restoredDraftState) return;
    lastHydratedRef.current = restoredDraftState;
    setCount(restoredDraftState.count);
    setShowBottomTitle(restoredDraftState.showBottomTitle);
    setShowLevelLabels(restoredDraftState.showLevelLabels);
    setTitleTopic(restoredDraftState.titleTopic);
    setTitleTagline(restoredDraftState.titleTagline);
    setTaglineEnabled(restoredDraftState.taglineEnabled);
    setFormatMode(restoredDraftState.formatMode);
    setPrefilledLabels(restoredDraftState.prefilledLabels);
    setImageModelId(restoredDraftState.imageModelId);
    setLevels(restoredDraftState.levels);
    setRefinedTopic(restoredDraftState.refinedTopic);
    setNotesForImageModel(restoredDraftState.notesForImageModel);
    if (restoredDraftState.postProcess) {
      // coerce so an older draft with a partial / corrupt payload
      // doesn't poison the panel state. Same path the localStorage
      // boot reads through.
      setPostProcess(coercePostProcessState(restoredDraftState.postProcess));
    }
    if (restoredDraftState.titleBar) {
      setTitleBar(coerceTitleBarState(restoredDraftState.titleBar));
    }
    console.info('[n-levels panel draft] hydrated', {
      level_count: restoredDraftState.levels?.length ?? 0,
      has_refined_topic: !!restoredDraftState.refinedTopic,
      format_mode: restoredDraftState.formatMode,
    });
  }, [restoredDraftState]);

  // Report serializable in-progress state to the parent on every change
  // so the page can fold it into the workflow draft and survive a
  // refresh. Cheap: just a synchronous callback with primitive values
  // (plus a level-list reference). The parent debounces before writing.
  useEffect(() => {
    if (!onDraftStateChange) return;
    onDraftStateChange({
      count,
      showBottomTitle,
      showLevelLabels,
      titleTopic,
      titleTagline,
      taglineEnabled,
      formatMode,
      prefilledLabels,
      imageModelId,
      levels,
      refinedTopic,
      notesForImageModel,
      postProcess,
      titleBar,
    });
  }, [
    count, showBottomTitle, showLevelLabels, titleTopic, titleTagline,
    taglineEnabled, formatMode, prefilledLabels, imageModelId, levels,
    refinedTopic, notesForImageModel, postProcess, titleBar,
    onDraftStateChange,
  ]);

  // Region overlay preference
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

  // Pre-fill validation
  const prefilledLabelsList = prefilledLabels
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const canGenerateList =
    !!title.trim() &&
    !!niche.trim() &&
    (!showBottomTitle || !!titleTopic.trim()) &&
    !!referenceImageUrl.trim() &&
    count >= 2 &&
    (formatMode !== 'pre-fill' || prefilledLabelsList.length === count);

  // The image step accepts any non-empty levels list — the user may have
  // deleted slices in the review step to render a subset (e.g. "level 1
  // and level 7" only). Labels are optional. The only hard requirement
  // is that every surviving slice has an illustration_concept.
  const canRenderImage = !!levels && levels.length >= 1 && levels.every((l) => l.illustration_concept.trim());

  // ─── Actions ──────────────────────────────────────────────────────────────

  async function runStep1() {
    if (!canGenerateList) {
      if (!referenceImageUrl.trim()) {
        toast.error('Upload a reference image first — it locks the layout for this format.');
      } else if (showBottomTitle && !titleTopic.trim()) {
        toast.error('Enter a title topic (the words after "[N] LEVELS OF") or turn off the bottom title bar.');
      } else if (formatMode === 'pre-fill' && prefilledLabelsList.length !== count) {
        toast.error(`Pre-fill mode needs exactly ${count} labels (one per line). You have ${prefilledLabelsList.length}.`);
      } else {
        toast.error('Title, niche, and a reference image are required.');
      }
      return;
    }
    // Picked labels override the formatMode chip when their count matches
    // the level count — guarantees zero label paraphrasing.
    const usePicked = pickedLabels.length === count;
    const effectiveMode = usePicked ? 'pre-fill' : formatMode;
    const effectivePrefill = usePicked
      ? pickedLabels
      : (formatMode === 'pre-fill' ? prefilledLabelsList : undefined);

    console.info('[thumbnails format-n-levels list] requesting', {
      count, modelId, mode: effectiveMode, usingPickedLabels: usePicked,
    });
    setBusyStep('list');
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/thumbnails/format/n-levels/levels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          title: title.trim(),
          niche,
          script: script.trim() || undefined,
          description: description.trim() || undefined,
          count,
          showBottomTitle,
          titleTopic: showBottomTitle ? titleTopic.trim() : '',
          titleTagline: showBottomTitle && taglineEnabled ? titleTagline.trim() : '',
          mode: effectiveMode,
          prefilledLabels: effectivePrefill,
          referenceImageUrl: referenceImageUrl.trim(),
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data.error || `Level list generation failed (${res.status})`);
      }
      const data: { result: { levels: FormatLevel[]; title_topic: string; title_tagline: string; notes_for_image_model?: string } } = await res.json();
      console.info('[thumbnails format-n-levels list] received', { levelsCount: data.result.levels.length, refinedTopic: data.result.title_topic });
      setLevels(data.result.levels);
      setRefinedTopic(data.result.title_topic);
      setNotesForImageModel(data.result.notes_for_image_model);
      if (formatMode === 'one-shot') {
        await runStep2(data.result.levels, data.result.title_topic, data.result.title_tagline, data.result.notes_for_image_model);
        return;
      }
      toast.success(`Generated ${data.result.levels.length} level${data.result.levels.length === 1 ? '' : 's'} — review and edit before rendering.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Level list generation failed.');
    } finally {
      setBusyStep('idle');
    }
  }

  async function runStep2(
    levelsToUse: FormatLevel[] | null = levels,
    topicToUse: string = showBottomTitle ? (refinedTopic || titleTopic) : '',
    taglineToUse: string = showBottomTitle && taglineEnabled ? titleTagline : '',
    notesToUse: string | undefined = notesForImageModel,
  ) {
    if (!levelsToUse) {
      toast.error('Generate the level list first.');
      return;
    }
    if (levelsToUse.length !== count) {
      toast.error(`Level count (${levelsToUse.length}) does not match (${count}). Adjust before rendering.`);
      return;
    }
    console.info('[thumbnails format-n-levels image] requesting', {
      count: levelsToUse.length,
      imageModelId,
    });
    setBusyStep('image');
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/thumbnails/format/n-levels/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageModelId,
          levels: levelsToUse,
          count,
          showBottomTitle,
          showLevelLabels,
          titleTopic: topicToUse,
          titleTagline: taglineToUse,
          notesForImageModel: notesToUse,
          referenceImageUrl: referenceImageUrl.trim(),
          brightness,
          detail: detailLevel,
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
      } = await res.json();
      console.info('[thumbnails format-n-levels image] received', {
        imageUrl: data.imageUrl,
        regionsCount: data.regions.length,
      });
      const generation: NLevelsGenerationResult = {
        imageUrl: data.imageUrl,
        regions: data.regions,
        levels: levelsToUse,
        count,
        showBottomTitle,
        showLevelLabels,
        titleTopic: topicToUse,
        titleTagline: taglineToUse,
        mode: formatMode,
        formatImageModel: imageModelId,
        referenceImageUrl: referenceImageUrl.trim() || undefined,
        outputWidth: data.layout.width,
        outputHeight: data.layout.height,
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

  function updateLevel(idx: number, patch: Partial<FormatLevel>) {
    setLevels((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function moveLevel(idx: number, dir: -1 | 1) {
    setLevels((prev) => {
      if (!prev) return prev;
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      // Level numbers TRAVEL with the slice content — no auto-renumber.
      // Users can have non-sequential numbers like [1, 7] for "level 1
      // and level 7" thumbnails; reorder must preserve their numbering.
      return next;
    });
  }

  /** Delete a slice. Surviving slices keep their level numbers — so if
   *  you drop levels 2-6 from a 7-slice run, the remaining slices stay
   *  labelled "LEVEL 1" and "LEVEL 7" rather than collapsing to 1, 2. */
  function deleteLevel(idx: number) {
    setLevels((prev) => {
      if (!prev) return prev;
      if (prev.length <= 1) {
        toast.error('At least one level is required.');
        return prev;
      }
      return prev.filter((_, i) => i !== idx);
    });
  }

  /** Re-sequence remaining slices as 1, 2, 3, ... — convenience for users
   *  who want to reset to a clean ascending sequence after editing. */
  function renumberLevels() {
    setLevels((prev) => prev?.map((l, i) => ({ ...l, level: i + 1 })) ?? null);
  }

  function clearList() {
    if (levels && !confirm('Discard the current level list and regenerate?')) return;
    setLevels(null);
    setRefinedTopic('');
    setNotesForImageModel(undefined);
    setResult(null);
    onResultChange(null);
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex gap-6" style={{ alignItems: 'flex-start' }}>
      {/* LEFT PANEL — format controls */}
      <div className="shrink-0" style={{ width: 380 }}>
        <div className="glass p-5 space-y-4" style={{ borderColor: 'rgba(124,58,237,0.2)' }}>
          {/* Phase B4: AI vs Free-form mode toggle. Free-form bypasses
              the AI image model entirely and renders the slices
              client-side from per-level emoji + bg colour. */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Render mode
            </label>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setRenderMode('ai')}
                className="px-3 py-1 rounded text-xs"
                style={{
                  background: renderMode === 'ai' ? 'var(--accent-purple-bright)' : 'var(--bg-secondary)',
                  color: renderMode === 'ai' ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
                aria-pressed={renderMode === 'ai'}
              >
                AI mode
              </button>
              <button
                type="button"
                onClick={() => setRenderMode('free-form')}
                className="px-3 py-1 rounded text-xs"
                style={{
                  background: renderMode === 'free-form' ? 'var(--accent-purple-bright)' : 'var(--bg-secondary)',
                  color: renderMode === 'free-form' ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
                aria-pressed={renderMode === 'free-form'}
              >
                Free-form ⚡
              </button>
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {renderMode === 'ai'
                ? 'AI generates illustrations from your level concepts (default).'
                : 'You pick an emoji + colour per level. Renders instantly, no AI.'}
            </p>
          </div>

          {/* Count */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Number of levels
            </label>
            <div className="flex items-center gap-1.5">
              {COUNT_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => setCount(n)}
                  className="text-[11px] px-2.5 py-1 rounded transition-all"
                  style={{
                    background: count === n ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
                    border: `1px solid ${count === n ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
                    color: count === n ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                  }}
                >
                  {n}
                </button>
              ))}
              <input
                type="number"
                min={2}
                value={count}
                onChange={(e) => setCount(Math.max(2, Number(e.target.value) || 2))}
                className="input-field w-16 text-xs"
              />
            </div>
            {count > 10 && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--accent-yellow)' }}>
                Above 10 slices, each slice gets too thin to read clearly.
              </p>
            )}
          </div>

          {/* Bottom title bar — off by default (matches the most successful
              N LEVELS thumbnails on YouTube which just have slices). When
              on, the topic + tagline fields appear and the rendered image
              gets the grunge "N LEVELS OF [TOPIC] [EXPLAINED]" bar. */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={showBottomTitle}
                onChange={(e) => setShowBottomTitle(e.target.checked)}
                style={{ accentColor: 'var(--accent-pink)' }}
              />
              Show bottom title bar (grunge &quot;N LEVELS OF [TOPIC]&quot; strip)
            </label>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Most successful N Levels thumbnails on YouTube run without one — slices fill the whole canvas. Turn this on for the grunge-title variant.
            </p>
          </div>

          {/* Global toggle: render labels (PASSIVE RECONNAISSANCE, etc.)
              under each LEVEL N heading or just render LEVEL N alone.
              Default ON; flip OFF for the bare "LEVEL 1, LEVEL 2, ..."
              style. Per-slice label data is preserved either way. */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={showLevelLabels}
                onChange={(e) => setShowLevelLabels(e.target.checked)}
                style={{ accentColor: 'var(--accent-pink)' }}
              />
              Show labels under each LEVEL N
            </label>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Off = bare &quot;LEVEL 1, LEVEL 2, …&quot; with no subtitle. Your per-slice label text is preserved either way; toggle it back on any time.
            </p>
          </div>

          {showBottomTitle && (
            <>
              {/* Title topic */}
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Title topic <span style={{ color: 'var(--text-muted)' }}>(the bit after &quot;{count} LEVELS OF&quot;)</span>
                </label>
                <input
                  className="input-field w-full text-sm"
                  placeholder="CYBER SECURITY BREACHES"
                  value={titleTopic}
                  onChange={(e) => setTitleTopic(e.target.value)}
                  maxLength={60}
                />
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Bottom bar will read &quot;{count} LEVELS OF {titleTopic || '...'}{taglineEnabled && titleTagline ? ` [${titleTagline}]` : ''}&quot;.
                </p>
              </div>

              {/* Tagline */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={taglineEnabled}
                    onChange={(e) => setTaglineEnabled(e.target.checked)}
                    style={{ accentColor: 'var(--accent-pink)' }}
                  />
                  Tagline (red box below the topic)
                </label>
                {taglineEnabled && (
                  <input
                    className="input-field w-full text-xs mt-2"
                    placeholder="EXPLAINED"
                    value={titleTagline}
                    onChange={(e) => setTitleTagline(e.target.value)}
                    maxLength={30}
                  />
                )}
              </div>
            </>
          )}

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
                OpenAI direct — synchronous, ~20–60s, no polling timeouts. Same GPT Image 2 model as the Kie path, different route.
              </p>
            )}
            {imageModelId !== 'gpt-image-2-i2i' && imageModelId !== 'gpt-image-2-openai-i2i' && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--accent-yellow)' }}>
                This format is calibrated for GPT Image 2. Other models will produce a different style and likely mangle the grunge typography.
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
              Bright (default) keeps every slice equally bright — kills the dark-fade pattern. Moody allows cinematic darker slices for editorial niches.
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
              Clean (default) favours one iconic subject per slice. Detailed allows photoreal scenes for users who want the older look.
            </p>
          </div>

          {/* Post-process — vignette, grain, and image filters that run
              AFTER the AI image returns. Cheap to tweak: no AI re-render
              required, each change re-runs only the server-side Sharp
              pipeline. Three sub-sections: Filter (chip row), Vignette
              (toggle + color/intensity/radius), Grain (toggle + intensity/
              size + monochrome). All effects default to off. Mirrors the
              identical section in TopicCardGridPanel so the user gets the
              same controls regardless of which format they're working in. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Post-process
              </label>
              {/* Copy / Paste style — clipboard envelope covering BOTH
                  post-process and title-bar state. Cross-format
                  compatible with TopicCardGridPanel (same envelope shape)
                  so a style copied in either panel pastes cleanly in
                  the other. */}
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const envelope = buildStyleClipboardEnvelope(postProcess, titleBar);
                      await navigator.clipboard.writeText(JSON.stringify(envelope));
                      toast.success('Style copied to clipboard');
                      console.info('[n-levels panel style copy]', {
                        post_process_filter: postProcess.filter,
                        post_process_vignette: postProcess.vignetteEnabled,
                        post_process_grain: postProcess.grainEnabled,
                        title_bar_enabled: titleBar.enabled,
                      });
                    } catch (err) {
                      toast.error('Could not copy style — clipboard access denied.');
                      console.warn('[n-levels panel style copy] error', {
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
                        console.info('[n-levels panel style paste] rejected', {
                          length: text.length,
                        });
                        return;
                      }
                      setPostProcess(parsed.postProcess);
                      setTitleBar(parsed.titleBar);
                      toast.success('Style pasted');
                      console.info('[n-levels panel style paste]', {
                        post_process_filter: parsed.postProcess.filter,
                        post_process_vignette: parsed.postProcess.vignetteEnabled,
                        post_process_grain: parsed.postProcess.grainEnabled,
                        title_bar_enabled: parsed.titleBar.enabled,
                      });
                    } catch (err) {
                      toast.error('Could not paste style — clipboard access denied.');
                      console.warn('[n-levels panel style paste] error', {
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
                        console.info('[n-levels panel post-process filter change]', {
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
                    console.info('[n-levels panel post-process vignette toggle]', {
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
                    console.info('[n-levels panel post-process grain toggle]', {
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

            {/* r2.8: seven finishing overlays ported from TopicCardGridPanel.
                Sub-components from _overlay-controls.tsx so the markup stays
                declarative. Finishing presets sit above the 7 cards for
                one-click "vintage film" / "cinematic 2.39" / etc. */}
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

          {/* Title bar overlay — Sharp-rendered text band drawn on top
              of the AI image. When this overlay is enabled, the server
              forces the LLM's `showBottomTitle` to false so the AI
              leaves edge-to-edge slices and the overlay paints on top
              instead of doubling up with the LLM-baked bar.

              N Levels-specific UX: the existing "Bottom title bar"
              toggle higher up the panel keeps the LLM-baked grunge
              title look (a different aesthetic). The overlay below
              draws a clean rectangular text band. When both are on,
              the overlay wins and we surface a callout so the user
              understands. */}
          <div>
            {/* @font-face declarations for every bundled font, injected
                once here so the dropdown can render each option in its
                own typeface even without a sibling Font section. */}
            <style>{THUMBNAIL_FONTS.map((f) => `@font-face { font-family: '${f.family}'; src: url('${fontBrowserUrl(f)}') format('woff2'); font-display: swap; }`).join('\n')}</style>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Title bar overlay
              </label>
              <button
                type="button"
                onClick={() => {
                  console.info('[n-levels panel title-bar toggle]', {
                    from: titleBar.enabled,
                    to: !titleBar.enabled,
                    llm_baked_title_on: showBottomTitle,
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
            {titleBar.enabled && showBottomTitle && (
              <p
                className="text-[10px] mb-2 px-2 py-1 rounded"
                style={{
                  color: 'var(--accent-yellow)',
                  background: 'rgba(255, 200, 0, 0.08)',
                  border: '1px solid rgba(255, 200, 0, 0.2)',
                }}
              >
                Overlay is on. The LLM&apos;s &ldquo;Bottom title bar&rdquo; toggle above is
                ignored — the AI image will render edge-to-edge slices and this
                overlay paints over the top.
              </p>
            )}
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
                    placeholder="N LEVELS OF X"
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
                    placeholder="EXPLAINED"
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

                {/* Colours */}
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

                {/* Font picker. Reuses the THUMBNAIL_FONTS registry +
                    @font-face declarations injected above. */}
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
                    style={{ fontFamily: `'${selectedTitleFont.family}', system-ui, sans-serif` }}
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

                {/* Subtitle font — only when subtitle has content */}
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

                {/* Shadow toggle + sliders */}
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

          {/* Workspace — full-draft export / import via clipboard.
              Format-specific envelope (type: 'n-levels-draft') so a
              Topic Card Grid draft can't be imported here by mistake. */}
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
                      const envelope: NLevelsDraftExportEnvelope = {
                        type: 'n-levels-draft',
                        version: 1,
                        exportedAt: new Date().toISOString(),
                        draft: {
                          count,
                          showBottomTitle,
                          showLevelLabels,
                          titleTopic,
                          titleTagline,
                          taglineEnabled,
                          formatMode,
                          prefilledLabels,
                          imageModelId,
                          levels,
                          refinedTopic,
                          notesForImageModel,
                          postProcess,
                          titleBar,
                        },
                      };
                      await navigator.clipboard.writeText(JSON.stringify(envelope, null, 2));
                      toast.success('Draft exported to clipboard');
                      console.info('[n-levels panel draft export]', {
                        level_count: levels?.length ?? 0,
                        show_bottom_title: showBottomTitle,
                        bytes: JSON.stringify(envelope).length,
                      });
                    } catch (err) {
                      toast.error('Could not export draft — clipboard access denied.');
                      console.warn('[n-levels panel draft export] error', {
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
                  title="Copy the whole draft state (levels, title, style, all settings) to clipboard"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      const draft = parseNLevelsDraftEnvelope(text);
                      if (!draft) {
                        toast.error('Clipboard does not contain an N Levels draft.');
                        console.info('[n-levels panel draft import] rejected', {
                          length: text.length,
                        });
                        return;
                      }
                      // Inline setter sequence mirrors the
                      // restoredDraftState useEffect — see the
                      // TopicCardGridPanel comment for the trade-off
                      // (verbose vs. shared helper).
                      setCount(draft.count);
                      setShowBottomTitle(draft.showBottomTitle);
                      setShowLevelLabels(draft.showLevelLabels);
                      setTitleTopic(draft.titleTopic);
                      setTitleTagline(draft.titleTagline);
                      setTaglineEnabled(draft.taglineEnabled);
                      setFormatMode(draft.formatMode);
                      setPrefilledLabels(draft.prefilledLabels);
                      setImageModelId(draft.imageModelId);
                      setLevels(draft.levels);
                      setRefinedTopic(draft.refinedTopic);
                      setNotesForImageModel(draft.notesForImageModel);
                      if (draft.postProcess) setPostProcess(coercePostProcessState(draft.postProcess));
                      if (draft.titleBar) setTitleBar(coerceTitleBarState(draft.titleBar));
                      toast.success('Draft imported');
                      console.info('[n-levels panel draft import]', {
                        level_count: draft.levels?.length ?? 0,
                        show_bottom_title: draft.showBottomTitle,
                      });
                    } catch (err) {
                      toast.error('Could not import draft — clipboard access denied.');
                      console.warn('[n-levels panel draft import] error', {
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
                  title="Hydrate the panel from an N Levels draft JSON in the clipboard"
                >
                  Import
                </button>
              </div>
            </div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              Export copies the whole draft (levels, title, style, all settings) as JSON.
              Import hydrates the panel from a previously-exported draft.
            </p>
          </div>

          {/* Saved style presets — workspace-scoped named versions of
              the Post-process + Title-bar settings. Same UI as the
              TopicCardGridPanel sibling so the user gets the same
              picker shape across formats. Backed by the separate
              n_levels_saved_presets table (migration 0106) so each
              format has its own preset library. */}
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
                    const res = await fetch('/api/thumbnails/format/n-levels/saved-presets', {
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
                    console.info('[n-levels panel saved-preset save]', {
                      name: name.trim(),
                      post_process_filter: postProcess.filter,
                      title_bar_enabled: titleBar.enabled,
                    });
                    await refreshPresets();
                  } catch (err) {
                    toast.error('Save failed.');
                    console.warn('[n-levels panel saved-preset save] error', {
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
                          const raw = p.preset as { postProcess?: unknown; titleBar?: unknown } | null;
                          if (!raw || typeof raw !== 'object') {
                            toast.error('Preset payload is malformed.');
                            return;
                          }
                          setPostProcess(coercePostProcessState(raw.postProcess));
                          setTitleBar(coerceTitleBarState(raw.titleBar));
                          toast.success(`Loaded "${p.name}"`);
                          console.info('[n-levels panel saved-preset load]', {
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
                              `/api/thumbnails/format/n-levels/saved-presets/${encodeURIComponent(p.id)}`,
                              { method: 'DELETE' },
                            );
                            if (!res.ok) {
                              toast.error('Delete failed.');
                              return;
                            }
                            toast.success(`Deleted "${p.name}"`);
                            console.info('[n-levels panel saved-preset delete]', {
                              id: p.id,
                              name: p.name,
                            });
                            await refreshPresets();
                          } catch (err) {
                            toast.error('Delete failed.');
                            console.warn('[n-levels panel saved-preset delete] error', {
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
                const labelText = m === 'review' ? 'Review levels' : m === 'pre-fill' ? 'Pre-fill labels' : 'One-shot';
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
              {formatMode === 'review' && 'Generate level list → review and edit → render image. Default.'}
              {formatMode === 'pre-fill' && 'You type the labels below; the LLM only fills in illustrations.'}
              {formatMode === 'one-shot' && 'Generate level list and image back-to-back without a review step.'}
            </p>
            {formatMode === 'review' && script.trim() && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Tip: if the LLM picks labels that paraphrase your script, switch to <strong>Pre-fill labels</strong> and type the exact stage names — the model will only fill in illustrations and leave your wording intact.
              </p>
            )}
          </div>

          {formatMode === 'pre-fill' && (
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Level labels — one per line, exactly {count}
              </label>
              <textarea
                className="input-field w-full text-xs"
                rows={Math.min(10, Math.max(4, count))}
                value={prefilledLabels}
                onChange={(e) => setPrefilledLabels(e.target.value)}
                placeholder={'PASSIVE RECONNAISSANCE\nACTIVE PROBING\nTHE FOOTHOLD\n…'}
              />
              <p className="text-[10px] mt-0.5" style={{ color: prefilledLabelsList.length === count ? 'var(--text-muted)' : 'var(--accent-yellow)' }}>
                {prefilledLabelsList.length} / {count} labels
              </p>
            </div>
          )}

          {/* Reference image requirement notice */}
          {!referenceImageUrl.trim() && (
            <div className="text-xs px-3 py-2 rounded-lg" style={{
              background: 'rgba(234,179,8,0.08)',
              border: '1px solid rgba(234,179,8,0.3)',
              color: 'var(--accent-yellow)',
            }}>
              A reference image is required — it locks the grunge title typography. Upload one above (in the Image Generation section).
            </div>
          )}
          {referenceImageUrl.trim() && (
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Reference image guides the slice layout, level typography, and grunge title styling.
            </p>
          )}

          {/* Primary CTA */}
          <button
            className="btn-primary w-full flex items-center justify-center gap-2"
            onClick={runStep1}
            disabled={!canGenerateList || busyStep !== 'idle'}
          >
            {busyStep === 'list' && (
              <>
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                Generating level list…
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
          {levels && (
            <button
              onClick={clearList}
              className="text-[11px] underline w-full text-center"
              style={{ color: 'var(--text-muted)' }}
            >
              Discard current level list
            </button>
          )}
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            ≈ $0.05–$0.11 per generation. Step 1 (level list) is &lt; $0.01; Step 2 (image) is the bulk.
          </p>
        </div>
      </div>

      {/* RIGHT PANEL — State A (editable levels) OR State B (result) */}
      <div className="flex-1 min-w-0">
        {!levels && !result && (
          <div className="glass p-12 text-center space-y-3">
            <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              N Levels Explained
            </p>
            {renderMode === 'ai' ? (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Upload a reference image, set the level count and topic, and click <strong>Generate thumbnail</strong>.
              </p>
            ) : (
              <>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Free-form mode bypasses the AI. Click below to start with{' '}
                  <strong>{count}</strong> empty levels — then pick an emoji / icon / colour
                  per slice. The live preview updates instantly.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    // Placeholder levels — one per slice — so the
                    // free-form preview can mount immediately without
                    // going through the LLM. Labels start blank; the
                    // user fills them via the picker.
                    setLevels(
                      Array.from({ length: count }, (_, i) => ({
                        level: i + 1,
                        label: '',
                        illustration_concept: '',
                      })),
                    );
                  }}
                  className="btn-secondary text-xs px-3 py-1.5"
                >
                  Start free-form ⚡
                </button>
              </>
            )}
          </div>
        )}

        {levels && !result && (
          <LevelTableState
            levels={levels}
            totalCount={count}
            showBottomTitle={showBottomTitle}
            refinedTopic={refinedTopic}
            onTopicEdit={setRefinedTopic}
            canRender={canRenderImage}
            busy={busyStep === 'image'}
            onUpdate={updateLevel}
            onMove={moveLevel}
            onDelete={deleteLevel}
            onRenumber={renumberLevels}
            onRender={() => runStep2(levels, refinedTopic, taglineEnabled ? titleTagline : '')}
            onRegenerate={() => { setLevels(null); runStep1(); }}
          />
        )}

        {/* Phase B4: free-form preview. Mounts when free-form mode is
            active AND the user has a level list to map onto. N Levels
            is a vertical stack of horizontal slices — each slice has
            its own y-band. */}
        {levels && renderMode === 'free-form' && (() => {
          const freeFormCanvasW = 2048;
          const freeFormCanvasH = 1152;
          // Equal-height horizontal slices. The "Bottom title bar"
          // toggle isn't honoured in free-form mode — the title bar
          // overlay handles its own painting via the post-process
          // pipeline if the user wants one.
          const sliceH = Math.floor(freeFormCanvasH / count);
          const inputs: FreeFormCellInput[] = levels.slice(0, count).map((level, i) => ({
            index: level.level,
            label: level.label || `LEVEL ${level.level}`,
            bounds: { x: 0, y: i * sliceH, w: freeFormCanvasW, h: sliceH },
          }));
          return (
            <FreeFormPreviewPanel
              inputs={inputs}
              canvasWidth={freeFormCanvasW}
              canvasHeight={freeFormCanvasH}
              freeFormCells={freeFormLevels}
              onUpdateCell={updateFreeFormLevel}
              postProcessPayload={buildPostProcessRequestPayload(postProcess) ?? undefined}
              titleBarRendererInput={
                titleBar.enabled
                  ? {
                      text: titleBar.text,
                      subtitle: titleBar.subtitle || undefined,
                      position: titleBar.position,
                      heightFraction: titleBar.heightFraction,
                      align: titleBar.align,
                      subtitleAlign: titleBar.subtitleAlign,
                      backgroundColor: titleBar.backgroundColor,
                      backgroundOpacity: titleBar.backgroundOpacity,
                      textColor: titleBar.textColor,
                      subtitleColor: titleBar.subtitleColor,
                      fontFamily:
                        findFontById(titleBar.fontId)?.family ?? 'Patrick Hand',
                      subtitleFontFamily: titleBar.subtitleFontId
                        ? findFontById(titleBar.subtitleFontId)?.family
                        : undefined,
                      shadow: titleBar.shadowEnabled
                        ? {
                            offsetPx: titleBar.shadowOffsetPx,
                            blurPx: titleBar.shadowBlurPx,
                            opacity: titleBar.shadowOpacity,
                            color: titleBar.shadowColor,
                          }
                        : undefined,
                    }
                  : undefined
              }
              labelFontFamily="Patrick Hand"
              cellNoun="level"
              downloadFilename="n-levels-free-form.png"
            />
          );
        })()}

        {result && (
          <ResultState
            result={result}
            regionOverlayOn={regionOverlayOn}
            onToggleOverlay={toggleRegionOverlay}
            onEditList={() => setResult(null)}
            onRegenerateImage={() => runStep2()}
            busy={busyStep === 'image'}
            previewImageUrl={previewImageUrl}
            previewLoading={previewLoading}
            postProcessPayload={buildPostProcessRequestPayload(postProcess) ?? undefined}
            titleBarRendererInput={
              titleBar.enabled
                ? {
                    text: titleBar.text,
                    subtitle: titleBar.subtitle || undefined,
                    position: titleBar.position,
                    heightFraction: titleBar.heightFraction,
                    align: titleBar.align,
                    subtitleAlign: titleBar.subtitleAlign,
                    backgroundColor: titleBar.backgroundColor,
                    backgroundOpacity: titleBar.backgroundOpacity,
                    textColor: titleBar.textColor,
                    subtitleColor: titleBar.subtitleColor,
                    fontFamily:
                      findFontById(titleBar.fontId)?.family ?? 'Patrick Hand',
                    subtitleFontFamily: titleBar.subtitleFontId
                      ? findFontById(titleBar.subtitleFontId)?.family
                      : undefined,
                    shadow: titleBar.shadowEnabled
                      ? {
                          offsetPx: titleBar.shadowOffsetPx,
                          blurPx: titleBar.shadowBlurPx,
                          opacity: titleBar.shadowOpacity,
                          color: titleBar.shadowColor,
                        }
                      : undefined,
                  }
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

// ─── State A subcomponent — editable level table ────────────────────────────

interface LevelTableProps {
  levels: FormatLevel[];
  totalCount: number;
  showBottomTitle: boolean;
  refinedTopic: string;
  onTopicEdit: (next: string) => void;
  canRender: boolean;
  busy: boolean;
  onUpdate: (idx: number, patch: Partial<FormatLevel>) => void;
  onMove: (idx: number, dir: -1 | 1) => void;
  onDelete: (idx: number) => void;
  onRenumber: () => void;
  onRender: () => void;
  onRegenerate: () => void;
}

function LevelTableState(props: LevelTableProps) {
  const { levels, totalCount, showBottomTitle, refinedTopic, onTopicEdit, canRender, busy } = props;
  // Detect non-sequential numbering so the user can see at a glance whether
  // their custom numbering deviates from the default 1,2,3,... — useful
  // when intentionally rendering "level 1 and level 7" style.
  const isNonSequential = levels.some((l, i) => l.level !== i + 1);
  return (
    <div className="glass p-5 space-y-3" style={{ borderColor: 'rgba(124,58,237,0.2)' }}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
          Review levels
        </h3>
        <div className="flex items-center gap-2">
          {isNonSequential && (
            <button
              onClick={props.onRenumber}
              className="text-[10px] px-2 py-0.5 rounded"
              style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px dashed var(--border)' }}
              title="Re-sequence remaining slices as 1, 2, 3, ..."
            >
              Renumber 1..N
            </button>
          )}
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{
              background: 'rgba(34,197,94,0.15)',
              color: '#22c55e',
            }}
          >
            {levels.length}{levels.length !== totalCount ? ` / ${totalCount} (custom)` : ''} levels
          </span>
        </div>
      </div>

      {/* Refined topic editor — only shown when the bottom title bar is on. */}
      {showBottomTitle && (
        <div>
          <label className="block text-[10px] font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
            Title topic (model refined; you can edit)
          </label>
          <input
            className="input-field w-full text-sm"
            value={refinedTopic}
            onChange={(e) => onTopicEdit(e.target.value)}
            maxLength={60}
          />
        </div>
      )}

      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Tip: clear a label to render just &quot;LEVEL N&quot; without a subtitle. Edit the level number to pick non-sequential numbering (e.g. show only level 1 and level 7 by deleting the middle slices).
      </p>

      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {levels.map((level, i) => (
          <div
            key={i}
            className="p-2 rounded-lg space-y-1.5"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2">
              {/* Editable LEVEL number. Default is 1..N; user can override
                  to any 1-99 for non-sequential numbering. */}
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-medium" style={{ color: 'var(--text-muted)' }}>L</span>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={level.level}
                  onChange={(e) => {
                    const n = Math.max(1, Math.min(99, Number(e.target.value) || 1));
                    props.onUpdate(i, { level: n });
                  }}
                  className="input-field text-xs font-mono"
                  style={{ width: 48, textAlign: 'center' }}
                  title="LEVEL number rendered on this slice (1-99). Numbers don't need to be sequential."
                />
              </div>
              <input
                className="input-field flex-1 text-xs font-medium uppercase"
                placeholder="LABEL (optional — leave empty for LEVEL N only)"
                value={level.label ?? ''}
                onChange={(e) => props.onUpdate(i, { label: e.target.value })}
                maxLength={60}
              />
              {level.accent_color ? (
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={level.accent_color}
                    onChange={(e) => props.onUpdate(i, { accent_color: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer"
                    style={{ border: '1px solid var(--border)', background: 'none' }}
                    title="Accent color"
                  />
                  {/* Lock toggle: when locked, the image model is told to
                      use this exact color at full saturation. When unlocked
                      (hint), the model may freely reinterpret; softer,
                      moodier renders are common. */}
                  <button
                    onClick={() => props.onUpdate(i, { accent_color_locked: !level.accent_color_locked })}
                    className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
                    style={{
                      background: level.accent_color_locked ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
                      color: level.accent_color_locked ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                      border: `1px solid ${level.accent_color_locked ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
                    }}
                    title={
                      level.accent_color_locked
                        ? 'Color locked. The model must use this exact color at full saturation. Click to switch to a soft hint.'
                        : 'Color is a hint. The model may darken or reinterpret it. Click to lock the exact color.'
                    }
                    aria-pressed={!!level.accent_color_locked}
                  >
                    {level.accent_color_locked ? 'Lock' : 'Hint'}
                  </button>
                  <button
                    onClick={() => props.onUpdate(i, { accent_color: undefined, accent_color_locked: undefined })}
                    className="text-[9px] px-1 rounded"
                    style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                    title="Clear accent"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => props.onUpdate(i, { accent_color: '#7c3aed', accent_color_locked: true })}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px dashed var(--border)' }}
                  title="Add an accent color for this slice (defaults to locked; the model will use this exact color)"
                >
                  + color
                </button>
              )}
              <button
                onClick={() => props.onMove(i, -1)}
                disabled={i === 0}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-card)', color: i === 0 ? 'var(--text-muted)' : 'var(--text-secondary)', border: '1px solid var(--border)', opacity: i === 0 ? 0.4 : 1 }}
                title="Move left (numbers travel with the slice)"
              >
                ↑
              </button>
              <button
                onClick={() => props.onMove(i, 1)}
                disabled={i === levels.length - 1}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-card)', color: i === levels.length - 1 ? 'var(--text-muted)' : 'var(--text-secondary)', border: '1px solid var(--border)', opacity: i === levels.length - 1 ? 0.4 : 1 }}
                title="Move right (numbers travel with the slice)"
              >
                ↓
              </button>
              <button
                onClick={() => props.onDelete(i)}
                disabled={levels.length <= 1}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-card)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', opacity: levels.length <= 1 ? 0.4 : 1 }}
                title="Delete this slice (remaining slices keep their level numbers)"
              >
                ✕
              </button>
            </div>
            <input
              className="input-field w-full text-xs"
              placeholder="Illustration concept — what does this slice show?"
              value={level.illustration_concept}
              onChange={(e) => props.onUpdate(i, { illustration_concept: e.target.value })}
              maxLength={250}
            />
          </div>
        ))}
      </div>

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
          Regenerate list
        </button>
      </div>
    </div>
  );
}

// ─── State B subcomponent — result with region overlay ──────────────────────

interface ResultProps {
  result: NLevelsGenerationResult;
  regionOverlayOn: boolean;
  onToggleOverlay: () => void;
  onEditList: () => void;
  onRegenerateImage: () => void;
  busy: boolean;
  /** r2.8+ live-preview data URL (Phase A fallback). Phase B1 uses
   *  the SVG renderer for live updates; this URL is retained for a
   *  future "preview at server fidelity" button. */
  previewImageUrl: string | null;
  previewLoading: boolean;
  /** Phase B1: client-side SVG-overlay payloads. The renderer applies
   *  them on top of `result.imageUrl` in the browser — instant updates,
   *  no server roundtrip. */
  postProcessPayload?: PostProcessConfig;
  titleBarRendererInput?: TitleBarRendererInput;
}

/** Preview zoom presets (mirrors TopicCardGridPanel's PREVIEW_ZOOM_PRESETS
 *  and the Flex Icon Grid convention). */
const PREVIEW_ZOOM_PRESETS = [0.5, 1, 1.5, 2, 3] as const;

function ResultState({ result, regionOverlayOn, onToggleOverlay, onEditList, onRegenerateImage, busy, previewImageUrl, previewLoading, postProcessPayload, titleBarRendererInput }: ResultProps) {
  // Phase A fallback fields — retained for a future "preview at server
  // fidelity" button. The Phase B1 SVG renderer doesn't use them.
  void previewImageUrl;
  void previewLoading;
  // Preview zoom on the rendered image. Same shape as TopicCardGridPanel:
  // 1.0 = fits viewport width, above 1.0 scrolls horizontally, below 1.0
  // centres the image at reduced size. Ephemeral per ResultState mount.
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
            style={{ accentColor: 'var(--accent-purple-bright)' }}
          />
          Region overlay
        </label>
      </div>

      {/* Zoom controls — preset chips + fine slider. Same shape as the
          Topic Card Grid sibling so muscle memory carries between
          formats. */}
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
                    background: active ? 'var(--accent-purple-bright)' : 'var(--bg-secondary)',
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
          style={{ accentColor: 'var(--accent-purple-bright)' }}
        />
      </div>

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
          <ThumbnailRenderer
            baseImageUrl={result.imageUrl}
            canvasWidth={result.outputWidth}
            canvasHeight={result.outputHeight}
            postProcess={postProcessPayload}
            titleBar={titleBarRendererInput}
            alt="Generated thumbnail"
            style={{ width: '100%', height: '100%' }}
          >
          {regionOverlayOn && (
            <svg
              viewBox={`0 0 ${result.outputWidth} ${result.outputHeight}`}
              preserveAspectRatio="none"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            >
              {result.regions.map((r, i) => (
                <g key={r.id}>
                  <rect
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.h}
                    fill="none"
                    stroke="rgba(124,58,237,0.85)"
                    strokeWidth={Math.max(2, result.outputWidth * 0.003)}
                    strokeDasharray={`${Math.max(6, result.outputWidth * 0.01)} ${Math.max(4, result.outputWidth * 0.006)}`}
                  />
                  <text
                    x={r.x + 8}
                    y={r.y + Math.max(20, result.outputWidth * 0.025)}
                    fill="rgba(124,58,237,1)"
                    fontSize={Math.max(14, result.outputWidth * 0.018)}
                    fontFamily="ui-monospace, monospace"
                  >
                    L{i + 1}
                  </text>
                </g>
              ))}
            </svg>
          )}
          </ThumbnailRenderer>
        </div>
      </div>
      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        {result.outputWidth}×{result.outputHeight} · {result.regions.length} slice region{result.regions.length === 1 ? '' : 's'} ready for production-doc{result.showBottomTitle ? ` · Title: "${result.count} LEVELS OF ${result.titleTopic}${result.titleTagline ? ` [${result.titleTagline}]` : ''}"` : ' · no bottom title bar'}
      </p>

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => { navigator.clipboard.writeText(result.imageUrl); toast.success('Image URL copied'); }}
          className="btn-secondary text-xs px-2 py-1"
        >
          Copy URL
        </button>
        <a
          href={downloadHref(result.imageUrl, `thumbnail-levels.png`)}
          download="thumbnail-levels.png"
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
        <button onClick={onEditList} className="btn-secondary text-xs px-2 py-1">
          Edit levels
        </button>
        <button onClick={onRegenerateImage} disabled={busy} className="btn-secondary text-xs px-2 py-1">
          Regenerate image
        </button>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>
          Levels rendered ({result.levels.length})
        </summary>
        <div className="mt-2 space-y-1">
          {result.levels.map((l) => (
            <div key={l.level} className="flex gap-2" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-mono w-8 text-right" style={{ color: 'var(--text-muted)' }}>L{l.level}</span>
              <span className="font-medium uppercase">{l.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>— {l.illustration_concept}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
