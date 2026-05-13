'use client';

/**
 * Dual-handle range slider used by the niche-finder outlier filter
 * bar's "Custom ranges" panel.
 *
 * Built in-house, no library — the codebase has no other slider so
 * we own one tiny primitive instead of pulling in a dependency.
 *
 * Implementation:
 *   - Two stacked `<input type="range">` elements, each sliding a
 *     0..POSITION_RESOLUTION integer. Both tracks are transparent;
 *     only the thumbs are visible (see globals.css `.range-slider`).
 *   - A CSS-painted track underneath gets the visible look: grey
 *     full-width base + green active segment between the thumbs.
 *   - Position ↔ value mapping is pluggable: linear for narrow
 *     dimensions, log for dimensions that span orders of magnitude
 *     (subscribers, views, duration). Log mode anchors 0 to position
 *     0 explicitly so the slider can express "no minimum" cleanly.
 *
 * Overlap handling: when both thumbs are at the same position, the
 * focused input wins (raised via the `:focus` z-index rule in
 * globals.css). Clicking either thumb focuses it on mousedown so
 * the user can always grab a buried handle.
 */
import { useCallback, useMemo } from 'react';

export type ScaleKind = 'linear' | 'log';

export interface RangeSliderProps {
  label: string;
  /** Domain minimum. Usually 0. */
  min: number;
  /** Domain maximum (ceiling). The slider can't go above this. */
  max: number;
  /** Current [min, max] in the dimension's natural unit. */
  value: readonly [number, number];
  onChange: (next: readonly [number, number]) => void;
  /** Mapping curve from slider position to value. */
  scale?: ScaleKind;
  /** Round values to the nearest `step`. 0 = no rounding. */
  step?: number;
  /** Format a value as the user-facing label (e.g. "5K", "8:00"). */
  format: (n: number) => string;
  /** Optional reset button shown after the slider. */
  onClear?: () => void;
  disabled?: boolean;
}

/** Slider position resolution. Higher = smoother dragging at the
 *  cost of more onChange events. 1000 gives a pleasant ~0.1% step. */
const POSITION_RESOLUTION = 1000;

/** Map a value in [0, max] to a 0..POSITION_RESOLUTION integer. */
function toPosition(value: number, max: number, scale: ScaleKind): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= max) return POSITION_RESOLUTION;
  if (scale === 'log') {
    // Anchor 1..max to a log curve. Values 0..1 collapse to position 0.
    if (value <= 1) return 0;
    const t = Math.log(value) / Math.log(max);
    return Math.round(t * POSITION_RESOLUTION);
  }
  return Math.round((value / max) * POSITION_RESOLUTION);
}

/** Inverse of toPosition. */
function fromPosition(pos: number, max: number, scale: ScaleKind): number {
  const p = Math.max(0, Math.min(POSITION_RESOLUTION, pos));
  if (p === 0) return 0;
  if (p >= POSITION_RESOLUTION) return max;
  if (scale === 'log') {
    return Math.pow(max, p / POSITION_RESOLUTION);
  }
  return (p / POSITION_RESOLUTION) * max;
}

function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

export function RangeSlider({
  label,
  min,
  max,
  value,
  onChange,
  scale = 'linear',
  step = 0,
  format,
  onClear,
  disabled = false,
}: RangeSliderProps): React.ReactElement {
  const [lo, hi] = value;
  const lowPos = useMemo(() => toPosition(lo, max, scale), [lo, max, scale]);
  const highPos = useMemo(() => toPosition(hi, max, scale), [hi, max, scale]);
  const lowPct = (lowPos / POSITION_RESOLUTION) * 100;
  const highPct = (highPos / POSITION_RESOLUTION) * 100;

  const handleLowChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newPos = parseInt(e.target.value, 10);
      let newLo = fromPosition(newPos, max, scale);
      newLo = step > 0 ? roundToStep(newLo, step) : newLo;
      newLo = Math.max(min, Math.min(newLo, hi));
      if (newLo !== lo) onChange([newLo, hi] as const);
    },
    [hi, lo, max, min, onChange, scale, step],
  );

  const handleHighChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newPos = parseInt(e.target.value, 10);
      let newHi = fromPosition(newPos, max, scale);
      newHi = step > 0 ? roundToStep(newHi, step) : newHi;
      newHi = Math.min(max, Math.max(newHi, lo));
      if (newHi !== hi) onChange([lo, newHi] as const);
    },
    [hi, lo, max, onChange, scale, step],
  );

  const isAtDefault = lo <= min && hi >= max;
  const showClear = !!onClear && !isAtDefault && !disabled;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 64px 1fr 64px 28px',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div style={{ fontSize: 12, color: '#64748b' }}>{label}</div>
      <Badge text={format(lo)} disabled={disabled} />
      <div
        className="range-slider"
        style={{
          position: 'relative',
          height: 28,
          display: 'flex',
          alignItems: 'center',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {/* Painted track */}
        <div
          style={{
            position: 'absolute',
            inset: '50% 0 auto 0',
            height: 4,
            background: '#1e293b',
            borderRadius: 999,
            transform: 'translateY(-50%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: `${lowPct}%`,
            right: `${100 - highPct}%`,
            height: 4,
            background: disabled ? '#475569' : '#22c55e',
            borderRadius: 999,
            transform: 'translateY(-50%)',
          }}
        />
        <input
          type="range"
          min={0}
          max={POSITION_RESOLUTION}
          value={lowPos}
          step={1}
          onChange={handleLowChange}
          disabled={disabled}
          aria-label={`${label} minimum`}
        />
        <input
          type="range"
          min={0}
          max={POSITION_RESOLUTION}
          value={highPos}
          step={1}
          onChange={handleHighChange}
          disabled={disabled}
          aria-label={`${label} maximum`}
        />
      </div>
      <Badge text={format(hi)} disabled={disabled} />
      <button
        type="button"
        onClick={onClear}
        disabled={!showClear}
        title={showClear ? 'Clear this range' : 'Range already at default'}
        aria-label={`Clear ${label} range`}
        style={{
          width: 24,
          height: 24,
          padding: 0,
          borderRadius: 6,
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.10)',
          color: showClear ? '#94a3b8' : '#334155',
          fontSize: 14,
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ×
      </button>
    </div>
  );
}

function Badge({ text, disabled }: { text: string; disabled: boolean }): React.ReactElement {
  return (
    <div
      style={{
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
        color: disabled ? '#475569' : '#cbd5e1',
        textAlign: 'center',
        padding: '3px 6px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.06)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {text}
    </div>
  );
}
