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

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePersistedState } from '@/lib/use-persisted-state';

type UploadStatus = 'idle' | 'queued' | 'uploading' | 'uploaded' | 'failed';

/** A row in the form. Two flavours:
 *    - source: 'fresh'   — operator picked a File; we PUT to R2 then
 *                          kick intake with the resulting staging key.
 *    - source: 'library' — operator picked an existing video from a
 *                          previous run via PreviousUploadsPicker. The
 *                          r2Key is already valid (staging-prefix),
 *                          status is 'uploaded' from the start, no
 *                          File present, title + transcript pre-filled. */
interface VideoUpload {
  /** Local-only React key + identity. */
  uid: string;
  source: 'fresh' | 'library';
  /** Present only for source === 'fresh'. */
  file: File | null;
  /** Display title — defaults to filename minus extension for fresh
   *  rows, or the title from the previous run for library rows. */
  title: string;
  transcript: string;
  /** 0–100 during upload, null otherwise. */
  uploadProgress: number | null;
  /** Per-row error so a single broken upload doesn't blow away the
   *  other rows' progress. */
  error: string | null;
  /** R2 object key. For fresh: set after upload. For library: set from
   *  the picker (staging-prefix key from the originating job).
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
  /** Display metadata for library entries — shown instead of the
   *  filename + filesize on fresh rows. */
  libraryMeta: LibraryMeta | null;
}

interface LibraryMeta {
  sourceJobName: string | null;
  sourceJobCreatedAt: string;
  durationSec: number;
  transcriptWordCount: number;
}

/** Wire shape returned by GET /api/channel-clone/uploaded-videos. */
interface UploadedVideoEntry {
  r2Key: string;
  title: string;
  transcript: string;
  transcriptWordCount: number;
  durationSec: number;
  sourceJobId: string;
  sourceJobName: string | null;
  sourceJobCreatedAt: string;
  sourceVideoIndex: number;
}

/** Maximum concurrent R2 uploads. The browser's per-origin
 *  connection cap + R2's own per-file ingest overhead combine to
 *  make 5+ parallel uploads stall and retry from zero. Two at a
 *  time keeps both happy and visibly progresses through the list. */
const MAX_PARALLEL_UPLOADS = 2;

/** Single-attempt PUT. Resolves on 2xx, rejects on any error.
 *  Separated from `putToR2` so the retry wrapper can call it twice. */
async function putToR2Once(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
  abortSignal?: AbortSignal,
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
    if (abortSignal) {
      const onAbort = () => xhr.abort();
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.send(file);
  });
}

/** PUT a file to a presigned R2 URL with progress reporting +
 *  one automatic retry on transient network errors. Resolves on
 *  success, rejects after the second attempt fails.
 *
 *  Why the retry: a single TCP blip on a 50 MB upload otherwise
 *  takes the whole row to FAILED. One automatic retry catches the
 *  vast majority of "ISP hiccup" cases without the operator
 *  having to manually re-trigger.
 *
 *  XMLHttpRequest is used because the Fetch API still has no
 *  upload-progress events as of 2026; without progress the
 *  operator can't tell whether a slow upload is hung or just big. */
async function putToR2(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  try {
    await putToR2Once(url, file, onProgress, abortSignal);
    return;
  } catch (err) {
    // Don't retry on operator-initiated abort.
    if (abortSignal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // Retry on network errors and 5xx; don't retry on 4xx (auth /
    // size / content-type problems won't fix themselves).
    const isRetryable = /network error|R2 PUT failed \(5\d\d\)/.test(msg);
    if (!isRetryable) throw err;
    // Brief backoff so we don't immediately hit the same blip.
    await new Promise((r) => setTimeout(r, 1500));
    onProgress(0); // reset the bar so the operator sees retry attempt
    await putToR2Once(url, file, onProgress, abortSignal);
  }
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
  // Pre-submit text fields persisted to localStorage so a refresh /
  // crash mid-fill doesn't wipe what the operator typed. Files can't
  // be persisted (File objects don't survive JSON), but pasted
  // transcripts can — we keep a draft map keyed by filename so a
  // re-pick of the same file restores the transcript.
  const [sourceLabel, setSourceLabel] = usePersistedState<string>('cc-upload-sourceLabel-draft', '');
  /** Optional canonical YouTube channel URL of the source we're
   *  cloning. When supplied, downstream stages (analyze, publish-
   *  pack) use it to reason about the actual channel — handle,
   *  niche, similar channels — instead of inferring everything
   *  from the uploaded videos alone. */
  const [sourceChannelUrl, setSourceChannelUrl] = usePersistedState<string>(
    'cc-upload-sourceChannelUrl-draft', '');
  const [frameIntervalSec, setFrameIntervalSec] = usePersistedState<5 | 10 | 15>(
    'cc-upload-frameIntervalSec-draft', 10);
  // filename → typed transcript. Survives across pick/re-pick of the
  // same file. Capped implicitly because operators rarely have more
  // than a handful of distinct reference filenames.
  const [transcriptDrafts, setTranscriptDrafts] = usePersistedState<Record<string, string>>(
    'cc-upload-transcript-drafts', {});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // When the operator types in a transcript field, mirror it into
  // the per-filename draft store so a refresh + re-pick recovers it.
  // Used by the textarea onChange handler below via updateTranscript.
  // Library entries have no File to key against, so they don't
  // contribute to the per-filename draft cache — their transcript
  // lives only on the row.
  const updateTranscript = useCallback((uid: string, value: string) => {
    setVideos((prev) => {
      const next = prev.map((v) => (v.uid === uid ? { ...v, transcript: value } : v));
      const target = prev.find((v) => v.uid === uid);
      if (target?.file) {
        const filename = target.file.name;
        setTranscriptDrafts((draft) => ({ ...draft, [filename]: value }));
      }
      return next;
    });
  }, [setTranscriptDrafts]);

  const addFiles = useCallback((files: FileList | File[]) => {
    setVideos((prev) => [
      ...prev,
      ...Array.from(files).map<VideoUpload>((file) => ({
        uid: nextUid(),
        source: 'fresh',
        file,
        title: file.name.replace(/\.[^.]+$/, ''),
        // Restore any previously-typed transcript for this filename
        // from the localStorage draft store. Brand-new files get ''.
        transcript: transcriptDrafts[file.name] ?? '',
        uploadProgress: null,
        error: null,
        r2Key: null,
        status: 'idle',
        libraryMeta: null,
      })),
    ]);
  }, [transcriptDrafts]);

  /** Add entries selected from the "Pick from previous uploads" picker.
   *  Each entry already has a valid staging-prefix r2Key, its title,
   *  and its operator-pasted transcript from the originating run — so
   *  the row starts in 'uploaded' state with nothing pending. The
   *  submit flow's `if (v.status === 'uploaded' && v.r2Key)` short-
   *  circuit skips the actual R2 PUT for these. */
  const addLibraryEntries = useCallback((entries: UploadedVideoEntry[]) => {
    setVideos((prev) => {
      const existing = new Set(prev.map((v) => v.r2Key).filter((k): k is string => !!k));
      const newOnes: VideoUpload[] = entries
        .filter((e) => !existing.has(e.r2Key))
        .map((e) => ({
          uid: nextUid(),
          source: 'library',
          file: null,
          title: e.title,
          transcript: e.transcript,
          uploadProgress: null,
          error: null,
          r2Key: e.r2Key,
          status: 'uploaded',
          libraryMeta: {
            sourceJobName: e.sourceJobName,
            sourceJobCreatedAt: e.sourceJobCreatedAt,
            durationSec: e.durationSec,
            transcriptWordCount: e.transcriptWordCount,
          },
        }));
      return [...prev, ...newOnes];
    });
  }, []);


  const removeAt = useCallback((uid: string) => {
    setVideos((prev) => prev.filter((v) => v.uid !== uid));
  }, []);

  const update = useCallback((uid: string, patch: Partial<VideoUpload>) => {
    setVideos((prev) => prev.map((v) => (v.uid === uid ? { ...v, ...patch } : v)));
  }, []);

  /** Upload one video's bytes to R2. Mints a fresh signed URL each
   *  call (no URL reuse — fewer ways to expire). Reports progress
   *  + final status via `update`. Returns the R2 key on success;
   *  throws on failure with the per-row error already set on state. */
  const uploadOneVideo = useCallback(
    async (uid: string, file: File): Promise<string> => {
      update(uid, { status: 'uploading', uploadProgress: 0, error: null });
      // eslint-disable-next-line no-restricted-syntax -- POST, mint
      const tokenRes = await fetch('/api/channel-clone/r2-upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'video/mp4',
        }),
      });
      const tokenData = (await tokenRes.json()) as { key?: string; uploadUrl?: string; error?: string };
      if (!tokenRes.ok || !tokenData.key || !tokenData.uploadUrl) {
        throw new Error(tokenData.error ?? `Could not mint R2 upload URL (${tokenRes.status})`);
      }
      await putToR2(tokenData.uploadUrl, file, (pct) => {
        update(uid, { uploadProgress: pct });
      });
      update(uid, { status: 'uploaded', uploadProgress: 100, r2Key: tokenData.key });
      return tokenData.key;
    },
    [update],
  );

  /** Per-row Retry button handler. Re-runs uploadOneVideo for one
   *  uid. Does NOT trigger the kickoff — the operator can keep
   *  retrying individual rows, then click the main Start button
   *  again once they're all green. Library entries have no File so
   *  there is nothing to retry — they are immutable assets reused
   *  from a previous run; if their staging key disappeared the
   *  intake-upload route will reject them with a clear message. */
  const retryRow = useCallback(
    async (uid: string) => {
      const target = videos.find((v) => v.uid === uid);
      if (!target || !target.file) return;
      try {
        await uploadOneVideo(uid, target.file);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        update(uid, { status: 'failed', error: msg, uploadProgress: null });
      }
    },
    [videos, uploadOneVideo, update],
  );

  const handleSubmit = useCallback(async () => {
    if (videos.length === 0) return;
    for (const v of videos) {
      if (!v.title.trim()) {
        const label = v.file?.name ?? v.libraryMeta?.sourceJobName ?? 'a reused video';
        setSubmitError(`Each video needs a title (missing on "${label}").`);
        return;
      }
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      // Mark videos that still need uploading as queued. Rows that
      // already succeeded (e.g. operator retried them then hit Start
      // again) keep their 'uploaded' state — no point re-uploading
      // the same bytes.
      setVideos((prev) =>
        prev.map((v) =>
          v.status === 'uploaded' && v.r2Key
            ? v
            : { ...v, status: 'queued', uploadProgress: null, error: null },
        ),
      );

      // 1. Upload each file with bounded concurrency. Per-row errors
      // are CAUGHT inside the worker so one bad row doesn't kill the
      // batch — the row goes to 'failed' state and the operator can
      // hit its Retry button after the others finish.
      type Result = { uid: string; r2Key: string } | { uid: string; failed: true };
      const results = await limitedParallel<VideoUpload, Result>(videos, MAX_PARALLEL_UPLOADS, async (v) => {
        // Library entries + already-uploaded fresh rows skip the PUT.
        if (v.status === 'uploaded' && v.r2Key) {
          return { uid: v.uid, r2Key: v.r2Key };
        }
        if (!v.file) {
          update(v.uid, { status: 'failed', error: 'No file attached and no reusable r2Key — remove this row and re-add.' });
          return { uid: v.uid, failed: true };
        }
        try {
          const r2Key = await uploadOneVideo(v.uid, v.file);
          return { uid: v.uid, r2Key };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          update(v.uid, { status: 'failed', error: msg, uploadProgress: null });
          return { uid: v.uid, failed: true };
        }
      });

      const failed = results.filter((r): r is { uid: string; failed: true } => 'failed' in r);
      if (failed.length > 0) {
        setSubmitError(`${failed.length} upload${failed.length === 1 ? '' : 's'} failed — click Retry next to each red row, then hit Start again.`);
        return;
      }
      const uploadedKeys = results.filter((r): r is { uid: string; r2Key: string } => 'r2Key' in r);

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
  }, [videos, sourceLabel, sourceChannelUrl, frameIntervalSec, update, uploadOneVideo, onSubmitted]);

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

      <PreviousUploadsPicker
        alreadyPickedKeys={new Set(videos.map((v) => v.r2Key).filter((k): k is string => !!k))}
        onAdd={addLibraryEntries}
        disabled={submitting}
      />

      <div
        className={`rounded border-2 border-dashed p-4 text-center transition-colors ${
          dragOver ? 'border-neutral-300 bg-neutral-900' : 'border-neutral-700 bg-neutral-950/60'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const dropped = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('video/'));
          if (dropped.length > 0) addFiles(dropped);
        }}
      >
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
          MP4 / WebM / MOV / MKV · up to 500 MB per file · max 8 videos per job · drag &amp; drop also works
        </p>
      </div>

      {videos.length > 0 && (
        <ul className="space-y-3">
          {videos.map((v) => (
            <li
              key={v.uid}
              className={`space-y-2 rounded border p-3 text-xs ${
                v.source === 'library'
                  ? 'border-sky-900 bg-sky-950/20'
                  : 'border-neutral-800 bg-neutral-950'
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0 flex-1 truncate">
                  {v.source === 'fresh' && v.file ? (
                    <>
                      <span className="font-mono text-[10px] text-neutral-500">
                        {(v.file.size / (1024 * 1024)).toFixed(1)} MB
                      </span>
                      <span className="ml-2 text-neutral-300">{v.file.name}</span>
                    </>
                  ) : (
                    <>
                      <span className="rounded bg-sky-900/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-sky-200">
                        reused
                      </span>
                      <span className="ml-2 text-neutral-300">
                        {v.libraryMeta?.sourceJobName ?? 'previous run'} ·{' '}
                        {v.libraryMeta ? formatDurationSec(v.libraryMeta.durationSec) : ''}
                      </span>
                    </>
                  )}
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
                  onChange={(e) => updateTranscript(v.uid, e.target.value)}
                  disabled={submitting}
                  rows={4}
                  placeholder="Paste transcript from YouTube's Show transcript button…"
                  className="w-full resize-y rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono text-[10px] leading-relaxed text-neutral-100 outline-none focus:border-neutral-500 disabled:opacity-50"
                />
              </label>
              <UploadStatusRow status={v.status} progress={v.uploadProgress} />
              {v.error && (
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="flex-1 break-all text-[10px] text-red-300">{v.error}</p>
                  {v.source === 'fresh' && (
                    <button
                      type="button"
                      onClick={() => void retryRow(v.uid)}
                      disabled={v.status === 'uploading'}
                      className="shrink-0 rounded border border-amber-700 bg-amber-950/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-300 hover:border-amber-500 hover:bg-amber-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Retry
                    </button>
                  )}
                </div>
              )}
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
            : (() => {
                const freshCount = videos.filter((v) => v.source === 'fresh').length;
                const libraryCount = videos.length - freshCount;
                if (freshCount === 0) {
                  return `Start intake from ${libraryCount} reused video${libraryCount === 1 ? '' : 's'}`;
                }
                if (libraryCount === 0) {
                  return `Start intake from ${freshCount} upload${freshCount === 1 ? '' : 's'}`;
                }
                return `Start intake from ${freshCount} upload${freshCount === 1 ? '' : 's'} + ${libraryCount} reused`;
              })()}
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

/** Format a duration in seconds as `M:SS`. Cheap, no Intl. */
function formatDurationSec(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '?:??';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format an ISO timestamp as a short relative date (e.g. "2d ago",
 *  "5 May"). Lay-readable; no Intl.RelativeTimeFormat to keep the
 *  bundle small. */
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays < 1) return 'today';
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface PreviousUploadsPickerProps {
  /** R2 keys already present in the form (so duplicate picks are
   *  visibly disabled in the picker rather than silently dropped). */
  alreadyPickedKeys: Set<string>;
  onAdd: (entries: UploadedVideoEntry[]) => void;
  disabled: boolean;
}

/** Expandable "Pick from previous uploads" panel. Lazy-fetches the
 *  workspace-scoped library on first open so a page load doesn't burn
 *  R2 HEAD probes for operators who never use the feature. Renders a
 *  checkbox list with per-item title + source-run label + duration +
 *  transcript word count, plus a refresh button.
 *
 *  Bandwidth note: the API HEAD-probes every staging key, so first
 *  open on a workspace with hundreds of past runs can take ~1-3 s.
 *  The intermediate state shows a loading line so the operator
 *  doesn't think the button broke. */
function PreviousUploadsPicker({ alreadyPickedKeys, onAdd, disabled }: PreviousUploadsPickerProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<UploadedVideoEntry[] | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- workspace-scoped GET
      const res = await fetch('/api/channel-clone/uploaded-videos');
      const data = (await res.json()) as { videos?: UploadedVideoEntry[]; error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Could not load previous uploads (${res.status})`);
      }
      setEntries(data.videos ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy first-fetch on open. Idempotent: re-opens reuse the cached
  // entries — operator clicks Refresh if they want a fresh probe.
  useEffect(() => {
    if (open && entries === null && !loading && error === null) {
      void refetch();
    }
  }, [open, entries, loading, error, refetch]);

  const toggleKey = (key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAdd = () => {
    if (!entries || checkedKeys.size === 0) return;
    const picked = entries.filter((e) => checkedKeys.has(e.r2Key));
    onAdd(picked);
    setCheckedKeys(new Set());
    setOpen(false);
  };

  return (
    <div className="rounded border border-sky-900/60 bg-sky-950/10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-sky-200 hover:text-sky-100 disabled:opacity-50"
      >
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10px]">{open ? '▼' : '▶'}</span>
          <span className="font-medium">Pick from previous uploads</span>
        </span>
        <span className="text-[10px] text-sky-400/80">
          reuse videos + transcripts you already uploaded
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-sky-900/60 p-3">
          {loading && <p className="text-xs text-neutral-400">Scanning previous runs…</p>}
          {error && (
            <div className="flex items-center justify-between gap-2 text-xs text-red-300">
              <span className="flex-1 break-all">{error}</span>
              <button
                type="button"
                onClick={() => void refetch()}
                className="shrink-0 rounded border border-red-700 bg-red-950/30 px-2 py-0.5 text-[10px] hover:bg-red-900/50"
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !error && entries && entries.length === 0 && (
            <p className="text-xs text-neutral-500">
              No reusable videos found. Upload some videos in a clone run and they will show up
              here for reuse on every future run.
            </p>
          )}
          {entries && entries.length > 0 && (
            <>
              <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
                {entries.map((e) => {
                  const alreadyPicked = alreadyPickedKeys.has(e.r2Key);
                  const checked = checkedKeys.has(e.r2Key);
                  return (
                    <li
                      key={e.r2Key}
                      className={`rounded border p-2 text-xs ${
                        alreadyPicked
                          ? 'border-neutral-800 bg-neutral-900/40 opacity-60'
                          : checked
                            ? 'border-emerald-700 bg-emerald-950/30'
                            : 'border-neutral-800 bg-neutral-900 hover:border-neutral-600'
                      }`}
                    >
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          checked={checked || alreadyPicked}
                          disabled={alreadyPicked}
                          onChange={() => toggleKey(e.r2Key)}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-neutral-200">{e.title}</div>
                          <div className="text-[10px] text-neutral-500">
                            {e.sourceJobName ?? 'previous run'} ·{' '}
                            {formatShortDate(e.sourceJobCreatedAt)} ·{' '}
                            {formatDurationSec(e.durationSec)} ·{' '}
                            {e.transcriptWordCount > 0
                              ? `${e.transcriptWordCount.toLocaleString()} words`
                              : 'no transcript'}
                            {alreadyPicked && ' · already in list'}
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void refetch()}
                  disabled={loading}
                  className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
                >
                  Refresh list
                </button>
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={checkedKeys.size === 0}
                  className="rounded bg-sky-300 px-3 py-1 text-xs font-medium text-sky-950 hover:bg-sky-200 disabled:bg-neutral-700 disabled:text-neutral-400"
                >
                  {checkedKeys.size === 0
                    ? 'Add to upload list'
                    : `Add ${checkedKeys.size} to upload list`}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
