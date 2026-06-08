'use client';

/**
 * BatchStepper — top-of-page step indicator for the /shorts/batch
 * workflow. Pure presentation; the parent owns step state.
 *
 * Visual language matches the rest of the app: dark surface with
 * subtle violet accent on the active step.
 */

export type BatchStep = 1 | 2 | 3 | 4 | 5;

const STEPS: ReadonlyArray<{ n: BatchStep; label: string; hint: string }> = [
  { n: 1, label: 'Pick ideas', hint: 'Generate and choose' },
  { n: 2, label: 'Set defaults', hint: 'Voice, schedule, YouTube fields' },
  { n: 3, label: 'Generating', hint: 'Voiceover, SEO, render' },
  { n: 4, label: 'Review', hint: 'Preview and edit metadata' },
  { n: 5, label: 'Upload', hint: 'Schedule and publish' },
];

export function BatchStepper({
  current,
  batchId,
}: {
  current: BatchStep;
  batchId: string | null;
}) {
  return (
    <ol className="flex w-full items-center gap-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-2">
      {STEPS.map((s, i) => {
        const isActive = s.n === current;
        const isComplete = s.n < current;
        return (
          <li
            key={s.n}
            className={[
              'flex min-w-[160px] flex-1 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-[var(--accent-purple)] text-white shadow-[0_0_30px_rgba(124,58,237,0.35)]'
                : isComplete
                ? 'bg-white/[0.05] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)]',
            ].join(' ')}
          >
            <span
              className={[
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                isActive
                  ? 'bg-white text-[var(--accent-purple)]'
                  : isComplete
                  ? 'bg-[var(--accent-purple)]/40 text-white'
                  : 'bg-white/[0.05] text-[var(--text-muted)]',
              ].join(' ')}
              aria-hidden
            >
              {isComplete ? '✓' : s.n}
            </span>
            <span className="flex flex-col leading-tight">
              <span className="font-medium">{s.label}</span>
              <span
                className={[
                  'text-xs',
                  isActive ? 'text-white/80' : 'text-[var(--text-muted)]',
                ].join(' ')}
              >
                {s.hint}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span aria-hidden className="ml-auto text-[var(--text-muted)]">
                →
              </span>
            )}
          </li>
        );
      })}
      {batchId && (
        <li className="ml-2 hidden shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)] sm:block">
          batch <code className="font-mono text-[10px]">{batchId.slice(0, 8)}</code>
        </li>
      )}
    </ol>
  );
}
