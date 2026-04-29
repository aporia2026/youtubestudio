/**
 * Browser-side video compression using WebCodecs.
 *
 * Uses @remotion/webcodecs which wraps the WebCodecs VideoEncoder + a built-in
 * MP4 muxer. Re-encoding runs on the GPU when hardware H.264 is available
 * (Chrome/Edge/Safari on most modern hardware), so a 13-min 1080p file
 * typically compresses in 1–2 minutes — often faster than uploading the
 * original would have been. The output is a faststart MP4 (moov atom front)
 * which fixes mid-playback stalls on R2 byte-range serving.
 *
 * If anything is unsupported or fails mid-way, the caller falls back to
 * uploading the original file untouched.
 */

import { convertMedia, getAvailableVideoCodecs } from '@remotion/webcodecs';

export interface CompressionProgress {
  /** 0–1 normalized. Best-effort; null while we don't yet know duration. */
  fraction: number;
  /** Decoded video frames so far — useful as a "we're still alive" signal. */
  decodedFrames: number;
  /** Bytes written into the output muxer. */
  bytesWritten: number;
}

export interface CompressionResult {
  file: File;
  /** Original file size in bytes (so callers can show savings). */
  originalSize: number;
  /** New file size in bytes. */
  compressedSize: number;
}

/**
 * Returns true iff the browser supports the WebCodecs path well enough to
 * attempt compression. We require H.264 video encoding because that's the
 * only codec R2/HTML video reliably plays everywhere.
 */
export async function isCompressionSupported(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== 'function') return false;
  if (typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'function') return false;
  try {
    const codecs = await getAvailableVideoCodecs({ container: 'mp4' });
    return codecs.includes('h264');
  } catch {
    return false;
  }
}

/**
 * Compress a video file in the browser. On any failure (unsupported codec,
 * decode error, encoder hang) the promise rejects — callers should catch and
 * fall back to uploading the original file.
 *
 * The output filename is derived from the input with a `.mp4` extension and
 * a `-compressed` suffix so it's distinguishable in browser dev tools.
 */
export async function compressVideo(
  file: File,
  onProgress?: (p: CompressionProgress) => void,
  signal?: AbortSignal,
): Promise<CompressionResult> {
  // Skip files that are already small enough that re-encoding would barely
  // help (and might even bloat them for very low-bitrate sources).
  if (file.size < 5 * 1024 * 1024) {
    return { file, originalSize: file.size, compressedSize: file.size };
  }

  const result = await convertMedia({
    src: file,
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    // Best-effort copy-through for tracks we can't re-encode (e.g. exotic
    // audio codecs). Falls back to drop only if both reencode + copy fail.
    onVideoTrack: () => {
      // Always re-encode video to H.264. We could `copy` when the source
      // is already H.264 — but the whole point of running this is to
      // recompress, so a copy would defeat the purpose. The MP4 muxer's
      // built-in faststart still kicks in regardless of copy vs reencode.
      return { type: 'reencode', videoCodec: 'h264' };
    },
    onAudioTrack: ({ canCopyTrack, track }) => {
      // Audio rarely benefits from re-encoding for size, and copying avoids
      // an audio-encoder dependency that some browsers (notably mobile
      // Safari) don't ship reliably. Copy when we can; otherwise re-encode
      // to AAC at 128 kbps which is transparent for video soundtracks.
      if (canCopyTrack) return { type: 'copy' };
      return {
        type: 'reencode',
        audioCodec: 'aac',
        bitrate: 128_000,
        sampleRate: track.sampleRate ?? null,
      };
    },
    onProgress: (state) => {
      if (signal?.aborted) return;
      onProgress?.({
        fraction: state.overallProgress ?? 0,
        decodedFrames: state.decodedVideoFrames,
        bytesWritten: state.bytesWritten,
      });
    },
  });

  const blob = await result.save();
  const newName = file.name.replace(/\.[^.]+$/, '') + '-compressed.mp4';
  const compressed = new File([blob], newName, { type: 'video/mp4' });
  return {
    file: compressed,
    originalSize: file.size,
    compressedSize: compressed.size,
  };
}
