'use client';

/**
 * Manual-upload intake form. Companion to the URL paste form in
 * `ChannelClonePanel.tsx` — same downstream behaviour, no YouTube
 * anti-bot surface.
 *
 * Flow:
 *   1. Operator picks N video files via the file input or drag-drop.
 *   2. For each file we render a card with: filename + size, an
 *      editable title, and a transcript paste area (optional).
 *   3. Submit:
 *      a. For every file, upload bytes DIRECTLY to Vercel Blob via
 *         the @vercel/blob/client `upload()` helper (which mints a
 *         signed token from /api/channel-clone/upload-token first).
 *         The function's body-size limit is bypassed entirely.
 *      b. POST the resulting Blob URLs + titles + transcripts to
 *         /api/channel-clone/intake-upload, get a jobId back.
 *      c. Hand the jobId to the parent so the same recent-runs
 *         polling / progress log surfaces this run too.
 *
 * Per-file progress: `upload()` exposes `onUploadProgress` with a
 * 0-100 percentage; we wire it into a per-row progress bar so the
 * operator can see "is my 50 MB upload moving or stuck."
 */

import { useCallback, useRef, useState } from 'react';

type UploadStatus = 'idle' | 'queued' | 'uploading' | 'uploaded' | 'failed';

interface VideoUpload {
  /** Local-only React key + identity. */
  uid: string;
  file: File;
  /** Display title — defaults to filename minus extension. */
  title: string;
  transcript: string;
  /** 0–100 during upload, null otherwise. */
  uploadProgress: number | null;
  /** Per-row error so a single broken upload doesn't blow away the
   *  other rows' progress. */
  error: string | null;
  /** R2 object key once upload finishes — used by the kickoff POST.
   *  The server validates the key prefix matches the caller's
   *  workspace before signing a download URL for the sandbox. */
  r2Key: string | null;
  /** Lifecycle stage so the operator can see exactly what's happening:
   *    idle      — picked but not yet submitted
   *    queued    — waiting for a free upload slot (we cap concurrency)
   *    uploading — bytes in flight; pair with `uploadProgress`
   *    uploaded  — Vercel Blob confirmed; awaiting kickoff
   *    failed    — see `error` */
  status: UploadStatus;
}

/** Maximum concurrent R2 uploads. The browser's per-origin
 *  connection cap + R2's own per-file ingest overhead combine to
 *  make 5+ parallel uploads stall and retry from zero. Two at a
 *  time keeps both happy and visibly progresses through the list. */
const MAX_PARALLEL_UPLOADS = 2;

/** PUT a file to a presigned R2 URL with progress reporting.
 *  Resolves with the R2 key on success (so the caller can hand it
 *  back to the kickoff endpoint), rejects on any HTTP error.
 *
 *  Uses XMLHttpRequest because the Fetch API still has no upload-
 *  progress events as of 2026; without progress the operator can't
 *  tell whether a slow upload is hung or just big. */
async function putToR2(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (evt) => {
      if (!evt.lengthComputable) return;
      onProgress(Math.round((evt.loaded / evt.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        // R2 returns plain XML on error; surface the status code
        // (and the first bit of the body) so the operator can
        // distinguish "403 signed URL expired" from "413 too big"
        // from network blip.
        reject(new Error(`R2 PUT failed (${xhr.status}): ${xhr.responseText.slice(0, 200)}`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('R2 PUT network error')));
    xhr.addEventListener('abort', () => reject(new Error('R2 PUT aborted')));
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.send(file);
  });
}

/** Run `fn` over `items` with at most `limit` in flight at once.
 *  Errors propagate via the returned promise so the form's catch
 *  block surfaces them. */
async function limitedParallel<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export interface ChannelCloneUploadFormProps {
  onSubmitted: (jobId: string) => void;
}

let uidCounter = 0;
function nextUid(): string {
  uidCounter += 1;
  return `up-${Date.now().toString(36)}-${uidCounter.toString(36)}`;
}

export function ChannelCloneUploadForm({ onSubmitted }: ChannelCloneUploadFormProps) {
  const [videos, setVideos] = useState<VideoUpload[]>([]);
  const [sourceLabel, setSourceLabel] = useState('');
  /** Optional canonical YouTube channel URL of the source we're
   *  cloning. When supplied, downstream stages (analyze, publish-
   *  pack) use it to reason about the actual channel — handle,
   *  niche, similar channels — instead of inferring everything
   *  from the uploaded videos alone. */
  const [sourceChannelUrl, setSourceChannelUrl] = useState('');
  const [frameIntervalSec, setFrameIntervalSec] = useState<5 | 10 | 15>(10);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    setVideos((prev) => [
      ...prev,
      ...Array.from(files).map<VideoUpload>((file) => ({
        uid: nextUid(),
        file,
        title: file.name.replace(/\.[^.]+$/, ''),
        transcript: '',
        uploadProgress: null,
        error: null,
        r2Key: null,
        status: 'idle',
      })),
    ]);
  }, []);

  const removeAt = useCallback((uid: string) => {
    setVideos((prev) => prev.filter((v) => v.uid !== uid));
  }, []);

  const update = useCallback((uid: string, patch: Partial<VideoUpload>) => {
    setVideos((prev) => prev.map((v) => (v.uid === uid ? { ...v, ...patch } : v)));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (videos.length === 0) return;
    for (const v of videos) {
      if (!v.title.trim()) {
        setSubmitError(`Each video needs a title (missing on "${v.file.name}").`);
        return;
      }
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      // Mark every video queued up front so the operator sees the
      // pipeline state immediately — without this the rows past the
      // first MAX_PARALLEL_UPLOADS look idle until their slot opens.
      setVideos((prev) =>
        prev.map((v) => ({ ...v, status: 'queued', uploadProgress: null, error: null })),
      );

      // 1. Upload each file with bounded concurrency.
      // Per-file flow:
      //   a. POST /api/channel-clone/r2-upload-url → presigned PUT.
      //   b. XHR PUT the bytes directly to R2 with progress events.
      //   c. Capture the R2 key for the kickoff POST.
      const uploadedKeys = await limitedParallel(videos, MAX_PARALLEL_UPLOADS, async (v) => {
        try {
          update(v.uid, { status: 'uploading', uploadProgress: 0, error: null });
          // eslint-disable-next-line no-restricted-syntax -- POST, mint
          const tokenRes = await fetch('/api/channel-clone/r2-upload-url', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              filename: v.file.name,
              contentType: v.file.type || 'video/mp4',
            }),
          });
          const tokenData = (await tokenRes.json()) as { key?: string; uploadUrl?: string; error?: string };
          if (!tokenRes.ok || !tokenData.key || !tokenData.uploadUrl) {
            throw new Error(tokenData.error ?? `Could not mint R2 upload URL (${tokenRes.status})`);
          }
          await putToR2(tokenData.uploadUrl, v.file, (pct) => {
            update(v.uid, { uploadProgress: pct });
          });
          update(v.uid, { status: 'uploaded', uploadProgress: 100, r2Key: tokenData.key });
          return { uid: v.uid, r2Key: tokenData.key };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          update(v.uid, { status: 'failed', error: msg, uploadProgress: null });
          throw err;
        }
      });

      // 2. Kick off the intake. The route's `after()` wrapper keeps
      // the function alive for the full sandbox run.
      const res = await fetch('/api/channel-clone/intake-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceLabel: sourceLabel.trim(),
          sourceChannelUrl: sourceChannelUrl.trim() || undefined,
          frameIntervalSec,
          videos: videos.map((v) => {
            const uploaded = uploadedKeys.find((u) => u.uid === v.uid);
            return {
              r2Key: uploaded?.r2Key ?? v.r2Key ?? '',
              title: v.title.trim(),
              transcript: v.transcript,
            };
          }),
        }),
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) {
        setSubmitError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      onSubmitted(data.jobId);
      setVideos([]);
      setSourceLabel('');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [videos, sourceLabel, frameIntervalSec, update, onSubmitted]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-400">
        Upload reference videos directly — bypasses YouTube entirely. Best for channels you can already access via your
        own yt-dlp / browser. Frames are extracted server-side; paste the YouTube transcript text below each video
        (use YouTube's &ldquo;Show transcript&rdquo; on the video page, copy &amp; paste).
      </p>

      <label className="block text-xs text-neutral-300">
        <span className="block pb-1 font-medium">
          Source channel URL <span className="text-neutral-500">(recommended — lets the analyze + publish-pack stages see the real channel, not just your uploads)</span>
        </span>
        <input
          type="url"
          value={sourceChannelUrl}
          onChange={(e) => setSourceChannelUrl(e.target.value)}
          placeholder="https://www.youtube.com/@Zenn0009"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100 outline-none focus:border-neutral-500"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-neutral-300">
          <span className="block pb-1 font-medium">Source label (optional)</span>
          <input
            type="text"
            value={sourceLabel}
            onChange={(e) => setSourceLabel(e.target.value)}
            placeholder="Doodle explainers I admire"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100 outline-none focus:border-neutral-500"
          />
        </label>
        <label className="block text-xs text-neutral-300">
          <span className="block pb-1 font-medium">Frame interval (sec)</span>
          <select
            value={frameIntervalSec}
            onChange={(e) => setFrameIntervalSec(Number(e.target.value) as 5 | 10 | 15)}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100 outline-none focus:border-neutral-500"
          >
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={15}>15</option>
          </select>
        </label>
      </div>

      <div className="rounded border-2 border-dashed border-neutral-700 bg-neutral-950/60 p-4 text-center">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded bg-neutral-200 px-4 py-2 text-xs font-medium text-neutral-900 hover:bg-white"
        >
          Choose video files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/mp4,video/webm,video/quicktime,video/x-matroska"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
            // Reset the input so picking the same file twice still
            // triggers the change event.
            e.target.value = '';
          }}
        />
        <p className="mt-2 text-[10px] text-neutral-500">
          MP4 / WebM / MOV / MKV · up to 500 MB per file · max 8 videos per job
        </p>
      </div>

      {videos.length > 0 && (
        <ul className="space-y-3">
          {videos.map((v) => (
            <li key={v.uid} className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0 flex-1 truncate">
                  <span className="font-mono text-[10px] text-neutral-500">{(v.file.size / (1024 * 1024)).toFixed(1)} MB</span>
                  <span className="ml-2 text-neutral-300">{v.file.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeAt(v.uid)}
                  disabled={submitting}
                  className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 font-mono text-[10px] text-neutral-400 hover:border-red-700 hover:text-red-300 disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
              <label className="block">
                <span className="block pb-0.5 font-medium text-neutral-300">Title</span>
                <input
                  type="text"
                  value={v.title}
                  onChange={(e) => update(v.uid, { title: e.target.value })}
                  disabled={submitting}
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </label>
              <label className="block">
                <span className="block pb-0.5 font-medium text-neutral-300">
                  Transcript <span className="text-neutral-500">(optional — paste plain text or SRT)</span>
                </span>
                <textarea
                  value={v.transcript}
                  onChange={(e) => update(v.uid, { transcript: e.target.value })}
                  disabled={submitting}
                  rows={4}
                  placeholder="Paste transcript from YouTube's Show transcript button…"
                  className="w-full resize-y rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono text-[10px] leading-relaxed text-neutral-100 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </label>
              <UploadStatusRow status={v.status} progress={v.uploadProgress} />
              {v.error && <p className="break-all text-[10px] text-red-300">{v.error}</p>}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={submitting || videos.length === 0}
        className="w-full rounded bg-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
      >
        {submitting
          ? 'Uploading + starting intake…'
          : videos.length === 0
            ? 'Pick at least one video to start'
            : `Start intake from ${videos.length} upload${videos.length === 1 ? '' : 's'}`}
      </button>
      {submitError && <p className="text-xs text-red-400">{submitError}</p>}
    </div>
  );
}

/** Inline progress + status badge for one row. Renders nothing
 *  before submission (status === 'idle'); switches to a labelled
 *  badge once the operator hits Start, plus a progress bar when
 *  bytes are actively moving. The label uses lay-readable verbs
 *  ("waiting", "uploading", "done") rather than the internal enum
 *  so a confused user can self-diagnose without a glossary. */
function UploadStatusRow({ status, progress }: { status: UploadStatus; progress: number | null }) {
  if (status === 'idle') return null;
  const label =
    status === 'queued' ? 'waiting in queue'
    : status === 'uploading' ? (progress !== null ? `uploading ${progress}%` : 'uploading')
    : status === 'uploaded' ? 'uploaded — waiting for the others'
    : 'failed';
  const colour =
    status === 'failed' ? 'text-red-300'
    : status === 'uploaded' ? 'text-emerald-300'
    : status === 'uploading' ? 'text-amber-300'
    : 'text-neutral-400';
  return (
    <div className="space-y-1">
      <div className={`font-mono text-[9px] uppercase tracking-wide ${colour}`}>{label}</div>
      {progress !== null && (
        <div className="h-1 w-full overflow-hidden rounded bg-neutral-800">
          <div
            className={`h-full transition-all ${
              status === 'failed' ? 'bg-red-500'
              : status === 'uploaded' ? 'bg-emerald-500'
              : 'bg-amber-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
