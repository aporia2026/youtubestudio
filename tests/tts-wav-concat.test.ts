import { describe, expect, it } from 'vitest';
import { buildWav, concatWavFiles, parseWav } from '@/lib/tts/wav-concat';

// The bug this guards against: naive byte concat of Google LINEAR16
// chunks left every chunk's RIFF/WAVE header embedded mid-stream,
// producing voiceovers that go silent or distorted at chunk
// boundaries. The fix parses each WAV, extracts PCM, rebuilds one
// header. Tests pin the parsing + rebuild + concat logic so a future
// edit that breaks any of them fails loud here instead of silently
// shipping garbled audio.

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS = 16;

function makePcm(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return out;
}

function makeWav(samples: number[]): Uint8Array {
  return buildWav({
    sampleRate: SAMPLE_RATE,
    numChannels: CHANNELS,
    bitsPerSample: BITS,
    pcm: makePcm(samples),
  });
}

describe('buildWav — header correctness', () => {
  it('produces a 44-byte RIFF/WAVE/fmt/data header for standard PCM', () => {
    const wav = buildWav({
      sampleRate: SAMPLE_RATE,
      numChannels: CHANNELS,
      bitsPerSample: BITS,
      pcm: new Uint8Array(0),
    });
    expect(wav.byteLength).toBe(44);
    // RIFF magic
    expect(String.fromCharCode(wav[0], wav[1], wav[2], wav[3])).toBe('RIFF');
    expect(String.fromCharCode(wav[8], wav[9], wav[10], wav[11])).toBe('WAVE');
    expect(String.fromCharCode(wav[12], wav[13], wav[14], wav[15])).toBe('fmt ');
    expect(String.fromCharCode(wav[36], wav[37], wav[38], wav[39])).toBe('data');
  });

  it('encodes sample rate + channels + bit depth in the fmt chunk', () => {
    const wav = makeWav([0, 100, -100, 32000]);
    const parsed = parseWav(wav);
    expect(parsed.sampleRate).toBe(SAMPLE_RATE);
    expect(parsed.numChannels).toBe(CHANNELS);
    expect(parsed.bitsPerSample).toBe(BITS);
    expect(parsed.audioFormat).toBe(1);
    expect(parsed.pcm.byteLength).toBe(8);
  });

  it('encodes file size (offset 4) and data size (offset 40) correctly', () => {
    const pcm = makePcm([1, 2, 3, 4, 5]);
    const wav = buildWav({
      sampleRate: SAMPLE_RATE,
      numChannels: CHANNELS,
      bitsPerSample: BITS,
      pcm,
    });
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(36 + pcm.byteLength);  // file size - 8
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
  });
});

describe('parseWav — error cases', () => {
  it('throws on input too short to hold a header', () => {
    expect(() => parseWav(new Uint8Array(10))).toThrow(/too short/i);
  });

  it('throws when RIFF magic is missing', () => {
    const fake = new Uint8Array(44);
    expect(() => parseWav(fake)).toThrow(/RIFF/i);
  });

  it('throws on non-PCM audio formats (alaw / mulaw / float)', () => {
    const wav = makeWav([0]);
    // Stomp the audio-format field (offset 20, 2 bytes, little-endian).
    wav[20] = 6; // ALAW
    expect(() => parseWav(wav)).toThrow(/Unsupported WAV format/i);
  });
});

describe('concatWavFiles — the bug guard', () => {
  it('returns an empty buffer for an empty input list', () => {
    expect(concatWavFiles([])).toEqual(new Uint8Array(0));
  });

  it('passes a single WAV through unchanged', () => {
    const wav = makeWav([10, 20, 30]);
    expect(concatWavFiles([wav])).toBe(wav);
  });

  it('concatenates two WAVs into one valid WAV with combined PCM', () => {
    const a = makeWav([1, 2, 3]);
    const b = makeWav([4, 5, 6, 7]);
    const merged = concatWavFiles([a, b]);
    const parsed = parseWav(merged);
    expect(parsed.sampleRate).toBe(SAMPLE_RATE);
    expect(parsed.numChannels).toBe(CHANNELS);
    expect(parsed.bitsPerSample).toBe(BITS);
    expect(parsed.pcm.byteLength).toBe(2 * (3 + 4));  // 7 samples × 2 bytes
    // Total file size is one 44-byte header + combined PCM (NOT two
    // headers — this is the point of the fix).
    expect(merged.byteLength).toBe(44 + parsed.pcm.byteLength);
  });

  it('preserves PCM byte order across the join (samples land contiguously)', () => {
    const aSamples = [100, 200, 300];
    const bSamples = [400, 500];
    const merged = concatWavFiles([makeWav(aSamples), makeWav(bSamples)]);
    const parsed = parseWav(merged);
    const view = new DataView(parsed.pcm.buffer, parsed.pcm.byteOffset, parsed.pcm.byteLength);
    const recovered = [];
    for (let i = 0; i < parsed.pcm.byteLength / 2; i++) recovered.push(view.getInt16(i * 2, true));
    expect(recovered).toEqual([...aSamples, ...bSamples]);
  });

  it('handles realistic Google-sized chunks (15 chunks of ~5s @ 24kHz mono)', () => {
    const chunkSamples = SAMPLE_RATE * 5;             // 5 seconds each
    const chunks = Array.from({ length: 15 }, (_, i) =>
      makeWav(Array.from({ length: chunkSamples }, (_, j) => (i * 100 + j) % 32768)),
    );
    const merged = concatWavFiles(chunks);
    const parsed = parseWav(merged);
    // 15 × 5s × 24000 samples/s × 2 bytes/sample
    expect(parsed.pcm.byteLength).toBe(15 * chunkSamples * 2);
    expect(parsed.sampleRate).toBe(SAMPLE_RATE);
  });

  it('rejects mismatched formats so a corrupt chunk fails loud (not silent garbage)', () => {
    const ok = makeWav([0, 1]);
    const wrongRate = buildWav({
      sampleRate: 16000,  // ← different
      numChannels: CHANNELS,
      bitsPerSample: BITS,
      pcm: makePcm([0, 1]),
    });
    expect(() => concatWavFiles([ok, wrongRate])).toThrow(/mismatched format/i);
  });
});
