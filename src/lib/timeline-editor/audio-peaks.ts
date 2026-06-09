/**
 * Lightweight audio-peaks helper for the timeline editor's voiceover
 * track. Decodes an audio file via Web Audio API once per URL,
 * computes a normalized peak array (one float per bucket), and
 * caches it module-globally so every <VoiceoverClipCard /> rendering
 * the same source shares the decoded result.
 *
 * No third-party dependency. Wavesurfer.js would add ~30KB +
 * a canvas runtime; for our use case (cyan bars on a small clip
 * card) a plain Web Audio decode + SVG render is simpler and
 * smaller. If we later need scrubbing, transport, regions etc.
 * we can revisit.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md (M6 polish).
 */

/** Number of peak buckets across the entire source. Roughly one
 *  per 10ms of audio at typical narration lengths (5 min ≈ 30K
 *  buckets is too dense; 1024 keeps the SVG light while still
 *  giving enough resolution to slice down to a 1-second segment
 *  and see ~3 bars per second of the slice). */
export const PEAK_BUCKET_COUNT = 1024;

export interface DecodedPeaks {
  /** Normalized [0, 1] peak amplitude per bucket. */
  peaks: Float32Array;
  /** Total audio duration in ms — derived from the decoded buffer
   *  so the slicer can map (sourceOffsetMs, durationMs) → bucket
   *  range without an extra round-trip. */
  durationMs: number;
}

/** Module-level cache. Keyed by URL so a re-render of the same
 *  segment never re-decodes. Errors are intentionally re-thrown
 *  on every hook call so the UI can retry by remounting; we don't
 *  cache rejected promises. */
const cache = new Map<string, Promise<DecodedPeaks>>();

/** Decode an audio URL into a normalized peaks array + duration.
 *  Runs on the client only — the AudioContext constructor doesn't
 *  exist in Node. Callers (the React hook) gate on
 *  `typeof window !== 'undefined'` before invoking. */
export function decodeAudioPeaks(url: string): Promise<DecodedPeaks> {
  if (!url) return Promise.reject(new Error('decodeAudioPeaks: empty url'));
  const cached = cache.get(url);
  if (cached) return cached;
  const promise = decode(url).catch((err) => {
    // Don't permanently cache failures — if the user retries we
    // want a fresh attempt rather than returning the stale error.
    cache.delete(url);
    throw err;
  });
  cache.set(url, promise);
  return promise;
}

async function decode(url: string): Promise<DecodedPeaks> {
   
  const response = await fetch(url);
  if (!response.ok) throw new Error(`decodeAudioPeaks: HTTP ${response.status} for ${url}`);
  const arrayBuffer = await response.arrayBuffer();
  // Lazy-construct the AudioContext so the cost is paid only the
  // first time we decode anything. Browsers throw if you create
  // one before a user gesture; rely on the caller (a click on the
  // timeline editor) having satisfied that gesture.
  const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctx) throw new Error('decodeAudioPeaks: AudioContext not available');
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    const peaks = computePeaks(buffer);
    const durationMs = Math.round(buffer.duration * 1000);
    return { peaks, durationMs };
  } finally {
    // Close the context so we don't keep audio hardware allocated.
    // Some implementations resolve the promise; ignoring its result
    // is intentional — we don't need to await it.
    void ctx.close();
  }
}

function computePeaks(buffer: AudioBuffer): Float32Array {
  // Sum all channels (mono mix) to get the loudest moment regardless
  // of channel routing. For most narration that's first-channel-
  // dominant, but stereo recordings can have important content on
  // either side.
  const sampleCount = buffer.length;
  const channels = buffer.numberOfChannels;
  const samplesPerBucket = Math.max(1, Math.floor(sampleCount / PEAK_BUCKET_COUNT));
  const peaks = new Float32Array(PEAK_BUCKET_COUNT);
  for (let b = 0; b < PEAK_BUCKET_COUNT; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(start + samplesPerBucket, sampleCount);
    let max = 0;
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = start; i < end; i++) {
        const abs = Math.abs(data[i]);
        if (abs > max) max = abs;
      }
    }
    peaks[b] = max;
  }
  // Normalise to [0, 1] using the loudest peak as the reference. If
  // the audio is silence (peak 0) every bucket stays at 0.
  let absMax = 0;
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] > absMax) absMax = peaks[i];
  }
  if (absMax > 0 && absMax !== 1) {
    for (let i = 0; i < peaks.length; i++) {
      peaks[i] = peaks[i] / absMax;
    }
  }
  return peaks;
}

/** Slice the full-source `peaks` array down to a segment's window
 *  and resample to `outBuckets` for SVG rendering. Pure — testable
 *  without any browser API. */
export function slicePeaks(
  peaks: Float32Array,
  sourceOffsetMs: number,
  durationMs: number,
  totalSourceDurationMs: number,
  outBuckets: number,
): Float32Array {
  if (outBuckets <= 0 || peaks.length === 0 || totalSourceDurationMs <= 0 || durationMs <= 0) {
    return new Float32Array(Math.max(0, outBuckets));
  }
  const startFrac = Math.max(0, Math.min(1, sourceOffsetMs / totalSourceDurationMs));
  const endFrac = Math.max(startFrac, Math.min(1, (sourceOffsetMs + durationMs) / totalSourceDurationMs));
  const startIdx = Math.floor(startFrac * peaks.length);
  const endIdx = Math.max(startIdx + 1, Math.floor(endFrac * peaks.length));
  const range = endIdx - startIdx;
  const out = new Float32Array(outBuckets);
  for (let i = 0; i < outBuckets; i++) {
    const srcIdx = Math.min(peaks.length - 1, startIdx + Math.floor((i / outBuckets) * range));
    out[i] = peaks[srcIdx];
  }
  return out;
}

/** Test seam: lets unit tests reset the module-level cache between
 *  cases without exposing the cache itself. */
export function __resetAudioPeaksCacheForTests(): void {
  cache.clear();
}
