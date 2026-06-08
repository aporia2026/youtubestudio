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
import type { ShortsBatchWithShorts } from '@/lib/shorts-batches-types';
import type {
  BatchUploadOutcome,
  SingleShortUploadOutcome,
} from '@/lib/shorts-batch-uploader';

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

  if (!bundle) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;

  const readyToUpload = bundle.shorts.filter(
    (s) => s.rendered_video_url && !s.youtube_video_id,
  );
  const alreadyUploaded = bundle.shorts.filter((s) => s.youtube_video_id);

  return (
    <section className="space-y-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
        <h2 className="mb-4 text-lg font-medium text-zinc-900 dark:text-zinc-100">
          Upload to YouTube
        </h2>
        <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
          <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
            <p className="text-xs uppercase text-zinc-500 dark:text-zinc-400">Ready to upload</p>
            <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {readyToUpload.length}
            </p>
            {alreadyUploaded.length > 0 && (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                ({alreadyUploaded.length} already uploaded — skipped)
              </p>
            )}
          </div>
          <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
            <p className="text-xs uppercase text-zinc-500 dark:text-zinc-400">
              Quota today (approximate)
            </p>
            {quota ? (
              <>
                <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                  ~{quota.estimatedRemainingUploads} uploads left
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {quota.unitsCharged} of 10,000 units used · resets at UTC midnight
                </p>
              </>
            ) : (
              <p className="text-xs italic text-zinc-500 dark:text-zinc-400">Loading…</p>
            )}
          </div>
        </div>
        {quota && readyToUpload.length > quota.estimatedRemainingUploads && (
          <p className="mt-3 rounded-md bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
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
          className="rounded-md bg-emerald-700 px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-400 hover:bg-emerald-800"
        >
          {uploading ? 'Uploading…' : `Upload all (${readyToUpload.length})`}
        </button>
      </div>

      {outcome && (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
          <h3 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Upload results
          </h3>
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-700">
            {outcome.processed.map((p) => (
              <OutcomeRow key={p.shortId} outcome={p} />
            ))}
            {outcome.skipped.map((s) => (
              <li key={`skip-${s.shortId}`} className="flex items-center gap-3 py-2 text-sm">
                <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                  Skipped
                </span>
                <span className="flex-1 truncate text-zinc-500 dark:text-zinc-400">{s.reason}</span>
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
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200'
            : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200',
        ].join(' ')}
      >
        {outcome.ok ? outcome.status ?? 'uploaded' : 'failed'}
      </span>
      <span className="flex-1 truncate text-zinc-900 dark:text-zinc-100">
        {outcome.videoId ? (
          <a
            href={`https://studio.youtube.com/video/${outcome.videoId}/edit`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            {outcome.videoId}
          </a>
        ) : (
          outcome.error ?? 'No video id'
        )}
      </span>
      {outcome.playlistResults.length > 0 && (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          + {outcome.playlistResults.filter((r) => r.success).length} playlists
        </span>
      )}
    </li>
  );
}
