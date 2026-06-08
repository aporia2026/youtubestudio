'use client';

/**
 * Step 4 — review queue. Renders one BatchShortReviewCard per short,
 * lets the user edit metadata, then continues to step 5 for the
 * upload action.
 */

import { useCallback, useEffect, useState } from 'react';
import { BatchShortReviewCard } from './BatchShortReviewCard';
import type { ShortsBatchWithShorts } from '@/lib/shorts-batches-types';

export function Step4ReviewQueue({
  batchId,
  onContinue,
}: {
  batchId: string;
  onContinue: () => void;
}) {
  const [bundle, setBundle] = useState<ShortsBatchWithShorts | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/shorts/batches/${batchId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setBundle((await res.json()) as ShortsBatchWithShorts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="text-sm text-amber-600 dark:text-amber-400">{error}</p>;
  if (!bundle) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;

  const { batch, shorts } = bundle;
  const ready = shorts.filter((s) => s.rendered_video_url);
  const stillRendering = shorts.filter((s) => !s.rendered_video_url && !s.generation_progress?.phase);
  const errored = shorts.filter((s) => s.generation_progress?.phase === 'error');

  return (
    <section className="space-y-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
              Review {ready.length} ready shorts
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Edit any field — saves on blur. When you're happy, continue to upload.
            </p>
          </div>
          {(stillRendering.length > 0 || errored.length > 0) && (
            <div className="text-right text-xs text-zinc-500 dark:text-zinc-400">
              {stillRendering.length > 0 && <div>{stillRendering.length} still rendering</div>}
              {errored.length > 0 && (
                <div className="text-red-600 dark:text-red-400">{errored.length} failed</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {ready.map((s) => (
          <BatchShortReviewCard
            key={s.id}
            short={s}
            channelId={batch.channel_id ?? ''}
            batchTimezone={batch.defaults.timezone ?? 'UTC'}
            onSaved={load}
          />
        ))}
        {ready.length === 0 && (
          <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            No shorts rendered yet. The asset pipeline runs separately — once a
            short's render completes, it'll appear here for review.
          </p>
        )}
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onContinue}
          disabled={ready.length === 0}
          className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-400 hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Continue to upload →
        </button>
      </div>
    </section>
  );
}
