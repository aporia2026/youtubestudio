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
import { upload } from '@vercel/blob/client';

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
  /** Blob URL once upload finishes — used by the kickoff POST. */
  blobUrl: string | null;
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
  const [frameIntervalSec, setFrameIntervalSec] = useState<5 | 10 | 15>(10);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    setVideos((prev) => [
      ...prev,
      ...Array.from(files).map((file) => ({
        uid: nextUid(),
        file,
        title: file.name.replace(/\.[^.]+$/, ''),
        transcript: '',
        uploadProgress: null,
        error: null,
        blobUrl: null,
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
      // 1. Upload each file in parallel. The Blob client uses the
      // /api/channel-clone/upload-token endpoint to mint a per-file
      // signed token before sending bytes.
      const uploadedUrls = await Promise.all(
        videos.map(async (v) => {
          try {
            update(v.uid, { uploadProgress: 0, error: null });
            const result = await upload(v.file.name, v.file, {
              access: 'public',
              handleUploadUrl: '/api/channel-clone/upload-token',
              onUploadProgress: (evt) => {
                update(v.uid, { uploadProgress: Math.round(evt.percentage) });
              },
            });
            update(v.uid, { uploadProgress: 100, blobUrl: result.url });
            return { uid: v.uid, blobUrl: result.url };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            update(v.uid, { error: msg, uploadProgress: null });
            throw err;
          }
        }),
      );

      // 2. Kick off the intake. The route's `after()` wrapper keeps
      // the function alive for the full sandbox run.
      const res = await fetch('/api/channel-clone/intake-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceLabel: sourceLabel.trim(),
          frameIntervalSec,
          videos: videos.map((v) => {
            const uploaded = uploadedUrls.find((u) => u.uid === v.uid);
            return {
              blobUrl: uploaded?.blobUrl ?? v.blobUrl ?? '',
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
              {v.uploadProgress !== null && (
                <div className="h-1 w-full overflow-hidden rounded bg-neutral-800">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${v.uploadProgress}%` }}
                  />
                </div>
              )}
              {v.error && <p className="text-[10px] text-red-300">{v.error}</p>}
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
