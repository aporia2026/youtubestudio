import { describe, expect, it } from 'vitest';
import {
  CLIP_MAX_DURATION_SEC,
  CLIP_MIN_DURATION_SEC,
  buildCenterCrop916FilterArg,
  buildClipFfmpegArgs,
  buildClipOutputKey,
  validateClipRange,
} from '@/lib/shorts-clip-from-mp4';

describe('buildCenterCrop916FilterArg', () => {
  it('emits a two-step filtergraph: crop then scale to 1080x1920', () => {
    const arg = buildCenterCrop916FilterArg();
    expect(arg).toMatch(/^crop=/);
    expect(arg).toContain('scale=1080:1920');
    expect(arg.split(',').length).toBe(2);
  });

  it('uses input-relative expressions so any source resolution works', () => {
    const arg = buildCenterCrop916FilterArg();
    expect(arg).toContain('in_h*9/16');
    expect(arg).toContain('in_w');
  });

  it('keeps the crop width even (libx264 requires divisible-by-2 dims)', () => {
    const arg = buildCenterCrop916FilterArg();
    expect(arg).toMatch(/floor\(.*\/2\)\*2/);
  });
});

describe('buildClipFfmpegArgs', () => {
  const baseArgs = {
    sourceUrl: 'https://example.com/source.mp4',
    startSec: 12.5,
    endSec: 57.5,
    outputPath: '/tmp/clip.mp4',
  };

  it('places -ss BEFORE -i for fast seek', () => {
    const args = buildClipFfmpegArgs(baseArgs);
    const ssIdx = args.indexOf('-ss');
    const iIdx = args.indexOf('-i');
    expect(ssIdx).toBeGreaterThan(-1);
    expect(iIdx).toBeGreaterThan(-1);
    expect(ssIdx).toBeLessThan(iIdx);
  });

  it('computes duration from end minus start', () => {
    const args = buildClipFfmpegArgs(baseArgs);
    const tIdx = args.indexOf('-t');
    expect(args[tIdx + 1]).toBe('45.000');
  });

  it('writes the source URL as the -i argument', () => {
    const args = buildClipFfmpegArgs(baseArgs);
    const iIdx = args.indexOf('-i');
    expect(args[iIdx + 1]).toBe(baseArgs.sourceUrl);
  });

  it('writes the output path as the trailing positional argument', () => {
    const args = buildClipFfmpegArgs(baseArgs);
    expect(args[args.length - 1]).toBe(baseArgs.outputPath);
  });

  it('hardcodes the center-crop 9:16 filter via -vf', () => {
    const args = buildClipFfmpegArgs(baseArgs);
    const vfIdx = args.indexOf('-vf');
    expect(args[vfIdx + 1]).toBe(buildCenterCrop916FilterArg());
  });

  it('includes faststart + yuv420p for MP4 + web playback compatibility', () => {
    const args = buildClipFfmpegArgs(baseArgs);
    expect(args).toContain('+faststart');
    expect(args).toContain('yuv420p');
  });

  it('clamps duration to at least 0.5s even for zero/negative ranges', () => {
    const args = buildClipFfmpegArgs({ ...baseArgs, startSec: 10, endSec: 9.9 });
    const tIdx = args.indexOf('-t');
    expect(parseFloat(args[tIdx + 1]!)).toBeGreaterThanOrEqual(0.5);
  });
});

describe('validateClipRange', () => {
  it('accepts valid ranges', () => {
    expect(validateClipRange(0, 30)).toBeNull();
    expect(validateClipRange(120, 150)).toBeNull();
    expect(validateClipRange(0, 90)).toBeNull();
  });

  it('rejects non-numeric or non-finite inputs', () => {
    expect(validateClipRange(NaN, 10)).toMatch(/start_seconds/);
    expect(validateClipRange(0, Infinity)).toMatch(/end_seconds/);
    expect(validateClipRange('zero', 10)).toMatch(/start_seconds/);
    expect(validateClipRange(0, 'ten')).toMatch(/end_seconds/);
  });

  it('rejects negative start time', () => {
    expect(validateClipRange(-1, 10)).toMatch(/start_seconds/);
  });

  it('rejects end <= start', () => {
    expect(validateClipRange(10, 10)).toMatch(/greater than/);
    expect(validateClipRange(10, 5)).toMatch(/greater than/);
  });

  it('rejects below-minimum duration', () => {
    expect(validateClipRange(0, CLIP_MIN_DURATION_SEC - 0.5)).toMatch(/at least/);
  });

  it('rejects above-maximum duration', () => {
    expect(validateClipRange(0, CLIP_MAX_DURATION_SEC + 1)).toMatch(/cannot exceed/);
  });
});

describe('buildClipOutputKey', () => {
  it('namespaces clips under the workspace id', () => {
    const key = buildClipOutputKey('ws-uuid-123');
    expect(key).toContain('shorts/mode-b/ws-uuid-123/');
  });

  it('ends in .mp4', () => {
    expect(buildClipOutputKey('w')).toMatch(/\.mp4$/);
  });

  it('includes a UUID per call so concurrent clips don\'t collide', () => {
    const a = buildClipOutputKey('w');
    const b = buildClipOutputKey('w');
    expect(a).not.toBe(b);
  });

  it('uses an ISO-like timestamp instead of raw colons (S3-safe)', () => {
    const key = buildClipOutputKey('w');
    expect(key).not.toContain(':');
  });
});
