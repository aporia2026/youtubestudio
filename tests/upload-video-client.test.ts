/**
 * Pure-helper tests for the shared review-video upload client. The full
 * pipeline needs a DOM (compress-video uses WebCodecs, the probe needs
 * <video>, the PUT uses XMLHttpRequest) — those paths are exercised by
 * the manual QA plan in _plans/2026-05-09-owner-side-editor-video-upload.md.
 *
 * `classifyXhrFailure` is the part that decides which user-meaningful
 * error code we surface for each XHR outcome, so it gets the strongest
 * coverage here.
 */
import { describe, expect, it } from 'vitest';
import { classifyXhrFailure } from '@/lib/upload-video-client';

describe('classifyXhrFailure', () => {
  it('maps caller-aborted to ABORTED', () => {
    expect(classifyXhrFailure({ status: 0, reason: 'abort' })).toEqual({
      code: 'ABORTED',
      message: 'Upload was cancelled.',
    });
  });

  it('maps native xhr.timeout to PUT_TIMEOUT', () => {
    const out = classifyXhrFailure({ status: 0, reason: 'timeout' });
    expect(out.code).toBe('PUT_TIMEOUT');
    expect(out.message).toContain('timed out');
  });

  it('maps stall-detector to PUT_STALL with the 60s hint', () => {
    const out = classifyXhrFailure({ status: 0, reason: 'stall' });
    expect(out.code).toBe('PUT_STALL');
    expect(out.message).toMatch(/60 seconds/);
  });

  it('maps xhr.error with status 0 to PUT_CORS', () => {
    // R2/CORS rejection / DNS failure / proxy block → status 0.
    const out = classifyXhrFailure({ status: 0, reason: 'error' });
    expect(out.code).toBe('PUT_CORS');
    expect(out.message).toMatch(/CORS/);
  });

  it('maps a 403 load to PUT_URL_EXPIRED (presigned URL TTL exceeded)', () => {
    // Most common cause of 403 from R2 is the presign expiring — surface
    // the actionable hint instead of "HTTP 403".
    const out = classifyXhrFailure({ status: 403, reason: 'load' });
    expect(out.code).toBe('PUT_URL_EXPIRED');
    expect(out.message).toContain('expired');
  });

  it('maps a 403 from a stall-or-error event to PUT_URL_EXPIRED, not PUT_REJECTED', () => {
    // A presign that goes 403 mid-stream typically surfaces as `error`
    // with status 403; classify by status first.
    expect(classifyXhrFailure({ status: 403, reason: 'error' }).code).toBe('PUT_URL_EXPIRED');
    expect(classifyXhrFailure({ status: 403, reason: 'stall' }).code).toBe('PUT_URL_EXPIRED');
  });

  it('maps any other 4xx/5xx to PUT_REJECTED with the status in the message', () => {
    expect(classifyXhrFailure({ status: 400, reason: 'load' })).toEqual({
      code: 'PUT_REJECTED',
      message: 'Upload failed (HTTP 400). Check bucket permissions or try again.',
    });
    expect(classifyXhrFailure({ status: 500, reason: 'load' })).toEqual({
      code: 'PUT_REJECTED',
      message: 'Upload failed (HTTP 500). Check bucket permissions or try again.',
    });
    expect(classifyXhrFailure({ status: 503, reason: 'error' })).toEqual({
      code: 'PUT_REJECTED',
      message: 'Upload failed (HTTP 503). Check bucket permissions or try again.',
    });
  });

  it('maps an unexpected 2xx to PUT_REJECTED rather than silently treating it as success', () => {
    // The PUT-success path should be filtered out before classify is
    // called, but if anything ever leaks a 2xx into here we want it
    // logged as a real error rather than swallowed.
    const out = classifyXhrFailure({ status: 204, reason: 'load' });
    expect(out.code).toBe('PUT_REJECTED');
  });
});
