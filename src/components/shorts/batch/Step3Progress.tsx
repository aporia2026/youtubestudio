'use client';

/**
 * Step 3 — generation progress. Polls /api/shorts/batches/[id] every
 * 4 seconds AND POSTs /run-tick on each poll so the orchestrator
 * keeps draining shorts. When the batch reaches 'review' status the
 * parent advances to step 4.
 *
 * The 4s cadence is a compromise between perceived responsiveness and
 * not hammering the LLM/TTS APIs while a tick is mid-flight. Each
 * tick takes 5-30s depending on which stage runs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShortsBatchWithShorts, BatchTickResult } from '@/lib/shorts-batches-types';
import type { ShortRow } from '@/lib/shorts-types';
import { nextStageFor } from '@/lib/shorts-batch-stages';

interface Props {
  batchId: string;
  onDone: () => void;
}

const POLL_MS = 4_000;

export function Step3Progress({ batchId, onDone }: Props) {
  const [bundle, setBundle] = useState<ShortsBatchWithShorts | null>(null);
  const [lastTick, setLastTick] = useState<BatchTickResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tickInFlightRef = useRef(false);

  const fetchBundle = useCallback(async () => {
    const res = await fetch(`/api/shorts/batches/${batchId}`);
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    return (await res.json()) as ShortsBatchWithShorts;
  }, [batchId]);

  const runTick = useCallback(async () => {
    if (tickInFlightRef.current) return;
    tickInFlightRef.current = true;
    try {
      // eslint-disable-next-line no-restricted-syntax -- orchestrator drain
      const res = await fetch(`/api/shorts/batches/${batchId}/run-tick`, { method: 'POST' });
      if (res.ok) {
        const result = (await res.json()) as BatchTickResult;
        setLastTick(result);
      }
    } finally {
      tickInFlightRef.current = false;
    }
  }, [batchId]);

  useEffect(() => {
    let cancelled = false;

    const cycle = async () => {
      try {
        await runTick();
        if (cancelled) return;
        const next = await fetchBundle();
        if (cancelled) return;
        setBundle(next);
        if (next.batch.status === 'review' || next.batch.status === 'done') {
          onDone();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Tick failed');
      }
    };

    void cycle();
    const id = setInterval(() => {
      void cycle();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchBundle, runTick, onDone]);

  if (!bundle && !error) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Starting orchestrator…</p>;
  }
  if (error) {
    return <p className="text-sm text-amber-600 dark:text-amber-400">{error}</p>;
  }
  if (!bundle) return null;

  const totals = bundle.batch.totals;
  const pct = totals.planned ? Math.round(((totals.generated + totals.failed) / totals.planned) * 100) : 0;

  return (
    <section className="space-y-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
            Generating {totals.planned} shorts
          </h2>
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {totals.generated} ready · {totals.failed} failed · {pct}%
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
          <div
            className="h-full bg-zinc-900 transition-all dark:bg-white"
            style={{ width: `${pct}%` }}
          />
        </div>
        {lastTick && (
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            Last tick: claimed {lastTick.claimed}, advanced {lastTick.advanced}, failed {lastTick.failed} ({lastTick.duration_ms}ms)
          </p>
        )}
      </div>

      <ul className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-700 dark:border-zinc-700 dark:bg-zinc-800">
        {bundle.shorts.map((s) => (
          <ShortRowItem key={s.id} short={s} />
        ))}
      </ul>
    </section>
  );
}

function ShortRowItem({ short }: { short: ShortRow }) {
  const stage = nextStageFor(short);
  const error = short.generation_progress?.phase === 'error' ? short.generation_progress.error_message : null;

  const badge = (() => {
    if (error) return { label: 'Error', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200' };
    if (stage === 'terminal' && short.rendered_video_url) return { label: 'Ready', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200' };
    if (stage === 'awaiting_render') return { label: 'Awaiting render', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200' };
    if (stage === 'extract') return { label: 'Writing script…', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200' };
    if (stage === 'voiceover') return { label: 'Voiceover…', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200' };
    if (stage === 'seo') return { label: 'SEO…', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200' };
    return { label: stage, cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200' };
  })();

  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <span className={['shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', badge.cls].join(' ')}>
        {badge.label}
      </span>
      <span className="flex-1 truncate text-zinc-900 dark:text-zinc-100">
        {short.title ?? short.hook ?? '(untitled)'}
      </span>
      {error && (
        <span className="max-w-md truncate text-xs text-red-600 dark:text-red-400" title={error}>
          {error}
        </span>
      )}
    </li>
  );
}
