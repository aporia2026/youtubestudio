'use client';

/**
 * Pitch-preserving time-stretch for generated voiceovers.
 *
 * Built on SoundTouchJS — a JS port of the SoundTouch C++ library
 * (WSOLA / phase-vocoder hybrid). Lets the voiceover page slow a
 * narration down or speed it up by 0.5–2.0× without the chipmunk /
 * Barry-White effect of naive resampling.
 *
 * Pipeline (browser-only — uses AudioContext + Web Audio):
 *
 *   1. fetchAudioBuffer(url): downloads the MP3/WAV file the
 *      Generate Voiceover step wrote to R2, decodes it via
 *      `AudioContext.decodeAudioData` into an in-memory AudioBuffer
 *      (one Float32Array per channel, sampleRate intact).
 *
 *   2. timeStretchAudioBuffer(buffer, rate): runs every channel of
 *      the AudioBuffer through SoundTouch's SimpleFilter +
 *      SoundTouch chain at `tempo = rate`. Returns a new AudioBuffer
 *      at the same sampleRate but `1/rate` of the original duration.
 *      Pitch is preserved (the whole point — a narrator's voice
 *      should sound like the same person, just faster or slower).
 *
 *   3. audioBufferToWavBlob(buffer): serializes the result as a
 *      standard 44-byte-header PCM/WAV Blob ready to drop into an
 *      anchor download. We don't bother re-encoding to MP3 client-
 *      side — WAV is lossless, plays everywhere, and the file size
 *      is irrelevant for a one-shot download.
 *
 * All three functions are pure (no globals, no React) so they're
 * easy to test in isolation and easy to swap if we ever move this
 * to a server-side ffmpeg path.
 */

import { SimpleFilter, SoundTouch, WebAudioBufferSource } from 'soundtouchjs';

/**
 * Sample-by-sample chunk size when reading from SoundTouch. SoundTouch's
 * internal buffer flushes in roughly this stride; 4096 is the value the
 * SoundTouchJS examples use and a good balance between throughput and
 * per-iteration overhead on the main thread.
 */
const STRETCH_BUFFER_SAMPLES = 4096;

export async function fetchAudioBuffer(
  url: string,
  ctx?: AudioContext,
): Promise<AudioBuffer> {
  const audioContext = ctx ?? new AudioContext();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Audio fetch failed (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  // decodeAudioData mutates its input — pass a copy so callers can
  // still inspect the original bytes if they want to.
  return audioContext.decodeAudioData(arrayBuffer.slice(0));
}

/**
 * Stretch an AudioBuffer in time, preserving pitch. `rate` > 1 = faster,
 * < 1 = slower. Multi-channel input is handled by running each channel
 * through its own SoundTouch instance with the same parameters, so
 * stereo (or future multi-channel narration) stays in phase.
 *
 * Returns a new AudioBuffer; the input is not mutated.
 */
export function timeStretchAudioBuffer(
  input: AudioBuffer,
  rate: number,
  outputCtx?: BaseAudioContext,
): AudioBuffer {
  if (rate === 1) return input;
  if (rate <= 0) throw new Error(`Invalid time-stretch rate: ${rate} (must be > 0)`);

  const ctx = outputCtx ?? new AudioContext();
  const sampleRate = input.sampleRate;
  const numberOfChannels = input.numberOfChannels;
  // Output length: source samples ÷ rate. Round up so the final
  // partial buffer worth of audio isn't lost.
  const outputLength = Math.ceil(input.length / rate);
  const output = ctx.createBuffer(numberOfChannels, outputLength, sampleRate);

  for (let ch = 0; ch < numberOfChannels; ch++) {
    // SoundTouch's WebAudioBufferSource expects an AudioBuffer-shape
    // input. We synthesize a single-channel buffer for this channel
    // so the SoundTouch pipeline operates on this channel in isolation.
    const channelBuf = ctx.createBuffer(1, input.length, sampleRate);
    channelBuf.copyToChannel(input.getChannelData(ch), 0);

    const source = new WebAudioBufferSource(channelBuf);
    const soundTouch = new SoundTouch();
    soundTouch.tempo = rate;        // > 1 = faster, < 1 = slower, pitch unchanged
    const filter = new SimpleFilter(source, soundTouch);

    // Read in fixed-size chunks. SoundTouch internally writes
    // stereo-interleaved Float32; even when fed mono, it emits L
    // and R interleaved (R is silent). We pick the left channel.
    const scratch = new Float32Array(STRETCH_BUFFER_SAMPLES * 2);
    const outChannel = output.getChannelData(ch);
    let writeOffset = 0;
    while (writeOffset < outputLength) {
      const framesRead = filter.extract(scratch, STRETCH_BUFFER_SAMPLES);
      if (framesRead === 0) break;
      const toCopy = Math.min(framesRead, outputLength - writeOffset);
      for (let i = 0; i < toCopy; i++) {
        outChannel[writeOffset + i] = scratch[i * 2]; // left channel of stereo-interleaved output
      }
      writeOffset += toCopy;
    }
  }

  return output;
}

/**
 * Serialize an AudioBuffer to a standard PCM/WAV Blob. 16-bit signed
 * samples, little-endian, multi-channel interleaved. Header is the
 * canonical 44-byte RIFF/WAVE/fmt /data shape every browser, ffmpeg,
 * Remotion, etc. handles natively.
 */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const fileSize = 44 + dataSize;

  const out = new ArrayBuffer(fileSize);
  const view = new DataView(out);

  // RIFF header
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeAscii(view, 8, 'WAVE');

  // fmt chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);            // bits per sample

  // data chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleaved 16-bit PCM samples
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = channels[ch][i];
      // Clamp to [-1, 1] then scale to int16.
      const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
      const intSample = clamped < 0 ? clamped * 32768 : clamped * 32767;
      view.setInt16(offset, intSample | 0, true);
      offset += 2;
    }
  }

  return new Blob([out], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/**
 * Convenience: trigger a browser download of a Blob with the given
 * filename. Used by the voiceover page's "Download at this speed"
 * button.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the click handler has time to start the
  // download. Immediate revoke can race the download and cancel it
  // on Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
