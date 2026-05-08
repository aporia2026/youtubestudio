/**
 * Browser-side review-video upload pipeline shared by the editor's dashboard
 * and the owner's "video received from editor" upload box.
 *
 * Handles the full sequence:
 *   compress → probe (duration / dimensions / thumbnail) → reserve presigned URL
 *   → PUT to R2 → confirm metadata.
 *
 * Every async step is bounded:
 *   - compress: max wall time + stall detector (no progress event for N s)
 *   - probe:    hard timeout (a hidden <video> on a malformed file can hang
 *               forever waiting for `onseeked` to fire)
 *   - PUT:      `xhr.timeout` + a separate stall detector independent of the
 *               total timeout (a slow-but-progressing upload on a big file
 *               must not be killed — only a truly stuck one)
 *
 * Every step is also abortable via a single AbortSignal so the UI's cancel
 * button can unwind the whole pipeline instantly.
 *
 * On failure the rejection carries a `code` string the UI uses to render a
 * user-meaningful error instead of "network error":
 *   COMPRESS_TIMEOUT, COMPRESS_STALL, COMPRESS_FAILED  (compress branch)
 *   PROBE_TIMEOUT                                       (best-effort, swallowed)
 *   PRESIGN_FAILED                                      (server returned non-2xx)
 *   PUT_TIMEOUT, PUT_STALL                              (XHR exceeded budgets)
 *   PUT_URL_EXPIRED                                     (R2 returned 403)
 *   PUT_CORS                                            (xhr `error` w/ status 0)
 *   PUT_REJECTED                                        (any other 4xx/5xx)
 *   ABORTED                                             (caller aborted)
 *   CONFIRM_FAILED                                      (PATCH after PUT fail)
 */

import { compressVideo, isCompressionSupported } from './compress-video';

// --- Pure helpers (unit-tested) -------------------------------------------

export interface ClassifyXhrFailureInput {
  /** xhr.status, may be 0 if the request never connected (CORS / DNS). */
  status: number;
  /** Was the failure a 'timeout' / 'abort' / 'error' / 'load'? */
  reason: 'timeout' | 'abort' | 'error' | 'stall' | 'load';
}

export interface ClassifiedXhrFailure {
  code:
    | 'PUT_TIMEOUT'
    | 'PUT_STALL'
    | 'PUT_URL_EXPIRED'
    | 'PUT_CORS'
    | 'PUT_REJECTED'
    | 'ABORTED';
  message: string;
}

/**
 * Map a low-level XHR outcome to a stable error code + a sentence the UI
 * can show to a user. Pure function so the failure paths in the helper
 * stay testable in jsdom-less Vitest.
 */
export function classifyXhrFailure(input: ClassifyXhrFailureInput): ClassifiedXhrFailure {
  if (input.reason === 'abort') {
    return { code: 'ABORTED', message: 'Upload was cancelled.' };
  }
  // 403 wins over the surrounding event type — once R2 has rejected the
  // PUT (most commonly because the presigned URL expired), the user
  // needs the "expired URL" hint regardless of whether the surrounding
  // event arrived as load / error / stall.
  if (input.status === 403) {
    return {
      code: 'PUT_URL_EXPIRED',
      message: 'Upload URL expired before the file finished uploading. Reload the page and try again.',
    };
  }
  if (input.reason === 'timeout') {
    return {
      code: 'PUT_TIMEOUT',
      message: 'Upload timed out — the connection was too slow to finish in 4 hours.',
    };
  }
  if (input.reason === 'stall') {
    return {
      code: 'PUT_STALL',
      message: 'Upload stalled — no data was sent for 60 seconds. Check your connection and try again.',
    };
  }
  if (input.reason === 'error' && input.status === 0) {
    return {
      code: 'PUT_CORS',
      message: 'Browser blocked the upload. Your R2 bucket needs CORS configured for this origin.',
    };
  }
  if (input.status >= 200 && input.status < 300) {
    // Should never reach here, but keep the type total.
    return { code: 'PUT_REJECTED', message: `Unexpected upload response (HTTP ${input.status}).` };
  }
  return {
    code: 'PUT_REJECTED',
    message: `Upload failed (HTTP ${input.status}). Check bucket permissions or try again.`,
  };
}

// --- Public API -----------------------------------------------------------

export interface UploadProbeResult {
  duration_ms?: number;
  width?: number;
  height?: number;
  thumbnail_url?: string;
}

export interface UploadProgress {
  /** 0–100, only meaningful while phase === 'uploading'. */
  uploadPercent: number;
  /** 0–1, only meaningful while phase === 'compressing'. */
  compressFraction: number;
  /** Current pipeline phase. */
  phase: 'idle' | 'compressing' | 'probing' | 'reserving' | 'uploading' | 'confirming';
  /** Last-known compression savings %, set after compress finishes. Null if not run. */
  compressionSavedPct: number | null;
}

export interface UploadVideoOptions {
  file: File;
  /** When false, skip browser-side compression entirely. */
  enableCompression: boolean;
  /** Caller-managed cancel signal. Aborting unwinds compress + PUT immediately. */
  signal: AbortSignal;
  /** Step 1: server reserves a presigned URL + version row. */
  reservePresignedUrl: (input: {
    fileName: string;
    contentType: string;
    fileSize: number;
  }) => Promise<{ uploadUrl: string; versionId: string }>;
  /** Step 4: server records duration / dimensions / thumbnail after PUT lands. */
  confirmMetadata: (input: { versionId: string } & UploadProbeResult) => Promise<void>;
  /** Best-effort uploader for the auto-generated JPEG thumbnail. */
  uploadThumbnail: (blob: Blob) => Promise<string | null>;
  /** Live progress callback. Called frequently during compress + upload. */
  onProgress: (state: UploadProgress) => void;
}

export interface UploadVideoResult {
  versionId: string;
  /** True if the file was actually re-encoded smaller. */
  wasCompressed: boolean;
  compressionSavedPct: number | null;
}

const COMPRESS_HARD_TIMEOUT_MS = 15 * 60 * 1000; // 15 min wall clock
const COMPRESS_STALL_MS = 90 * 1000; // 90s with no progress event
const PROBE_TIMEOUT_MS = 8 * 1000;
const PUT_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000; // matches R2 presign TTL
const PUT_STALL_MS = 60 * 1000; // 60s with no progress event

export class UploadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'UploadError';
  }
}

/**
 * Run the full upload pipeline. Returns once the server has confirmed
 * metadata. Throws UploadError on any failure, including caller-aborted.
 */
export async function uploadReviewVideo(opts: UploadVideoOptions): Promise<UploadVideoResult> {
  if (opts.signal.aborted) throw new UploadError('ABORTED', 'Upload was cancelled.');

  // Phase 1: compress (best-effort)
  let workingFile = opts.file;
  let compressionSavedPct: number | null = null;
  let wasCompressed = false;

  const shouldCompress =
    opts.enableCompression && opts.file.size >= 5 * 1024 * 1024 && (await isCompressionSupported());
  if (shouldCompress) {
    opts.onProgress({
      phase: 'compressing',
      compressFraction: 0,
      uploadPercent: 0,
      compressionSavedPct: null,
    });
    try {
      const compressed = await runCompressWithBudget(opts.file, opts.signal, fraction => {
        opts.onProgress({
          phase: 'compressing',
          compressFraction: fraction,
          uploadPercent: 0,
          compressionSavedPct: null,
        });
      });
      if (compressed.compressedSize < compressed.originalSize) {
        workingFile = compressed.file;
        compressionSavedPct = Math.round(
          (1 - compressed.compressedSize / compressed.originalSize) * 100,
        );
        wasCompressed = true;
      }
    } catch (err) {
      // Stalled / timed out / decoder error → fall back to original file.
      // Cancel propagates as an UploadError straight to the caller.
      if (err instanceof UploadError && err.code === 'ABORTED') throw err;
      // Anything else: log a console warn but keep the upload going with
      // the uncompressed original — a slow upload is better than no
      // upload at all.
      console.warn('[upload-video] compression failed, sending original:', err);
    }
  }

  if (opts.signal.aborted) throw new UploadError('ABORTED', 'Upload was cancelled.');

  // Phase 2: probe (best-effort — bounded so it can never hang the upload)
  opts.onProgress({
    phase: 'probing',
    compressFraction: 1,
    uploadPercent: 0,
    compressionSavedPct,
  });
  const probe = await probeVideoBounded(workingFile, opts.uploadThumbnail).catch(() => ({}));

  if (opts.signal.aborted) throw new UploadError('ABORTED', 'Upload was cancelled.');

  // Phase 3: reserve presigned URL + version row
  opts.onProgress({
    phase: 'reserving',
    compressFraction: 1,
    uploadPercent: 0,
    compressionSavedPct,
  });
  let uploadUrl: string;
  let versionId: string;
  try {
    const reservation = await opts.reservePresignedUrl({
      fileName: workingFile.name,
      contentType: workingFile.type || 'video/mp4',
      fileSize: workingFile.size,
    });
    uploadUrl = reservation.uploadUrl;
    versionId = reservation.versionId;
  } catch (err) {
    throw new UploadError(
      'PRESIGN_FAILED',
      err instanceof Error ? err.message : 'Failed to reserve upload URL.',
    );
  }

  if (opts.signal.aborted) throw new UploadError('ABORTED', 'Upload was cancelled.');

  // Phase 4: PUT to R2 with timeouts + stall detection + abort
  opts.onProgress({
    phase: 'uploading',
    compressFraction: 1,
    uploadPercent: 0,
    compressionSavedPct,
  });
  await putToR2WithBudget(uploadUrl, workingFile, opts.signal, percent => {
    opts.onProgress({
      phase: 'uploading',
      compressFraction: 1,
      uploadPercent: percent,
      compressionSavedPct,
    });
  });

  // Phase 5: confirm metadata (cancel after PUT no longer rolls back the
  // version row — the bytes are already in R2; the worst case is a missing
  // thumbnail / duration that the user can re-trigger by re-uploading).
  opts.onProgress({
    phase: 'confirming',
    compressFraction: 1,
    uploadPercent: 100,
    compressionSavedPct,
  });
  try {
    await opts.confirmMetadata({ versionId, ...probe });
  } catch (err) {
    throw new UploadError(
      'CONFIRM_FAILED',
      err instanceof Error ? err.message : 'Failed to record video metadata.',
    );
  }

  return { versionId, wasCompressed, compressionSavedPct };
}

// --- Compress with budget -------------------------------------------------

async function runCompressWithBudget(
  file: File,
  signal: AbortSignal,
  onFraction: (f: number) => void,
): Promise<{ file: File; originalSize: number; compressedSize: number }> {
  // Inner controller drives the AbortSignal we pass to compressVideo.
  // The webcodecs helper currently ignores the signal between progress
  // ticks (convertMedia has no native signal arg), so we ALSO race the
  // compress promise against an abort/timeout/stall promise — the
  // caller's perceived "cancel" then unwinds immediately even when the
  // encoder is mid-frame. The encoder eventually self-terminates when
  // its progress callback returns; the discarded promise leaks no state.
  const controller = new AbortController();
  let lastTick = Date.now();
  const stallCheckId = window.setInterval(() => {
    if (Date.now() - lastTick > COMPRESS_STALL_MS) {
      controller.abort();
    }
  }, 5_000);
  const hardId = window.setTimeout(() => controller.abort(), COMPRESS_HARD_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  signal.addEventListener('abort', onCallerAbort);

  let raceResolved = false;
  const compressPromise = compressVideo(
    file,
    progress => {
      lastTick = Date.now();
      onFraction(progress.fraction);
    },
    controller.signal,
  );
  const abortPromise = new Promise<never>((_, reject) => {
    const tick = window.setInterval(() => {
      if (raceResolved) {
        window.clearInterval(tick);
        return;
      }
      if (signal.aborted || controller.signal.aborted) {
        window.clearInterval(tick);
        reject(new Error('compress-aborted'));
      }
    }, 200);
  });

  try {
    const result = await Promise.race([compressPromise, abortPromise]);
    raceResolved = true;
    return result;
  } catch (err) {
    raceResolved = true;
    if (signal.aborted) throw new UploadError('ABORTED', 'Upload was cancelled.');
    if (controller.signal.aborted) {
      // Either hard timeout or stall.
      const elapsed = Date.now() - lastTick;
      if (elapsed > COMPRESS_STALL_MS) {
        throw new UploadError(
          'COMPRESS_STALL',
          'Compression stalled — falling back to uploading the original file.',
        );
      }
      throw new UploadError(
        'COMPRESS_TIMEOUT',
        'Compression took longer than 15 minutes — falling back to uploading the original file.',
      );
    }
    throw new UploadError(
      'COMPRESS_FAILED',
      err instanceof Error ? err.message : 'Browser compression failed.',
    );
  } finally {
    window.clearInterval(stallCheckId);
    window.clearTimeout(hardId);
    signal.removeEventListener('abort', onCallerAbort);
  }
}

// --- Probe with timeout ---------------------------------------------------

async function probeVideoBounded(
  file: File,
  uploadThumbnail: (blob: Blob) => Promise<string | null>,
): Promise<UploadProbeResult> {
  return Promise.race([
    probeVideoInner(file, uploadThumbnail),
    new Promise<UploadProbeResult>(resolve => {
      // Resolve with empty metadata after the timeout — thumbnail is best-
      // effort, not a hard requirement to upload.
      window.setTimeout(() => resolve({}), PROBE_TIMEOUT_MS);
    }),
  ]);
}

async function probeVideoInner(
  file: File,
  uploadThumbnail: (blob: Blob) => Promise<string | null>,
): Promise<UploadProbeResult> {
  const out: UploadProbeResult = {};
  const videoEl = document.createElement('video');
  videoEl.preload = 'metadata';
  videoEl.muted = true;
  const objectUrl = URL.createObjectURL(file);
  videoEl.src = objectUrl;

  await new Promise<void>(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    videoEl.onloadedmetadata = () => {
      videoEl.currentTime = Math.min(1, (videoEl.duration || 0) / 2);
    };
    videoEl.onseeked = done;
    videoEl.onerror = done;
  });

  out.duration_ms = isFinite(videoEl.duration) ? Math.round(videoEl.duration * 1000) : undefined;
  out.width = videoEl.videoWidth || undefined;
  out.height = videoEl.videoHeight || undefined;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(out.width || 640, 640);
    canvas.height = Math.round(canvas.width * ((out.height || 360) / (out.width || 640)));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.8));
      if (blob) {
        const url = await uploadThumbnail(blob);
        if (url) out.thumbnail_url = url;
      }
    }
  } catch {
    // Thumbnail is best-effort; ignore.
  }

  URL.revokeObjectURL(objectUrl);
  return out;
}

// --- PUT to R2 with budget -------------------------------------------------

function putToR2WithBudget(
  url: string,
  file: File,
  signal: AbortSignal,
  onPercent: (p: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new UploadError('ABORTED', 'Upload was cancelled.'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.timeout = PUT_HARD_TIMEOUT_MS;

    let lastProgress = Date.now();
    const stallId = window.setInterval(() => {
      if (Date.now() - lastProgress > PUT_STALL_MS) {
        window.clearInterval(stallId);
        try {
          xhr.abort();
        } catch {
          // ignore
        }
        const failure = classifyXhrFailure({ status: xhr.status || 0, reason: 'stall' });
        reject(new UploadError(failure.code, failure.message));
      }
    }, 5_000);

    const cleanup = () => {
      window.clearInterval(stallId);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      try {
        xhr.abort();
      } catch {
        // ignore
      }
      reject(new UploadError('ABORTED', 'Upload was cancelled.'));
    };

    xhr.upload.addEventListener('progress', evt => {
      if (!evt.lengthComputable) return;
      lastProgress = Date.now();
      onPercent(Math.round((evt.loaded / evt.total) * 100));
    });
    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        const failure = classifyXhrFailure({ status: xhr.status, reason: 'load' });
        reject(new UploadError(failure.code, failure.message));
      }
    });
    xhr.addEventListener('error', () => {
      cleanup();
      const failure = classifyXhrFailure({ status: xhr.status || 0, reason: 'error' });
      reject(new UploadError(failure.code, failure.message));
    });
    xhr.addEventListener('timeout', () => {
      cleanup();
      const failure = classifyXhrFailure({ status: xhr.status || 0, reason: 'timeout' });
      reject(new UploadError(failure.code, failure.message));
    });
    xhr.addEventListener('abort', () => {
      // Already handled by `onAbort` or the stall path; defensive cleanup.
      cleanup();
    });

    signal.addEventListener('abort', onAbort);

    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.send(file);
  });
}
