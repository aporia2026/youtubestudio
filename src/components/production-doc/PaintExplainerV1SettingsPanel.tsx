/**
 * paint_explainer_v1 doc-level settings panel.
 *
 * Renders the 8 settings from §14 of the architecture plan as
 * editable controls on the production-doc page. Mounted conditionally
 * by the page when `stylePreset === 'paint_explainer_v1'`.
 *
 * PR 1 ships per-doc settings only. Workspace-level defaults (so a
 * channel can set "median shot length 3.0" once for every new doc)
 * come in a later PR.
 *
 * Rule 16: clean, intuitive, clear. Every control labelled in plain
 * language, every numeric range bounded so the user can't push a
 * value out of the renderer's safe envelope (the resolver clamps too,
 * defense in depth).
 *
 * Rule 5: no AI tells. Plain labels, plain explanations, no
 * 'seamless' / 'leverage' / 'comprehensive'.
 */
import React from 'react';
import {
  PAINT_EXPLAINER_V1_BOUNDS,
  PAINT_EXPLAINER_V1_DEFAULTS,
  resolvePaintExplainerV1Settings,
  type PaintExplainerV1Settings,
} from '@/remotion/utils';

export interface PaintExplainerV1SettingsPanelProps {
  /** Raw stored settings off the doc. Undefined fields take their
   *  default from `PAINT_EXPLAINER_V1_DEFAULTS`. The component only
   *  emits a stored value when the user explicitly changes one. */
  value: PaintExplainerV1Settings | undefined;
  /** Called with a full next-value object every time the user edits
   *  a control. The page-level code merges this into the doc's
   *  `paint_explainer_v1_settings` field and persists. */
  onChange: (next: PaintExplainerV1Settings) => void;
}

export const PaintExplainerV1SettingsPanel: React.FC<PaintExplainerV1SettingsPanelProps> = ({
  value,
  onChange,
}) => {
  // Resolve effective values once per render so every control shows
  // either the stored value or the canonical default — never an empty
  // input box. Stored values are pre-clamped to bounds by the resolver.
  const effective = resolvePaintExplainerV1Settings({ paint_explainer_v1_settings: value });

  // Helper that emits a new settings object with one field overridden.
  // Reads from `value ?? {}` (NOT the resolved object) so we only
  // persist fields the user has actually touched — keeps the doc
  // JSONB lean and lets future default changes propagate.
  function set<K extends keyof PaintExplainerV1Settings>(
    key: K,
    next: PaintExplainerV1Settings[K],
  ) {
    onChange({ ...(value ?? {}), [key]: next });
  }

  return (
    <div
      style={{
        padding: 12,
        border: '1px solid rgba(124,58,237,0.25)',
        borderRadius: 8,
        background: 'rgba(124,58,237,0.04)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <label
          className="block text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--accent-purple-bright)' }}
        >
          Paint Explainer V1 — Settings
        </label>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          per video
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* 1. Median shot length */}
        <Field
          label="Median shot length"
          help="Drives the LLM's pacing. 2.5–3.0 s matches the reference genre."
        >
          <NumberWithUnit
            value={effective.median_shot_seconds}
            min={PAINT_EXPLAINER_V1_BOUNDS.median_shot_seconds[0]}
            max={PAINT_EXPLAINER_V1_BOUNDS.median_shot_seconds[1]}
            step={0.25}
            unit="s"
            onChange={(n) => set('median_shot_seconds', n)}
          />
        </Field>

        {/* 2. Mouth-swap fps fallback */}
        <Field
          label="Mouth-swap rate (fallback)"
          help="Used when alignment JSON isn't available for a row. Default 8 Hz."
        >
          <NumberWithUnit
            value={effective.mouth_swap_fps_fallback}
            min={PAINT_EXPLAINER_V1_BOUNDS.mouth_swap_fps_fallback[0]}
            max={PAINT_EXPLAINER_V1_BOUNDS.mouth_swap_fps_fallback[1]}
            step={1}
            unit="Hz"
            onChange={(n) => set('mouth_swap_fps_fallback', n)}
          />
        </Field>

        {/* 3. Use alignment-driven visemes */}
        <Field
          label="Alignment-driven mouth sync"
          help="Off forces constant-rate. Diagnostic — most users leave on."
        >
          <Toggle
            checked={effective.use_alignment_driven_visemes}
            onChange={(b) => set('use_alignment_driven_visemes', b)}
            onLabel="On"
            offLabel="Off"
          />
        </Field>

        {/* 4. Real-photo cadence */}
        <Field
          label="Real-photo cadence"
          help="Share of factual rows that get a real photo. Higher = more documentary."
        >
          <Slider
            value={effective.real_photo_cadence_pct}
            min={PAINT_EXPLAINER_V1_BOUNDS.real_photo_cadence_pct[0]}
            max={PAINT_EXPLAINER_V1_BOUNDS.real_photo_cadence_pct[1]}
            step={5}
            unit="%"
            onChange={(n) => set('real_photo_cadence_pct', n)}
          />
        </Field>

        {/* 5. Character persistence */}
        <Field
          label="Character persistence"
          help="Reuse one mouth-removed base per character. Off ≈ 3× per-video cost."
        >
          <Toggle
            checked={effective.character_persistence_enabled}
            onChange={(b) => set('character_persistence_enabled', b)}
            onLabel="On"
            offLabel="Off"
          />
        </Field>

        {/* 6. Label color */}
        <Field
          label="Label color"
          help="Yellow comic-bold labels. Default goldenrod #EBC347."
        >
          <ColorPicker
            value={effective.label_color_hex}
            onChange={(hex) => set('label_color_hex', hex)}
          />
        </Field>

        {/* 7. Draw-on duration */}
        <Field
          label="Draw-on default duration"
          help="Default length of a scribble-draw reveal beat."
        >
          <NumberWithUnit
            value={effective.draw_on_default_duration_ms}
            min={PAINT_EXPLAINER_V1_BOUNDS.draw_on_default_duration_ms[0]}
            max={PAINT_EXPLAINER_V1_BOUNDS.draw_on_default_duration_ms[1]}
            step={100}
            unit="ms"
            onChange={(n) => set('draw_on_default_duration_ms', n)}
          />
        </Field>

        {/* 8. Hard-cut transition */}
        <Field
          label="Cut transition"
          help="Snap matches the genre. Micro-fade is a 30 ms cross-fade."
        >
          <Select
            value={effective.hard_cut_transition}
            options={[
              { value: 'snap', label: 'Snap (hard cut)' },
              { value: 'micro-fade', label: 'Micro-fade (30 ms)' },
            ]}
            onChange={(v) => set('hard_cut_transition', v as 'snap' | 'micro-fade')}
          />
        </Field>
      </div>

      {/* Reset-to-defaults affordance. Clears the doc's paint_explainer_v1_settings
          field entirely, so the resolver falls back to PAINT_EXPLAINER_V1_DEFAULTS
          on every render. Useful when the user has experimented and wants a
          clean slate. */}
      <div className="flex items-center justify-end mt-3 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <button
          type="button"
          onClick={() => onChange({})}
          className="text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
          title="Restore every setting to its default value"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
};

// ─── Small typed primitives ──────────────────────────────────────────
//
// Kept local because the project doesn't ship a shared design system
// (per recon — raw Tailwind + plain HTML inputs). When that changes,
// these wrappers swap one-line for the shared primitive.

const Field: React.FC<{ label: string; help: string; children: React.ReactNode }> = ({
  label,
  help,
  children,
}) => (
  <div>
    <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
      {label}
    </label>
    <div className="mb-1">{children}</div>
    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
      {help}
    </div>
  </div>
);

const NumberWithUnit: React.FC<{
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (n: number) => void;
}> = ({ value, min, max, step, unit, onChange }) => (
  <div className="flex items-center gap-2">
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="input-field text-xs"
      style={{ width: 96 }}
    />
    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{unit}</span>
  </div>
);

const Slider: React.FC<{
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (n: number) => void;
}> = ({ value, min, max, step, unit, onChange }) => (
  <div className="flex items-center gap-2">
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ flex: 1, accentColor: '#8b5cf6' }}
    />
    <span className="text-[11px] font-medium tabular-nums" style={{ color: 'var(--text-secondary)', minWidth: 48, textAlign: 'right' }}>
      {value}{unit}
    </span>
  </div>
);

const Toggle: React.FC<{
  checked: boolean;
  onChange: (b: boolean) => void;
  onLabel: string;
  offLabel: string;
}> = ({ checked, onChange, onLabel, offLabel }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className="px-3 py-1 rounded-md text-xs font-medium transition-colors"
    style={{
      background: checked ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.05)',
      color: checked ? '#a78bfa' : 'var(--text-secondary)',
      border: checked ? '1px solid rgba(124,58,237,0.4)' : '1px solid var(--border)',
      minWidth: 64,
    }}
    aria-pressed={checked}
  >
    {checked ? onLabel : offLabel}
  </button>
);

const ColorPicker: React.FC<{ value: string; onChange: (hex: string) => void }> = ({
  value,
  onChange,
}) => (
  <div className="flex items-center gap-2">
    <input
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: 36, height: 28, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}
      aria-label="Pick label color"
    />
    <input
      type="text"
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        // Only emit when the user has typed a complete valid hex —
        // the resolver also clamps but we want the UI to ignore
        // half-typed values rather than reverting mid-typing.
        if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
      }}
      className="input-field text-xs"
      style={{ width: 104, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
      placeholder="#EBC347"
      maxLength={7}
    />
  </div>
);

const Select: React.FC<{
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}> = ({ value, options, onChange }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="input-field text-xs"
    style={{ width: '100%' }}
  >
    {options.map((opt) => (
      <option key={opt.value} value={opt.value}>
        {opt.label}
      </option>
    ))}
  </select>
);
