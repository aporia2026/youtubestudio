/**
 * Per-chunk PCM volume normalization.
 *
 * Chirp 3 HD's per-call output amplitude varies. When a long
 * narration is chunked into N synthesis calls, ~10-20% of chunks
 * come back at noticeably lower amplitude than the rest. Played
 * back-to-back, the user hears a normal voice that suddenly drops in
 * volume for a section, then comes back — perceived as "voice
 * quality dropping" mid-narration.
 *
 * Verified via ffprobe + volumedetect on a user-reported 14-min
 * voiceover (2026-05-26):
 *
 *   0–150s   : -17 to -21 dB (normal)
 *   150–210s : -27 to -33 dB (this chunk is quiet)
 *   210–330s : -17 to -21 dB (normal)
 *   330–450s : -24 to -41 dB (this chunk is quiet)
 *   450–720s : -17 to -19 dB (normal)
 *
 * Two specific chunks were anomalously quiet. The fix: after
 * synthesis, compute each chunk's RMS, identify outliers (chunks
 * more than 6 dB below the median), and amplify them to match the
 * median.
 *
 * Operates on raw 16-bit signed PCM (the payload of a LINEAR16/WAV
 * chunk after stripping the RIFF header). Pure functions, no
 * external deps.
 */

/**
 * Compute RMS of a 16-bit signed PCM buffer in normalized
 * [0, 1] range. Returns 0 for empty input.
 */
export function rmsPcm16(pcm: Uint8Array): number {
  if (pcm.byteLength < 2) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const sampleCount = Math.floor(pcm.byteLength / 2);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true);
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/** Convert linear RMS [0, 1] to dBFS. RMS of 0 returns -Infinity. */
export function rmsToDb(rms: number): number {
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms);
}

/** Compute the median of a numeric array. Returns NaN for empty. */
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Apply a linear gain to every 16-bit PCM sample. Returns a NEW
 * buffer; the input is not mutated. Samples that would exceed the
 * int16 range after multiplication are clamped to [-32768, 32767]
 * (hard limiter, prevents wrap-around distortion).
 *
 * Gains > ~1.5x risk audible clipping on already-loud passages.
 * The normalizer caps applied gain at 2x (≈ +6 dB) to stay safe.
 */
export function applyGainPcm16(pcm: Uint8Array, gain: number): Uint8Array {
  if (gain === 1) return pcm;
  const out = new Uint8Array(pcm.byteLength);
  const inView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const outView = new DataView(out.buffer);
  const sampleCount = Math.floor(pcm.byteLength / 2);
  for (let i = 0; i < sampleCount; i++) {
    const sample = inView.getInt16(i * 2, true);
    const scaled = Math.round(sample * gain);
    const clamped = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
    outView.setInt16(i * 2, clamped, true);
  }
  return out;
}

export interface NormalizedChunk {
  pcm: Uint8Array;
  /** RMS in normalized [0,1] BEFORE any gain was applied. */
  rmsLinear: number;
  /** Linear gain factor applied to this chunk. 1.0 = unchanged. */
  appliedGain: number;
}

const ANOMALY_DB_BELOW_MEDIAN = 6;
const MAX_APPLIED_GAIN_LINEAR = 2.0;  // +6 dB ceiling

/**
 * Normalize a set of PCM chunks by:
 *   1. Measuring each chunk's RMS
 *   2. Taking the median RMS across all chunks (NOT mean — robust to
 *      outliers in either direction)
 *   3. Computing each chunk's dB delta vs median
 *   4. For chunks more than ANOMALY_DB_BELOW_MEDIAN below the median,
 *      compute gain = median_rms / chunk_rms (clamped to MAX_APPLIED_GAIN_LINEAR)
 *   5. Apply gain to those chunks' samples (with hard-clip at int16
 *      bounds to prevent wrap distortion)
 *
 * Chunks at or above median are left unchanged. The result is a
 * volume-balanced sequence: the quiet chunks come up to match the
 * loud ones, the loud ones stay where they are.
 *
 * Returns the chunks in input order with per-chunk metadata for
 * observability.
 */
export function normalizeChunks(pcmChunks: Uint8Array[]): NormalizedChunk[] {
  if (pcmChunks.length === 0) return [];
  if (pcmChunks.length === 1) {
    return [{ pcm: pcmChunks[0], rmsLinear: rmsPcm16(pcmChunks[0]), appliedGain: 1 }];
  }

  const rmsValues = pcmChunks.map((p) => rmsPcm16(p));
  // Drop near-silent chunks from the median (would skew it low).
  const significant = rmsValues.filter((r) => r > 0.001);
  if (significant.length === 0) {
    return pcmChunks.map((pcm, i) => ({ pcm, rmsLinear: rmsValues[i], appliedGain: 1 }));
  }
  const medianRms = median(significant);

  return pcmChunks.map((pcm, i) => {
    const rms = rmsValues[i];
    if (rms <= 0) return { pcm, rmsLinear: rms, appliedGain: 1 };
    const dbDelta = rmsToDb(rms) - rmsToDb(medianRms);
    if (dbDelta >= -ANOMALY_DB_BELOW_MEDIAN) {
      // Within tolerance — leave it alone.
      return { pcm, rmsLinear: rms, appliedGain: 1 };
    }
    const rawGain = medianRms / rms;
    const gain = Math.min(rawGain, MAX_APPLIED_GAIN_LINEAR);
    return { pcm: applyGainPcm16(pcm, gain), rmsLinear: rms, appliedGain: gain };
  });
}
