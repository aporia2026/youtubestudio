/**
 * Header-aware concatenation for LINEAR16/WAV chunks.
 *
 * Background: when a long Google TTS narration exceeds the sync
 * endpoint's input limit, the chunker splits it into sentence-bounded
 * pieces and we synthesize each in parallel. The previous MP3 path
 * concatenated the resulting bytes naively — that worked because MP3
 * frames are self-contained.
 *
 * After the 2026-05-26 quality bump to LINEAR16 (uncompressed PCM
 * wrapped in WAV), naive byte concat produces a broken file: the
 * first chunk's RIFF/WAVE header is valid, but every subsequent
 * chunk's header sits in the middle of the audio stream. Players
 * read the first header, start decoding samples, then hit the next
 * header bytes interpreted as audio — manifests as the voice going
 * silent or distorted at chunk boundaries.
 *
 * The right fix: parse each WAV, extract just the PCM payload, then
 * emit a single new WAV with one header and all the PCM glued
 * together. WAV format is straightforward enough to do without a
 * library — RIFF container, an `fmt ` chunk describing the audio
 * parameters, a `data` chunk with the samples. Other chunks (`LIST`,
 * etc.) are ignored at parse time.
 *
 * Pure functions, no I/O. Throws on malformed input so a corrupt
 * chunk fails the long-form synth loud instead of producing more
 * silent garbage.
 */

interface ParsedWav {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  /** Audio format code from the fmt chunk. 1 = PCM. We require PCM
   *  because every other code (IEEE float, ALAW, MULAW, etc.) needs
   *  different handling for concat semantics. */
  audioFormat: number;
  /** Raw PCM samples — header-less, ready to glue. */
  pcm: Uint8Array;
}

function ascii(buf: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(buf[offset + i]);
  return out;
}

export function parseWav(buf: Uint8Array): ParsedWav {
  if (buf.byteLength < 44) throw new Error('WAV too short — no RIFF header');
  if (ascii(buf, 0, 4) !== 'RIFF') throw new Error('Not a RIFF file');
  if (ascii(buf, 8, 4) !== 'WAVE') throw new Error('Not a WAVE file');

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let pcm: Uint8Array | null = null;

  while (offset + 8 <= buf.byteLength) {
    const chunkId = ascii(buf, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new Error('fmt chunk too small');
      audioFormat = view.getUint16(dataStart + 0, true);
      numChannels = view.getUint16(dataStart + 2, true);
      sampleRate = view.getUint32(dataStart + 4, true);
      bitsPerSample = view.getUint16(dataStart + 14, true);
    } else if (chunkId === 'data') {
      pcm = buf.slice(dataStart, dataStart + chunkSize);
    }

    // Chunks are aligned to even byte boundaries.
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !numChannels || !bitsPerSample) {
    throw new Error('WAV missing fmt chunk');
  }
  if (!pcm) throw new Error('WAV missing data chunk');
  if (audioFormat !== 1) {
    throw new Error(`Unsupported WAV format code ${audioFormat} (only PCM/1 supported)`);
  }

  return { sampleRate, numChannels, bitsPerSample, audioFormat, pcm };
}

/**
 * Build a fresh 44-byte standard PCM/WAV header + PCM payload. Output
 * is suitable for any consumer that handles the canonical RIFF/WAVE
 * shape (browsers, ffmpeg, Remotion's <Audio>, Google STT).
 */
export function buildWav(args: {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  pcm: Uint8Array;
}): Uint8Array {
  const { sampleRate, numChannels, bitsPerSample, pcm } = args;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.byteLength;
  const fileSize = 36 + dataSize;

  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  // RIFF header
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46;  // "RIFF"
  view.setUint32(4, fileSize, true);
  out[8] = 0x57; out[9] = 0x41; out[10] = 0x56; out[11] = 0x45; // "WAVE"

  // fmt  chunk
  out[12] = 0x66; out[13] = 0x6d; out[14] = 0x74; out[15] = 0x20; // "fmt "
  view.setUint32(16, 16, true);          // chunk size (16 for PCM)
  view.setUint16(20, 1, true);            // audio format = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  out[36] = 0x64; out[37] = 0x61; out[38] = 0x74; out[39] = 0x61; // "data"
  view.setUint32(40, dataSize, true);
  out.set(pcm, 44);

  return out;
}

/**
 * Concatenate multiple WAV files into one. All inputs must share the
 * same sample rate, channel count, and bit depth (which they will
 * when produced by the same Google voice in the same request — we
 * pin sampleRateHertz to 24000 in the provider).
 *
 * Returns the original buffer unchanged when called with one input,
 * and an empty buffer when called with none.
 */
export function concatWavFiles(wavs: Uint8Array[]): Uint8Array {
  if (wavs.length === 0) return new Uint8Array(0);
  if (wavs.length === 1) return wavs[0];

  const parsed = wavs.map(parseWav);
  const first = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    const p = parsed[i];
    if (
      p.sampleRate !== first.sampleRate ||
      p.numChannels !== first.numChannels ||
      p.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error(
        `WAV chunk ${i} has mismatched format ` +
          `(${p.sampleRate}/${p.numChannels}ch/${p.bitsPerSample}bit vs ` +
          `${first.sampleRate}/${first.numChannels}ch/${first.bitsPerSample}bit). ` +
          `All chunks must share the same audio parameters to concat.`,
      );
    }
  }

  const totalPcmBytes = parsed.reduce((sum, p) => sum + p.pcm.byteLength, 0);
  const combinedPcm = new Uint8Array(totalPcmBytes);
  let offset = 0;
  for (const p of parsed) {
    combinedPcm.set(p.pcm, offset);
    offset += p.pcm.byteLength;
  }

  return buildWav({
    sampleRate: first.sampleRate,
    numChannels: first.numChannels,
    bitsPerSample: first.bitsPerSample,
    pcm: combinedPcm,
  });
}
