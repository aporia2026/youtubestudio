/**
 * Unit tests for the ffmpeg-stderr Duration parser. The spawn path
 * itself isn't exercised here (integration concern) — the parser is
 * the pure piece that's worth locking against future ffmpeg output
 * drift.
 *
 * See `src/lib/audio-duration-probe.ts`.
 */
import { describe, expect, it } from 'vitest';
import { parseFfmpegDurationFromStderr } from '@/lib/audio-duration-probe';

describe('parseFfmpegDurationFromStderr', () => {
  it('parses the canonical ffmpeg line', () => {
    const stderr = `Input #0, mp3, from 'pipe:0':
  Duration: 00:00:39.12, start: 0.025057, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, mono, fltp, 128 kb/s`;
    expect(parseFfmpegDurationFromStderr(stderr)).toBeCloseTo(39.12, 2);
  });

  it('handles a short clip without sub-second precision', () => {
    const stderr = 'Duration: 00:00:03, start: 0.0, bitrate: 256 kb/s';
    expect(parseFfmpegDurationFromStderr(stderr)).toBe(3);
  });

  it('handles a clip past one minute', () => {
    const stderr = 'Duration: 00:02:14.45';
    expect(parseFfmpegDurationFromStderr(stderr)).toBeCloseTo(2 * 60 + 14.45, 2);
  });

  it('handles a clip past one hour', () => {
    const stderr = 'Duration: 01:23:45.6';
    expect(parseFfmpegDurationFromStderr(stderr)).toBeCloseTo(
      1 * 3600 + 23 * 60 + 45.6,
      2,
    );
  });

  it('returns null when ffmpeg never printed a Duration line', () => {
    const stderr = `ffmpeg version 6.0
[mp3 @ 0x7f] Failed to read frame size: Could not seek to 1026.
pipe:0: Invalid data found when processing input`;
    expect(parseFfmpegDurationFromStderr(stderr)).toBeNull();
  });

  it('returns null on empty stderr', () => {
    expect(parseFfmpegDurationFromStderr('')).toBeNull();
  });

  it('returns the first Duration when ffmpeg prints two (rare — concatenated inputs)', () => {
    const stderr = `Input #0:
  Duration: 00:00:10.50
Input #1:
  Duration: 00:00:20.00`;
    // We pick the first match deterministically. Concatenated-input
    // shapes aren't fed through this helper, but if they ever are, the
    // behaviour should be predictable rather than "last match wins".
    expect(parseFfmpegDurationFromStderr(stderr)).toBeCloseTo(10.5, 2);
  });
});
