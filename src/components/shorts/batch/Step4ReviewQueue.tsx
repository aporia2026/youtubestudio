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

  if (error) return <p className="text-sm text-[var(--accent-yellow)]">{error}</p>;
  if (!bundle) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;

  const { batch, shorts } = bundle;
  const ready = shorts.filter((s) => s.rendered_video_url);
  const stillRendering = shorts.filter((s) => !s.rendered_video_url && !s.generation_progress?.phase);
  const errored = shorts.filter((s) => s.generation_progress?.phase === 'error');

  return (
    <section className="space-y-6">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-[var(--text-primary)]">
              Review {ready.length} ready shorts
            </h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              Edit any field — saves on blur. When you're happy, continue to upload.
            </p>
          </div>
          {(stillRendering.length > 0 || errored.length > 0) && (
            <div className="text-right text-xs text-[var(--text-muted)]">
              {stillRendering.length > 0 && <div>{stillRendering.length} still rendering</div>}
              {errored.length > 0 && (
                <div className="text-red-400">{errored.length} failed</div>
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
          <p className="rounded-md border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]">
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
          className="rounded-md bg-[var(--accent-purple)] px-5 py-2 text-sm font-medium text-white shadow-[0_0_30px_rgba(124,58,237,0.35)] disabled:cursor-not-allowed disabled:bg-white/[0.05] disabled:text-[var(--text-muted)] hover:bg-[var(--accent-purple-bright)]"
        >
          Continue to upload →
        </button>
      </div>
    </section>
  );
}
