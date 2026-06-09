import { describe, expect, it, vi } from 'vitest';
import {
  computeBackoffMs,
  isRetryableFailureClass,
  retryTransient,
} from '@/lib/shorts-batch-retry';

describe('isRetryableFailureClass', () => {
  it('retries transient_5xx, rate_limit, timeout', () => {
    expect(isRetryableFailureClass('transient_5xx')).toBe(true);
    expect(isRetryableFailureClass('rate_limit')).toBe(true);
    expect(isRetryableFailureClass('timeout')).toBe(true);
  });
  it('does NOT retry content_refusal, empty_or_malformed, unknown', () => {
    // Refusals are content decisions — retrying ships content the model
    // declined to produce. Empty/malformed and unknown are conservative
    // short-circuits (per ai-fallback.ts policy).
    expect(isRetryableFailureClass('content_refusal')).toBe(false);
    expect(isRetryableFailureClass('empty_or_malformed')).toBe(false);
    expect(isRetryableFailureClass('unknown')).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  it('produces an exponential schedule before jitter', () => {
    // Inject random=0.5 (no jitter, jitter formula = (0.5 - 0.5) * 0.4 = 0).
    const r = () => 0.5;
    expect(computeBackoffMs(1, 1000, 3, 60_000, r)).toBe(1000); // 1s
    expect(computeBackoffMs(2, 1000, 3, 60_000, r)).toBe(3000); // 3s
    expect(computeBackoffMs(3, 1000, 3, 60_000, r)).toBe(9000); // 9s
  });
  it('caps at maxDelayMs', () => {
    expect(computeBackoffMs(10, 1000, 3, 5000, () => 0.5)).toBe(5000);
  });
  it('applies ±20% jitter bounds and never returns negative', () => {
    expect(computeBackoffMs(1, 1000, 3, 60_000, () => 0)).toBe(800);   // -20%
    expect(computeBackoffMs(1, 1000, 3, 60_000, () => 1)).toBe(1200);  // +20%
    // baseDelayMs=0 with negative jitter must clamp to 0 (Math.max guard).
    expect(computeBackoffMs(1, 0, 3, 60_000, () => 0)).toBe(0);
  });
});

describe('retryTransient', () => {
  const noSleep = (_ms: number) => Promise.resolve();

  it('returns the first attempt result when fn succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryTransient(fn, { sleep: noSleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient_5xx and succeeds on the second attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Kie gateway error (code 500): server is currently being maintained'))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    const result = await retryTransient(fn, { sleep: noSleep, onRetry });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0].failureClass).toBe('transient_5xx');
    expect(onRetry.mock.calls[0][0].attempt).toBe(1);
  });

  it('does NOT retry content_refusal (4xx-equivalent content decision)', async () => {
    // Inject a fake classifier so the test doesn't depend on
    // string-text heuristics in classifyFailure.
    const fn = vi.fn().mockRejectedValue(new Error('declined'));
    await expect(
      retryTransient(fn, { sleep: noSleep, classify: () => 'content_refusal' }),
    ).rejects.toThrow('declined');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry unknown failure class', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('400 bad request'));
    await expect(
      retryTransient(fn, { sleep: noSleep, classify: () => 'unknown' }),
    ).rejects.toThrow('400 bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows the last error after exhausting maxAttempts', async () => {
    const err = new Error('persistent 503 service unavailable');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryTransient(fn, { sleep: noSleep, maxAttempts: 3 }),
    ).rejects.toBe(err); // exact same Error instance, not a wrapper
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects custom maxAttempts (e.g., 1 = no retries)', async () => {
    const err = new Error('503');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryTransient(fn, { sleep: noSleep, maxAttempts: 1 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes the right info to onRetry for each retry', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Kie code 502 bad gateway'))
      .mockRejectedValueOnce(new Error('Kie code 500'))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    await retryTransient(fn, { sleep: noSleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    // First retry = after the first failure (attempt index 1).
    expect(onRetry.mock.calls[0][0].attempt).toBe(1);
    expect(onRetry.mock.calls[1][0].attempt).toBe(2);
  });

  it('does NOT invoke onRetry after the final failed attempt', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503'));
    const onRetry = vi.fn();
    await expect(
      retryTransient(fn, { sleep: noSleep, maxAttempts: 2, onRetry }),
    ).rejects.toThrow();
    // Two attempts → one retry between them → exactly one onRetry call.
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('actually awaits the sleep between retries', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Kie 500'))
      .mockResolvedValueOnce('ok');
    await retryTransient(fn, { sleep, baseDelayMs: 50, factor: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
    // Default factor=3 makes the schedule 1s, 3s; we overrode to
    // baseDelayMs=50, factor=2, so the first delay is ~50ms ± jitter.
    const requestedDelay = sleep.mock.calls[0][0] as number;
    expect(requestedDelay).toBeGreaterThanOrEqual(40); // 50 - 20%
    expect(requestedDelay).toBeLessThanOrEqual(60);    // 50 + 20%
  });
});
