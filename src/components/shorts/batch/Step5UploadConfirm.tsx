'use client';

/**
 * Step 5 — confirm schedule, show the quota meter, then trigger
 * /upload-all. Per-short results render inline as the drain
 * completes.
 *
 * The quota meter is approximate (only counts charges this app made
 * today, not the authoritative Google view) — flagged in the UI.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type {
  ShortsBatchWithShorts,
  BatchUploadOutcome,
  SingleShortUploadOutcome,
} from '@/lib/shorts-batches-types';

interface QuotaSnapshot {
  channelId: string;
  utcDate: string;
  unitsCharged: number;
  chargeCount: number;
  remainingUnits: number;
  estimatedRemainingUploads: number;
}

export function Step5UploadConfirm({
  batchId,
  channelId,
}: {
  batchId: string;
  channelId: string;
}) {
  const [bundle, setBundle] = useState<ShortsBatchWithShorts | null>(null);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [uploading, setUploading] = useState(false);
  const [outcome, setOutcome] = useState<BatchUploadOutcome | null>(null);

  const reload = useCallback(async () => {
    const [b, q] = await Promise.all([
      fetch(`/api/shorts/batches/${batchId}`).then((r) => r.json()),
      fetch(`/api/youtube/channel/${channelId}/quota`).then((r) => r.json()),
    ]);
    setBundle(b as ShortsBatchWithShorts);
    setQuota(q as QuotaSnapshot);
  }, [batchId, channelId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const uploadAll = async () => {
    if (!bundle) return;
    setUploading(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- triggers batch upload
      const res = await fetch(`/api/shorts/batches/${batchId}/upload-all`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const result = (await res.json()) as BatchUploadOutcome;
      setOutcome(result);
      toast.success(`Uploaded ${result.processed.filter((p) => p.ok).length} of ${result.processed.length}`);
      void reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  if (!bundle) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;

  const readyToUpload = bundle.shorts.filter(
    (s) => s.rendered_video_url && !s.youtube_video_id,
  );
  const alreadyUploaded = bundle.shorts.filter((s) => s.youtube_video_id);

  return (
    <section className="space-y-6">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-5">
        <h2 className="mb-4 text-lg font-medium text-[var(--text-primary)]">
          Upload to YouTube
        </h2>
        <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
          <div className="rounded-md border border-[var(--border)] p-3">
            <p className="text-xs uppercase text-[var(--text-muted)]">Ready to upload</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">
              {readyToUpload.length}
            </p>
            {alreadyUploaded.length > 0 && (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                ({alreadyUploaded.length} already uploaded — skipped)
              </p>
            )}
          </div>
          <div className="rounded-md border border-[var(--border)] p-3">
            <p className="text-xs uppercase text-[var(--text-muted)]">
              Quota today (approximate)
            </p>
            {quota ? (
              <>
                <p className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">
                  ~{quota.estimatedRemainingUploads} uploads left
                </p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {quota.unitsCharged} of 10,000 units used · resets at UTC midnight
                </p>
              </>
            ) : (
              <p className="text-xs italic text-[var(--text-muted)]">Loading…</p>
            )}
          </div>
        </div>
        {quota && readyToUpload.length > quota.estimatedRemainingUploads && (
          <p className="mt-3 rounded-md bg-[var(--accent-yellow)]/10 p-3 text-xs text-[var(--accent-yellow)]">
            You're trying to upload {readyToUpload.length} shorts but only ~
            {quota.estimatedRemainingUploads} fit in today's quota. YouTube will
            reject the overflow with 403 quotaExceeded. Consider scheduling some
            for tomorrow, or request a quota bump in Google Cloud Console.
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={uploadAll}
          disabled={uploading || readyToUpload.length === 0}
          className="rounded-md bg-[var(--accent-green)] px-5 py-2 text-sm font-medium text-white shadow-[0_0_30px_rgba(16,185,129,0.35)] disabled:cursor-not-allowed disabled:bg-white/[0.05] disabled:text-[var(--text-muted)] hover:bg-[var(--accent-green)]/80"
        >
          {uploading ? 'Uploading…' : `Upload all (${readyToUpload.length})`}
        </button>
      </div>

      {outcome && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-5">
          <h3 className="mb-3 text-sm font-medium text-[var(--text-primary)]">
            Upload results
          </h3>
          <ul className="divide-y divide-[var(--border)]">
            {outcome.processed.map((p) => (
              <OutcomeRow key={p.shortId} outcome={p} />
            ))}
            {outcome.skipped.map((s) => (
              <li key={`skip-${s.shortId}`} className="flex items-center gap-3 py-2 text-sm">
                <span className="shrink-0 rounded-full bg-white/[0.08] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
                  Skipped
                </span>
                <span className="flex-1 truncate text-[var(--text-muted)]">{s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function OutcomeRow({ outcome }: { outcome: SingleShortUploadOutcome }) {
  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      <span
        className={[
          'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
          outcome.ok
            ? 'bg-[var(--accent-green)]/15 text-[var(--accent-green)]'
            : 'bg-red-500/15 text-red-300',
        ].join(' ')}
      >
        {outcome.ok ? outcome.status ?? 'uploaded' : 'failed'}
      </span>
      <span className="flex-1 truncate text-[var(--text-primary)]">
        {outcome.videoId ? (
          <a
            href={`https://studio.youtube.com/video/${outcome.videoId}/edit`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-[var(--accent-purple-bright)]"
          >
            {outcome.videoId}
          </a>
        ) : (
          outcome.error ?? 'No video id'
        )}
      </span>
      {outcome.playlistResults.length > 0 && (
        <span className="text-xs text-[var(--text-muted)]">
          + {outcome.playlistResults.filter((r) => r.success).length} playlists
        </span>
      )}
    </li>
  );
}
