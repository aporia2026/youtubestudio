/**
 * zenn_v1 doc-level settings panel.
 *
 * Renders the settings from §8 of the architecture plan as editable
 * controls on the production-doc page. Mounted conditionally by the
 * page when `stylePreset === 'zenn_v1'`.
 *
 * PR 6 ships per-doc settings only. Workspace-level defaults (so a
 * channel can set "default mode = stick" once for every new doc)
 * come in a later PR.
 *
 * Rule 16: clean, intuitive, clear. Every control labelled in plain
 * language, every numeric range bounded so the user can't push a
 * value out of the renderer's safe envelope (the resolver clamps too,
 * defense in depth).
 *
 * Rule 5: no AI tells. Plain labels, plain explanations, no
 * 'seamless' / 'leverage' / 'comprehensive'.
 *
 * Visual treatment mirrors `PaintExplainerV1SettingsPanel` exactly so
 * the production-doc page stays visually coherent across style
 * presets. Only the accent color shifts from purple (paint) to red
 * (zenn) since red is the load-bearing emphasis color of the genre.
 */
import React from 'react';
import {
  ZENN_V1_BOUNDS,
  resolveZennV1Settings,
  type ZennV1Settings,
} from '@/remotion/utils';

export interface ZennV1SettingsPanelProps {
  /** Raw stored settings off the doc. Undefined fields take their
   *  default from `ZENN_V1_DEFAULTS`. The component only emits a
   *  stored value when the user explicitly changes one. */
  value: ZennV1Settings | undefined;
  /** Called with a full next-value object every time the user edits
   *  a control. The page-level code merges this into the doc's
   *  `zenn_v1_settings` field and persists. */
  onChange: (next: ZennV1Settings) => void;
}

export const ZennV1SettingsPanel: React.FC<ZennV1SettingsPanelProps> = ({
  value,
  onChange,
}) => {
  // Resolve effective values once per render so every control shows
  // either the stored value or the canonical default — never an empty
  // input box. Stored values are pre-clamped to bounds by the resolver.
  const effective = resolveZennV1Settings({ zenn_v1_settings: value });

  // Helper that emits a new settings object with one field overridden.
  // Reads from `value ?? {}` (NOT the resolved object) so we only
  // persist fields the user has actually touched — keeps the doc
  // JSONB lean and lets future default changes propagate.
  function set<K extends keyof ZennV1Settings>(
    key: K,
    next: ZennV1Settings[K],
  ) {
    onChange({ ...(value ?? {}), [key]: next });
  }

  return (
    <div
      style={{
        padding: 12,
        border: '1px solid rgba(211,47,47,0.25)',
        borderRadius: 8,
        background: 'rgba(211,47,47,0.04)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <label
          className="block text-xs font-semibold uppercase tracking-wider"
          style={{ color: '#D32F2F' }}
        >
          Zenn V1 — Settings
        </label>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          per video
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* 1. Default mode */}
        <Field
          label="Default mode for new shots"
          help="Scene = flat-fill character on a world; Stick = white canvas figure."
        >
          <Select
            value={effective.default_mode}
            options={[
              { value: 'scene', label: 'Scene (Mode B, the differentiator)' },
              { value: 'stick', label: 'Stick (Mode A, abstract beats)' },
            ]}
            onChange={(v) => set('default_mode', v as 'stick' | 'scene')}
          />
        </Field>

        {/* 2. Median shot length */}
        <Field
          label="Median shot length"
          help="Drives the LLM's pacing. 2.8 s for scene mode, 4.3 s for stick."
        >
          <NumberWithUnit
            value={effective.median_shot_seconds}
            min={ZENN_V1_BOUNDS.median_shot_seconds[0]}
            max={ZENN_V1_BOUNDS.median_shot_seconds[1]}
            step={0.2}
            unit="s"
            onChange={(n) => set('median_shot_seconds', n)}
          />
        </Field>

        {/* 3. Label color */}
        <Field
          label="Label color"
          help="Bold red hand-lettered emphasis. Default Zenn red #D32F2F."
        >
          <ColorPicker
            value={effective.label_color_hex}
            onChange={(hex) => set('label_color_hex', hex)}
          />
        </Field>

        {/* 4. Highlighter on/off */}
        <Field
          label="Yellow highlighter"
          help="Translucent stripe behind key words. Some topics read better without."
        >
          <Toggle
            checked={effective.highlighter_enabled}
            onChange={(b) => set('highlighter_enabled', b)}
            onLabel="On"
            offLabel="Off"
          />
        </Field>

        {/* 5. Highlighter color */}
        <Field
          label="Highlighter color"
          help="Solid hex; renderer applies the canonical 0.65 opacity at composite."
        >
          <ColorPicker
            value={effective.highlighter_color_hex}
            onChange={(hex) => set('highlighter_color_hex', hex)}
          />
        </Field>

        {/* 6. Ground color (Mode A baseline) */}
        <Field
          label="Ground baseline color"
          help="Mode A stick-figure ground strip. Default Zenn warm grey."
        >
          <ColorPicker
            value={effective.ground_color_hex}
            onChange={(hex) => set('ground_color_hex', hex)}
          />
        </Field>

        {/* 7. Max canvas-reveal layers */}
        <Field
          label="Max canvas-reveal layers per shot"
          help="Lower = cheaper. Each layer is one Kie i2i Edit at ~$0.05."
        >
          <NumberWithUnit
            value={effective.max_canvas_reveal_layers}
            min={ZENN_V1_BOUNDS.max_canvas_reveal_layers[0]}
            max={ZENN_V1_BOUNDS.max_canvas_reveal_layers[1]}
            step={1}
            unit="layers"
            onChange={(n) => set('max_canvas_reveal_layers', n)}
          />
        </Field>

        {/* 8. Character persistence */}
        <Field
          label="Character persistence"
          help="Reuse one base PNG per character across shots. Off ≈ blow the budget."
        >
          <Toggle
            checked={effective.character_persistence_enabled}
            onChange={(b) => set('character_persistence_enabled', b)}
            onLabel="On"
            offLabel="Off"
          />
        </Field>

        {/* 9. Max unique characters */}
        <Field
          label="Max unique characters per video"
          help="Cap on the LLM's character bank. Real Zenn videos use 3-7."
        >
          <NumberWithUnit
            value={effective.max_unique_characters}
            min={ZENN_V1_BOUNDS.max_unique_characters[0]}
            max={ZENN_V1_BOUNDS.max_unique_characters[1]}
            step={1}
            unit="chars"
            onChange={(n) => set('max_unique_characters', n)}
          />
        </Field>
      </div>

      {/* Reset-to-defaults affordance. Clears the doc's zenn_v1_settings
          field entirely, so the resolver falls back to ZENN_V1_DEFAULTS
          on every render. Useful when the user has experimented and
          wants a clean slate. */}
      <div
        className="flex items-center justify-end mt-3 pt-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
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
// Mirrors the Paint panel's primitives one-for-one. Kept local to this
// file (not extracted into a shared module) because the Paint panel
// already maintains the same primitives locally — extracting them now
// would touch both panels and risk regressing the Paint look. When the
// project ships a shared design system, both panels swap together.

const Field: React.FC<{ label: string; help: string; children: React.ReactNode }> = ({
  label,
  help,
  children,
}) => (
  <div>
    <label
      className="block text-[11px] font-medium mb-1"
      style={{ color: 'var(--text-secondary)' }}
    >
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
    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
      {unit}
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
      background: checked ? 'rgba(211,47,47,0.25)' : 'rgba(255,255,255,0.05)',
      color: checked ? '#EF5350' : 'var(--text-secondary)',
      border: checked ? '1px solid rgba(211,47,47,0.4)' : '1px solid var(--border)',
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
      style={{
        width: 36,
        height: 28,
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'transparent',
        cursor: 'pointer',
      }}
      aria-label="Pick color"
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
      placeholder="#D32F2F"
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
