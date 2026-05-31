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
