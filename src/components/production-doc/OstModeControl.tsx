'use client';

/**
 * Per-row picker for `ProductionRow.on_screen_text_mode`.
 *
 * Three modes (see `_plans/2026-05-21-phase-5-text-mode-toggle.md`):
 *   - `overlay` → image generates clean, LowerThird composites the text
 *                 at render time. Default for new docs. Guaranteed legible.
 *   - `bake`    → text is baked into the diffusion prompt (animates with
 *                 i2v). Risk of garbled glyphs; suitable for in-world
 *                 signage / hand-lettered styles.
 *   - `none`    → no text anywhere on this row.
 *
 * When the row's own field is undefined, the doc-level default applies
 * — and the active pill shows a small "(default)" mark so the user
 * knows where the value is coming from.
 *
 * Renders inline below the OST text badge in production-doc rows
 * (desktop table and mobile card). When the OST text itself is empty,
 * the parent decides whether to mount this at all.
 */
import React from 'react';

export type OstMode = 'overlay' | 'bake' | 'none';

interface OstModeControlProps {
  /** Row-level value. `undefined` ⇒ inherits doc default. */
  value: OstMode | undefined;
  /** Doc-level default. `undefined` ⇒ renderer falls back to `'bake'`. */
  docDefault: OstMode | undefined;
  /** Persist a new per-row value (caller updates the row). */
  onChange: (next: OstMode) => void;
  /** Apply this mode as the doc-level default and clear per-row overrides
   *  (caller decides whether to mutate other rows). Optional — when omitted,
   *  the "apply to all" affordance is hidden. */
  onApplyToAll?: (mode: OstMode) => void;
}

const OPTIONS: ReadonlyArray<{
  mode: OstMode;
  label: string;
  hint: string;
}> = [
  { mode: 'overlay', label: 'Overlay', hint: 'Clean image; renderer adds the text on top' },
  { mode: 'bake',    label: 'Bake',    hint: 'Text drawn into the image at generation time' },
  { mode: 'none',    label: 'None',    hint: 'No text anywhere on this row' },
];

const FALLBACK_MODE: OstMode = 'bake';

export const OstModeControl: React.FC<OstModeControlProps> = ({
  value,
  docDefault,
  onChange,
  onApplyToAll,
}) => {
  const effective: OstMode = value ?? docDefault ?? FALLBACK_MODE;
  const inheritsDefault = value === undefined;

  return (
    <div className="mt-1 flex items-center gap-1" role="radiogroup" aria-label="On-screen text mode">
      {OPTIONS.map(opt => {
        const isActive = opt.mode === effective;
        const isInheritedActive = isActive && inheritsDefault;
        return (
          <button
            key={opt.mode}
            type="button"
            role="radio"
            aria-checked={isActive}
            title={opt.hint}
            onClick={() => onChange(opt.mode)}
            onContextMenu={
              onApplyToAll
                ? (e) => {
                    e.preventDefault();
                    onApplyToAll(opt.mode);
                  }
                : undefined
            }
            className="px-1.5 py-0.5 rounded text-[0.65rem] font-medium transition-colors"
            style={{
              background: isActive
                ? 'rgba(99, 102, 241, 0.20)'
                : 'transparent',
              color: isActive ? '#a5b4fc' : 'var(--text-muted)',
              border: isActive
                ? '1px solid rgba(99, 102, 241, 0.45)'
                : '1px solid var(--border)',
              cursor: 'pointer',
            }}
          >
            {opt.label}
            {isInheritedActive && (
              <span
                aria-hidden
                title="Inherited from doc default"
                style={{ marginLeft: 4, opacity: 0.6, fontSize: '0.55rem' }}
              >
                ★
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
