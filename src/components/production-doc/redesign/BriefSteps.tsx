'use client';

import React from 'react';

/**
 * BriefSteps — the four-step Notebook progress indicator that lives
 * under `BriefHeader`. See `_plans/2026-06-04-production-doc-redesign.md`
 * §4.1 for the target Notebook layout.
 *
 * Phase R1b (this PR): ships the visual chrome that announces the
 * top-to-bottom workflow (Brief → Style → Script → Generate). The
 * legacy input panel still renders below it untouched. R1c will
 * progressively migrate the input chunks into BriefStepCard wrappers
 * that hang off this indicator.
 *
 * The component is purely visual — no clicks, no scroll-jump. Adding
 * navigation requires anchored scroll targets in each step's content,
 * which only exist after R1c migrates inputs into BriefStepCards. Per
 * rule 10, no fake-interactive controls.
 */
export interface BriefStepsProps {
  /** Which step the user is currently on. Defaults to 1 (the first
   *  step is active by default since pre-generation users always
   *  start at the brief). */
  current?: 1 | 2 | 3 | 4;
}

const STEPS: ReadonlyArray<{ n: 1 | 2 | 3 | 4; label: string }> = [
  { n: 1, label: 'Brief' },
  { n: 2, label: 'Style' },
  { n: 3, label: 'Script' },
  { n: 4, label: 'Generate' },
];

export const BriefSteps: React.FC<BriefStepsProps> = ({ current = 1 }) => {
  return (
    <nav
      aria-label="Production doc workflow"
      className="mb-6 flex flex-wrap items-center gap-3"
    >
      {STEPS.map((step, idx) => {
        const isCurrent = step.n === current;
        const isPast = step.n < current;
        return (
          <React.Fragment key={step.n}>
            <div
              className="flex items-center gap-2"
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
                style={{
                  background: isCurrent
                    ? 'var(--accent-purple-bright, #a78bfa)'
                    : isPast
                      ? 'rgba(124,58,237,0.18)'
                      : 'rgba(255,255,255,0.04)',
                  color: isCurrent
                    ? '#0a0a0a'
                    : isPast
                      ? 'var(--accent-purple-bright, #a78bfa)'
                      : 'var(--text-muted)',
                  border: isCurrent
                    ? 'none'
                    : '1px solid rgba(255,255,255,0.10)',
                }}
              >
                {step.n}
              </span>
              <span
                className="text-sm"
                style={{
                  color: isCurrent
                    ? 'var(--text-primary)'
                    : 'var(--text-muted)',
                  fontWeight: isCurrent ? 600 : 400,
                }}
              >
                {step.label}
              </span>
            </div>
            {idx < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className="h-px flex-1 max-w-[48px]"
                style={{ background: 'rgba(255,255,255,0.08)' }}
              />
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
};
