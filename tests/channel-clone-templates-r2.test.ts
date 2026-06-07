/**
 * Unit tests for the channel-clone templates R2 helpers (Plan 2).
 *
 * Focuses on the pure pieces: extension inference + destination-key
 * construction. The actual CopyObject / HeadObject calls go through
 * a real S3 client whose plumbing is exercised in the production
 * QA pass (live R2 access required).
 *
 * See _plans/2026-06-07-channel-clone-preset-templates.md.
 */

import { describe, expect, it } from 'vitest';
import { inferExtensionFromKey } from '@/lib/channel-clone/templates-r2';

describe('templates-r2: inferExtensionFromKey', () => {
  it('returns the lowercased extension for common video keys', () => {
    expect(inferExtensionFromKey('channel-clone-uploads/abc/xyz.mp4')).toBe('mp4');
    expect(inferExtensionFromKey('channel-clone-uploads/abc/xyz.MP4')).toBe('mp4');
    expect(inferExtensionFromKey('channel-clone-uploads/abc/xyz.MOV')).toBe('mov');
    expect(inferExtensionFromKey('channel-clone-uploads/abc/xyz.webm')).toBe('webm');
    expect(inferExtensionFromKey('channel-clone-uploads/abc/xyz.mkv')).toBe('mkv');
  });

  it('returns null when there is no extension', () => {
    expect(inferExtensionFromKey('channel-clone-uploads/abc/xyz')).toBeNull();
    expect(inferExtensionFromKey('xyz')).toBeNull();
  });

  it('rejects extensions that are too short or too long', () => {
    expect(inferExtensionFromKey('file.a')).toBeNull();
    expect(inferExtensionFromKey('file.toolongtomatch')).toBeNull();
  });

  it('handles deeply nested keys', () => {
    expect(inferExtensionFromKey('a/b/c/d/e/f.mp4')).toBe('mp4');
  });

  it('only matches the final segment', () => {
    expect(inferExtensionFromKey('a.bcd/file.mp4')).toBe('mp4');
  });
});
