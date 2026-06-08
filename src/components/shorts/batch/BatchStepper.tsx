'use client';

/**
 * BatchStepper — top-of-page step indicator for the /shorts/batch
 * workflow. Pure presentation; the parent owns step state.
 *
 * Per rule 16 (UI/UX must be clean + intuitive): every step has a
 * short label so the user knows what's coming, and the active step
 * + already-completed steps are visually distinct from upcoming.
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
    <ol className="flex w-full items-center gap-1 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-900">
      {STEPS.map((s, i) => {
        const isActive = s.n === current;
        const isComplete = s.n < current;
        return (
          <li
            key={s.n}
            className={[
              'flex min-w-[160px] flex-1 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900'
                : isComplete
                ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'
                : 'text-zinc-500 dark:text-zinc-400',
            ].join(' ')}
          >
            <span
              className={[
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                isActive
                  ? 'bg-white text-zinc-900 dark:bg-zinc-900 dark:text-white'
                  : isComplete
                  ? 'bg-zinc-500 text-white'
                  : 'bg-zinc-300 text-zinc-600 dark:bg-zinc-600 dark:text-zinc-300',
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
                  isActive ? 'text-zinc-200 dark:text-zinc-600' : 'text-zinc-500 dark:text-zinc-500',
                ].join(' ')}
              >
                {s.hint}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span aria-hidden className="ml-auto text-zinc-300 dark:text-zinc-600">
                →
              </span>
            )}
          </li>
        );
      })}
      {batchId && (
        <li className="ml-2 hidden shrink-0 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-500 sm:block dark:border-zinc-700 dark:text-zinc-400">
          batch <code className="font-mono text-[10px]">{batchId.slice(0, 8)}</code>
        </li>
      )}
    </ol>
  );
}
