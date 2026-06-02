/**
 * Doc-level pacing-profile picker.
 *
 * PR3 of `_plans/2026-06-03-production-doc-flow-stabilization.md`.
 *
 * Three pills (Standard / Fast / Very Fast) plus a one-line
 * explanation for each. The selected profile is persisted onto
 * `doc.pacing_profile` and read by `productionDocPrompt` to size
 * per-row word budgets and by `applyPacingPostProcess` to enforce
 * the opening-hook directive deterministically.
 *
 * Why doc-level (not style-specific): pacing applies to every video
 * regardless of style. A doodle doc on Very Fast still has the same
 * opening-hook rules a paint doc on Very Fast does. Keeping this
 * separate from the style-specific panels means a future style added
 * tomorrow doesn't have to re-implement the pacing controls.
 *
 * Rule 5: no AI tells. Plain labels, plain explanations.
 * Rule 16: clean, intuitive, clear. Each pill self-explains.
 */
import React from 'react';

export type PacingProfile = 'standard' | 'fast' | 'very_fast';

interface PacingProfilePanelProps {
  value: PacingProfile | undefined;
  onChange: (next: PacingProfile) => void;
}

interface ProfileOption {
  value: PacingProfile;
  label: string;
  /** Short pace summary — sits on the pill itself. */
  paceText: string;
  /** Longer one-liner — sits below the pill row when this option is
   *  the active one, so the user sees the consequence of their pick
   *  without hovering for a tooltip. */
  description: string;
}

const OPTIONS: ReadonlyArray<ProfileOption> = [
  {
    value: 'standard',
    label: 'Standard',
    paceText: '4–6 s per shot',
    description:
      "Classic pace. Longer holds, fewer cuts. Good for slower documentary-style narration where the script carries the energy.",
  },
  {
    value: 'fast',
    label: 'Fast',
    paceText: '3–4 s per shot',
    description:
      "The new default. Tighter cuts, opening hook enforced (no static-base holds in the first 6 s). The pace most YouTube explainers feel best at.",
  },
  {
    value: 'very_fast',
    label: 'Very Fast',
    paceText: '2–3 s per shot',
    description:
      "TikTok-tier pace. Higher generation cost (~30% more shots = more image calls). Use when retention curves drop hard in the first 15 seconds.",
  },
];

export const PacingProfilePanel: React.FC<PacingProfilePanelProps> = ({ value, onChange }) => {
  // Undefined → treat as 'fast' visually (the new default) but DON'T
  // emit a value automatically. Keeps the doc's stored pacing_profile
  // null/undefined when the user hasn't touched it, so a later default
  // change can flow through for unedited docs.
  const effective: PacingProfile = value ?? 'fast';
  const activeOption = OPTIONS.find((o) => o.value === effective) ?? OPTIONS[1];

  return (
    <div
      style={{
        padding: 12,
        border: '1px solid rgba(34,211,238,0.20)',
        borderRadius: 8,
        background: 'rgba(34,211,238,0.04)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <label
          className="block text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--accent-cyan-bright)' }}
        >
          Pacing
        </label>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          per video
        </span>
      </div>

      <div role="radiogroup" aria-label="Pacing profile" className="flex flex-wrap gap-2 mb-2">
        {OPTIONS.map((opt) => {
          const active = opt.value === effective;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt.value)}
              className="flex flex-col items-start px-3 py-2 rounded-md transition-colors"
              style={{
                background: active ? 'rgba(34,211,238,0.18)' : 'rgba(255,255,255,0.04)',
                color: active ? '#67e8f9' : 'var(--text-secondary)',
                border: active
                  ? '1px solid rgba(34,211,238,0.45)'
                  : '1px solid var(--border)',
                cursor: 'pointer',
                minWidth: 120,
              }}
            >
              <span className="text-xs font-semibold">{opt.label}</span>
              <span
                className="text-[10px] mt-0.5"
                style={{ color: active ? '#a5f3fc' : 'var(--text-muted)' }}
              >
                {opt.paceText}
              </span>
            </button>
          );
        })}
      </div>

      <div className="text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
        {activeOption.description}
        {value === undefined && (
          <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
            (default — set by clicking a pill)
          </span>
        )}
      </div>
    </div>
  );
};
