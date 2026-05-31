/**
 * Shared UI primitives for the r2.8 finishing-overlay sections in
 * TopicCardGridPanel and NLevelsPanel. The actual STATE shape is
 * panel-specific (each panel owns its own `PanelPostProcessState`),
 * but the controls themselves — toggle cards, range rows, hex
 * pickers, chip pickers — are identical across formats. Pulled out
 * here so both panels stay declarative ("a list of OverlayCards")
 * instead of duplicating ~250 lines of UI primitives each.
 *
 * Style: matches the vignette / grain controls already in the
 * Post-process section — same accent colour, same toggle pattern,
 * same range-slider density. The cards stay COLLAPSED until the
 * user flips a toggle, so the section reads as a compact menu of
 * effects until the user opts into one.
 */

import type { ReactElement, ReactNode } from 'react';

// ─── Shared types ──────────────────────────────────────────────────────────

/** Tint / light-leak / inner-glow / halftone share these four mixing
 *  blends. Mirrors `ColorGradeBlend` in `shared-overlay-pipeline.ts`. */
export type PanelColorGradeBlend = 'multiply' | 'screen' | 'overlay' | 'soft-light';
/** Halftone adds `normal` (flat paint) on top of the four mixing blends. */
export type PanelHalftoneBlend = PanelColorGradeBlend | 'normal';
/** Inner-glow has a narrower blend choice than tint / light-leak —
 *  `screen` / `overlay` / `soft-light` only (no `multiply`, which would
 *  darken at the centre — visually wrong for a "glow"). */
export type PanelInnerGlowBlend = 'screen' | 'overlay' | 'soft-light';
/** Light-leak anchor positions — 4 corners + 4 edges. */
export type PanelLightLeakPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right';
/** Frame stroke style. */
export type PanelFrameStyle = 'solid' | 'double' | 'dashed';

// ─── Finishing presets ──────────────────────────────────────────────────────

/** Partial state patch for the 10 finishing fields a preset can touch
 *  (filter + vignette + grain + 7 r2.8 overlays). Type-only structure
 *  shared by both panels — they each store a full `PanelPostProcessState`
 *  but a preset patches just the finishing-relevant subset. */
export interface FinishingOverlaysPatch {
  filter?: 'grayscale' | 'sepia' | 'high-contrast' | 'low-contrast' | 'invert' | null;
  vignetteEnabled?: boolean;
  vignetteColor?: string;
  vignetteIntensity?: number;
  vignetteRadius?: number;
  grainEnabled?: boolean;
  grainIntensity?: number;
  grainSize?: number;
  grainMonochrome?: boolean;
  tintEnabled?: boolean;
  tintColor?: string;
  tintIntensity?: number;
  tintBlendMode?: PanelColorGradeBlend;
  tintShadowsEnabled?: boolean;
  tintShadows?: string;
  tintHighlightsEnabled?: boolean;
  tintHighlights?: string;
  tintSplitStrength?: number;
  lightLeakEnabled?: boolean;
  lightLeakColor?: string;
  lightLeakIntensity?: number;
  lightLeakRadius?: number;
  lightLeakPosition?: PanelLightLeakPosition;
  lightLeakBlendMode?: PanelColorGradeBlend;
  innerGlowEnabled?: boolean;
  innerGlowColor?: string;
  innerGlowIntensity?: number;
  innerGlowRadius?: number;
  innerGlowBlendMode?: PanelInnerGlowBlend;
  dustEnabled?: boolean;
  dustColor?: string;
  dustIntensity?: number;
  dustDensity?: number;
  dustSeed?: number;
  halftoneEnabled?: boolean;
  halftoneColor?: string;
  halftoneOpacity?: number;
  halftoneDotSize?: number;
  halftoneSpacing?: number;
  halftoneBlendMode?: PanelHalftoneBlend;
  halftoneAngle?: number;
  letterboxEnabled?: boolean;
  letterboxColor?: string;
  letterboxTop?: number;
  letterboxBottom?: number;
  letterboxLeft?: number;
  letterboxRight?: number;
  letterboxOpacity?: number;
  frameEnabled?: boolean;
  frameColor?: string;
  frameThickness?: number;
  frameInset?: number;
  frameStyle?: PanelFrameStyle;
}

/** One named finishing preset — applied as a one-click patch on top of
 *  the current state. The patch is FULL (every finishing field
 *  explicitly set or explicitly `false`) so re-applying a preset always
 *  produces the same end state regardless of what was there before. */
export interface FinishingPreset {
  id: string;
  label: string;
  hint: string;
  patch: FinishingOverlaysPatch;
}

/** Off / reset patch — explicitly disables EVERY finishing effect. Used
 *  both as a standalone "Off" preset button AND as the base every other
 *  preset starts from so the result is deterministic regardless of
 *  previous toggles. */
const OFF_PATCH: FinishingOverlaysPatch = {
  filter: null,
  vignetteEnabled: false,
  grainEnabled: false,
  tintEnabled: false,
  tintShadowsEnabled: false,
  tintHighlightsEnabled: false,
  lightLeakEnabled: false,
  innerGlowEnabled: false,
  dustEnabled: false,
  halftoneEnabled: false,
  letterboxEnabled: false,
  frameEnabled: false,
};

/** Curated presets matching the Flex Icon Grid finishing palette so a user
 *  who already learned the look-names there finds them in the same place
 *  here. Each preset's patch starts from `OFF_PATCH` so applying it
 *  produces the same result regardless of the panel's previous state. */
export const FINISHING_PRESETS: readonly FinishingPreset[] = [
  {
    id: 'off',
    label: 'Off',
    hint: 'All finishing effects disabled.',
    patch: { ...OFF_PATCH },
  },
  {
    id: 'vintage-film',
    label: 'Vintage film',
    hint: 'Worn-print grade: vignette, monochrome grain, dust, warm wash.',
    patch: {
      ...OFF_PATCH,
      vignetteEnabled: true,
      vignetteColor: '#000000',
      vignetteIntensity: 0.4,
      vignetteRadius: 0.7,
      grainEnabled: true,
      grainIntensity: 0.18,
      grainSize: 1.4,
      grainMonochrome: true,
      dustEnabled: true,
      dustColor: '#ffffff',
      dustIntensity: 0.35,
      dustDensity: 0.18,
      tintEnabled: true,
      tintColor: '#ffb27a',
      tintIntensity: 0.18,
      tintBlendMode: 'soft-light',
    },
  },
  {
    id: 'cinematic-239',
    label: 'Cinematic 2.39',
    hint: 'Strong vignette + warm centre lift + black bars + thin white stroke.',
    patch: {
      ...OFF_PATCH,
      vignetteEnabled: true,
      vignetteColor: '#000000',
      vignetteIntensity: 0.55,
      vignetteRadius: 0.55,
      innerGlowEnabled: true,
      innerGlowColor: '#fff4dc',
      innerGlowIntensity: 0.15,
      innerGlowRadius: 0.9,
      innerGlowBlendMode: 'soft-light',
      letterboxEnabled: true,
      letterboxColor: '#000000',
      // ~9% of a 1080-tall canvas (~96 px). Matches the look at standard
      // 16:9 thumbnail dimensions; user can tweak per cell.
      letterboxTop: 96,
      letterboxBottom: 96,
      letterboxLeft: 0,
      letterboxRight: 0,
      letterboxOpacity: 1,
      frameEnabled: true,
      frameColor: '#ffffff',
      frameThickness: 2,
      frameInset: 0,
      frameStyle: 'solid',
    },
  },
  {
    id: 'editorial-clean',
    label: 'Editorial clean',
    hint: 'Just a clean double-line white frame. No grain, no vignette.',
    patch: {
      ...OFF_PATCH,
      frameEnabled: true,
      frameColor: '#ffffff',
      frameThickness: 8,
      frameInset: 16,
      frameStyle: 'double',
    },
  },
  {
    id: 'newsprint',
    label: 'Newsprint',
    hint: 'Halftone dots + low-contrast filter for a printed-page feel.',
    patch: {
      ...OFF_PATCH,
      filter: 'low-contrast',
      halftoneEnabled: true,
      halftoneColor: '#000000',
      halftoneOpacity: 0.35,
      halftoneDotSize: 1.5,
      halftoneSpacing: 5,
      halftoneBlendMode: 'multiply',
      halftoneAngle: 15,
    },
  },
];

/** Component that renders the preset row above the finishing overlays.
 *  Each preset's button applies its patch via the caller-supplied
 *  `onApply`. The caller is responsible for spreading the patch into
 *  panel state (because the panel owns the state setter, not us). */
export function FinishingPresetRow({
  onApply,
}: {
  onApply: (patch: FinishingOverlaysPatch) => void;
}): ReactElement {
  return (
    <div className="mt-3">
      <span className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
        Finishing presets
      </span>
      <div className="flex flex-wrap gap-1">
        {FINISHING_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onApply(preset.patch)}
            className="px-2 py-0.5 rounded text-[10px]"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
            title={preset.hint}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Components ────────────────────────────────────────────────────────────

export function OverlayCard({
  title,
  hint,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  enabled: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-1">
        <div>
          <span className="text-[11px]" style={{ color: 'var(--text-primary)' }}>
            {title}
          </span>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="px-2 py-0.5 rounded text-[10px]"
          style={{
            background: enabled ? 'var(--accent-pink)' : 'var(--bg-secondary)',
            color: enabled ? '#fff' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}
          aria-pressed={enabled}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>
      {enabled && <div className="space-y-2">{children}</div>}
    </div>
  );
}

export function RangeRow({
  label,
  value,
  onChange,
  min,
  max,
  step,
  fmt,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}): ReactElement {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {fmt(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number.parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="w-full"
        style={{ accentColor: 'var(--accent-pink)' }}
      />
    </div>
  );
}

export function HexInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): ReactElement {
  return (
    <input
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-7 h-5 rounded border-0 p-0 cursor-pointer"
      aria-label="colour"
    />
  );
}

export function ColorAndSlider({
  label,
  color,
  onColor,
  value,
  onValue,
  min,
  max,
  step,
  fmt,
}: {
  label: string;
  color: string;
  onColor: (v: string) => void;
  value: number;
  onValue: (v: number) => void;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}): ReactElement {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {label}
          </span>
          <HexInput value={color} onChange={onColor} />
        </div>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {fmt(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number.parseFloat(e.target.value);
          if (Number.isFinite(v)) onValue(v);
        }}
        className="w-full"
        style={{ accentColor: 'var(--accent-pink)' }}
      />
    </div>
  );
}

export function ChipPicker<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}): ReactElement {
  return (
    <div>
      <span className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className="px-2 py-0.5 rounded text-[10px]"
              style={{
                background: active ? 'var(--accent-pink)' : 'var(--bg-secondary)',
                color: active ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border)',
              }}
              aria-pressed={active}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SubToggle({
  label,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="px-2 py-0.5 rounded text-[10px]"
          style={{
            background: enabled ? 'var(--accent-pink)' : 'var(--bg-secondary)',
            color: enabled ? '#fff' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}
          aria-pressed={enabled}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>
      {enabled && <div className="mt-1">{children}</div>}
    </div>
  );
}
