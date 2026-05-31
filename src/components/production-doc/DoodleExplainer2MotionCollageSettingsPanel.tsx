/**
 * doodle_explainer_2 motion-collage settings panel.
 *
 * Renders the 4 settings from §Settings of
 * `_plans/2026-05-31-doodle-explainer-2-motion-collage.md` as editable
 * controls on the production-doc page. Mounted conditionally by the
 * page when `stylePreset === 'doodle_explainer_2'`.
 *
 * Mirrors the PaintExplainerV1SettingsPanel structure exactly so the
 * page composes against the same visual + interaction language. Rule
 * 16: clean, intuitive, clear. Every control labelled in plain
 * language, every numeric range bounded so the user can't push a value
 * out of the pipeline's safe envelope (the resolver clamps too,
 * defense in depth).
 *
 * Rule 5: no AI tells. Plain labels, plain explanations, no
 * 'seamless' / 'leverage' / 'comprehensive'.
 */
import React from 'react';
import {
  DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS,
  DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS,
  resolveDoodleExplainer2MotionCollageSettings,
  type DoodleExplainer2MotionCollageSettings,
} from '@/remotion/utils';

export interface DoodleExplainer2MotionCollageSettingsPanelProps {
  /** Raw stored settings off the doc. Undefined fields take their
   *  default from `DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS`. The
   *  component only emits a stored value when the user explicitly
   *  changes one. */
  value: DoodleExplainer2MotionCollageSettings | undefined;
  /** Called with a full next-value object every time the user edits a
   *  control. The page-level code merges this into the doc's
   *  `doodle_explainer_2_motion_collage_settings` field and persists. */
  onChange: (next: DoodleExplainer2MotionCollageSettings) => void;
}

export const DoodleExplainer2MotionCollageSettingsPanel: React.FC<
  DoodleExplainer2MotionCollageSettingsPanelProps
> = ({ value, onChange }) => {
  // Resolve effective values once per render so every control shows
  // either the stored value or the canonical default — never an empty
  // input box. Stored values are pre-clamped to bounds by the resolver.
  const effective = resolveDoodleExplainer2MotionCollageSettings({
    doodle_explainer_2_motion_collage_settings: value,
  });

  // Helper that emits a new settings object with one field overridden.
  // Reads from `value ?? {}` (NOT the resolved object) so we only
  // persist fields the user has actually touched — keeps the doc
  // JSONB lean and lets future default changes propagate.
  function set<K extends keyof DoodleExplainer2MotionCollageSettings>(
    key: K,
    next: DoodleExplainer2MotionCollageSettings[K],
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
          Doodle Explainer 2 — Motion Collage
        </label>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          per video
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* 1. Allow motion collage */}
        <Field
          label="Allow motion collage shots"
          help="Off disables every motion_collage shot for this doc. Use to globally kill the feature if a model regression appears."
        >
          <Toggle
            checked={effective.allow_motion_collage}
            onChange={(b) => set('allow_motion_collage', b)}
            onLabel="On"
            offLabel="Off"
          />
        </Field>

        {/* 2. Max grid panels */}
        <Field
          label="Max panels per shot"
          help="Hard ceiling on cols × rows. Higher = finer motion, longer generations. 12 covers most arcs; 16 is the hard cap."
        >
          <NumberWithUnit
            value={effective.max_grid_panels}
            min={DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_grid_panels[0]}
            max={DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_grid_panels[1]}
            step={1}
            unit="panels"
            onChange={(n) => set('max_grid_panels', n)}
          />
        </Field>

        {/* 3. Min per-frame duration */}
        <Field
          label="Min per-frame duration"
          help="Frames briefer than this read as flicker. Pipeline rejects rows where shot duration / N falls below it."
        >
          <NumberWithUnit
            value={effective.min_per_frame_ms}
            min={DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.min_per_frame_ms[0]}
            max={DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.min_per_frame_ms[1]}
            step={50}
            unit="ms"
            onChange={(n) => set('min_per_frame_ms', n)}
          />
        </Field>

        {/* 4. Max per-frame duration */}
        <Field
          label="Max per-frame duration"
          help="Frames longer than this stop feeling like motion. The LLM is told to pick a grid that lands below this."
        >
          <NumberWithUnit
            value={effective.max_per_frame_ms}
            min={DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_per_frame_ms[0]}
            max={DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_per_frame_ms[1]}
            step={50}
            unit="ms"
            onChange={(n) => set('max_per_frame_ms', n)}
          />
        </Field>
      </div>

      {/* Reset-to-defaults affordance. Clears the doc's
          doodle_explainer_2_motion_collage_settings field entirely, so the
          resolver falls back to DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS
          on every render. Useful when the user has experimented and wants
          a clean slate. */}
      <div
        className="flex items-center justify-end mt-3 pt-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        <button
          type="button"
          onClick={() => onChange({})}
          className="text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
          title={`Restore every setting to its default value (allow: ${DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.allow_motion_collage}, max panels: ${DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.max_grid_panels})`}
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
// (raw Tailwind + plain HTML inputs per the existing settings panel
// pattern). When that changes, these wrappers swap one-line for the
// shared primitive.

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
