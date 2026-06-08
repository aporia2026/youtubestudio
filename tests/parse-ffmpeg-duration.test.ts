/**
 * Tests for the ffmpeg duration parser + transcript-word-rate
 * estimator. The pair is what unblocks voice-extract when the upload
 * intake's ffmpeg probe can't extract a real duration — the silent
 * regression we hit on 2026-06-07 ("no usable window found in chosen
 * video — giving up" on a perfectly good 13-minute upload).
 *
 * Plan: _plans/2026-06-08-voice-extract-duration-fallback.md.
 */

import { describe, expect, it } from 'vitest';
import {
  estimateDurationSecFromWords,
  parseFfmpegDuration,
} from '@/lib/channel-clone/parse-ffmpeg-duration';

describe('parseFfmpegDuration — canonical two-decimal output', () => {
  it('parses the canonical "hh:mm:ss.NN" form', () => {
    const stderr = `Input #0, mov,mp4, from 'in.mp4':
  Duration: 00:13:18.52, start: 0.000000, bitrate: 1024 kb/s
    Stream #0:0...`;
    const out = parseFfmpegDuration(stderr);
    expect(out.seconds).toBeCloseTo(798.52, 2);
    expect(out.matchedText).toBe('Duration: 00:13:18.52');
  });

  it('parses an hour-long duration', () => {
    const stderr = '...\n  Duration: 01:02:03.04, start: ...';
    const out = parseFfmpegDuration(stderr);
    expect(out.seconds).toBeCloseTo(1 * 3600 + 2 * 60 + 3 + 0.04, 2);
  });
});

describe('parseFfmpegDuration — format variations that USED to silently return 0', () => {
  it('parses a single-decimal "ss.N" fractional form (the user-reported case)', () => {
    const stderr = '...\n  Duration: 00:13:18.5, start: ...';
    const out = parseFfmpegDuration(stderr);
    expect(out.seconds).toBeCloseTo(798.5, 2);
    expect(out.matchedText).toContain('00:13:18.5');
  });

  it('parses a no-decimal whole-second form', () => {
    const stderr = '...\n  Duration: 00:13:18, start: ...';
    const out = parseFfmpegDuration(stderr);
    expect(out.seconds).toBe(13 * 60 + 18);
  });

  it('parses extra fractional precision (≥ 3 digits) without losing it', () => {
    const stderr = '...\n  Duration: 00:00:30.523456, start: ...';
    const out = parseFfmpegDuration(stderr);
    expect(out.seconds).toBeCloseTo(30.523456, 5);
  });

  it('parses single-digit minutes / seconds (some old ffmpeg builds)', () => {
    const stderr = '...\n  Duration: 0:1:5.20, start: ...';
    const out = parseFfmpegDuration(stderr);
    expect(out.seconds).toBeCloseTo(65.2, 2);
  });
});

describe('parseFfmpegDuration — explicit N/A and unparseable input', () => {
  it('returns null seconds for `Duration: N/A`', () => {
    const stderr = '...\n  Duration: N/A, start: 0.000000, bitrate: N/A';
    const out = parseFfmpegDuration(stderr);
    expect(out.seconds).toBeNull();
    expect(out.matchedText).toMatch(/N\/A/);
  });

  it('returns null seconds when no Duration line is present', () => {
    const stderr = 'ffmpeg version 4.4.2\nbuilt with gcc 9.4.0';
    const out = parseFfmpegDuration(stderr);
    expect(out.seconds).toBeNull();
    expect(out.matchedText).toBeNull();
  });

  it('returns null for empty stderr', () => {
    expect(parseFfmpegDuration('')).toEqual({ seconds: null, matchedText: null });
  });

  it('returns null for non-string input (defensive against caller mistakes)', () => {
    // @ts-expect-error — intentionally passing wrong type
    expect(parseFfmpegDuration(undefined)).toEqual({ seconds: null, matchedText: null });
  });
});

describe('estimateDurationSecFromWords — fallback when probe fails', () => {
  it('returns ~798 seconds for the user-reported 1996-word transcript', () => {
    // 1996 words / 150 wpm × 60 = 798.4 seconds → rounded to 798.
    expect(estimateDurationSecFromWords(1996)).toBe(798);
  });

  it('returns 60 seconds for 150 words (a one-minute clip)', () => {
    expect(estimateDurationSecFromWords(150)).toBe(60);
  });

  it('returns 0 for 0 words', () => {
    expect(estimateDurationSecFromWords(0)).toBe(0);
  });

  it('returns 0 for negative input (defensive)', () => {
    expect(estimateDurationSecFromWords(-100)).toBe(0);
  });

  it('returns 0 for non-finite input', () => {
    expect(estimateDurationSecFromWords(Number.NaN)).toBe(0);
    expect(estimateDurationSecFromWords(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
