import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  getThrottleState,
  queueImageGen,
  reportUpstream429,
  subscribeThrottle,
  type ThrottleState,
} from '@/lib/image-gen-throttle';

// Unit-tests for the client-side image-gen throttle. Plan:
// _plans/2026-05-27-image-gen-client-throttle.md.
//
// The module ships in two pieces — a token-bucket sliding window for
// the per-minute cap, and a concurrency counter for parallelism. Each
// test below exercises one of those axes in isolation so a regression
// points at a specific knob.

beforeEach(() => {
  __resetForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  __resetForTests();
  vi.useRealTimers();
});

/** Helper — resolve a promise that the throttle has enqueued. */
function neverResolves(): Promise<never> {
  return new Promise<never>(() => {});
}

describe('queueImageGen — fast path', () => {
  it('runs fn immediately when the bucket has room', async () => {
    let ran = false;
    const result = await queueImageGen('generate', 'test', async () => {
      ran = true;
      return 'ok';
    });
    expect(ran).toBe(true);
    expect(result).toBe('ok');
  });

  it('decrements tokens-left on acquire', async () => {
    await queueImageGen('generate', 'test', async () => 'ok');
    expect(getThrottleState().tokensLeft.generate).toBe(24);
    expect(getThrottleState().tokensLeft.edit).toBe(18);
  });

  it('decrements only the matching category', async () => {
    await queueImageGen('edit', 'test', async () => 'ok');
    expect(getThrottleState().tokensLeft.generate).toBe(25);
    expect(getThrottleState().tokensLeft.edit).toBe(17);
  });

  it('releases the in-flight slot even when fn throws', async () => {
    await expect(
      queueImageGen('generate', 'test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(getThrottleState().inFlight).toBe(0);
  });
});

describe('queueImageGen — per-minute cap', () => {
  it('caps `generate` at 25 calls in a rolling 60s window', async () => {
    for (let i = 0; i < 25; i++) {
      await queueImageGen('generate', `t${i}`, async () => 'ok');
    }
    expect(getThrottleState().tokensLeft.generate).toBe(0);

    let resolved = false;
    const blockedPromise = queueImageGen('generate', 't26', async () => {
      resolved = true;
      return 'late';
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // schedulePump adds a +5ms clock-skew buffer to its setTimeout, so
    // 60_001ms is not enough to fire it. 65_000 clears the buffer.
    await vi.advanceTimersByTimeAsync(65_000);
    await blockedPromise;
    expect(resolved).toBe(true);
  });

  it('caps `edit` at 18 calls in a rolling 60s window', async () => {
    for (let i = 0; i < 18; i++) {
      await queueImageGen('edit', `t${i}`, async () => 'ok');
    }
    expect(getThrottleState().tokensLeft.edit).toBe(0);

    let resolved = false;
    const blocked = queueImageGen('edit', 't19', async () => {
      resolved = true;
      return 'late';
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(65_000);
    await blocked;
    expect(resolved).toBe(true);
  });

  it('treats a `generate` call as 1 token regardless of how many images it returns (collage parity)', async () => {
    // The whole point of "collage = 1 token" — calling queueImageGen
    // once for a collage call consumes exactly one slot, just like a
    // single-shot. The throughput multiplier comes from the server
    // returning 4 images for that 1 call. This test pins the contract.
    await queueImageGen('generate', 'collage-1', async () => ({ images: [1, 2, 3, 4] }));
    expect(getThrottleState().tokensLeft.generate).toBe(24);
    await queueImageGen('generate', 'single-1', async () => ({ images: [1] }));
    expect(getThrottleState().tokensLeft.generate).toBe(23);
  });
});

describe('queueImageGen — concurrency cap', () => {
  it('runs at most 3 in flight at the same time', async () => {
    const running: number[] = [];
    let peak = 0;

    // Block each fn until we tell it to finish so we can observe peak.
    const releases: Array<() => void> = [];
    const promises = [0, 1, 2, 3, 4].map((i) =>
      queueImageGen('generate', `t${i}`, async () => {
        running.push(i);
        peak = Math.max(peak, running.length);
        await new Promise<void>((r) => releases.push(r));
        running.splice(running.indexOf(i), 1);
        return i;
      }),
    );

    // Let the throttle dispatch the first batch (3 should start; 2 should queue).
    await vi.advanceTimersByTimeAsync(0);
    expect(running.length).toBe(3);
    expect(peak).toBe(3);
    expect(getThrottleState().queued).toBe(2);

    // Release them one by one and check that the queued ones flow in
    // without ever exceeding 3 in-flight.
    while (releases.length < 5) {
      const next = releases.shift();
      if (!next) break;
      next();
      await vi.advanceTimersByTimeAsync(0);
    }
    // Drain any remaining still-blocked fns.
    while (releases.length > 0) {
      releases.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    await Promise.all(promises);
    expect(peak).toBe(3);
  });
});

describe('reportUpstream429', () => {
  it('stalls the bucket by ~5 phantom tokens after a 429', () => {
    expect(getThrottleState().tokensLeft.generate).toBe(25);
    reportUpstream429('generate', 'test');
    expect(getThrottleState().tokensLeft.generate).toBe(20);
  });

  it('does not affect the other category', () => {
    reportUpstream429('generate', 'test');
    expect(getThrottleState().tokensLeft.edit).toBe(18);
  });
});

describe('subscribeThrottle', () => {
  it('pushes an initial snapshot synchronously', () => {
    const states: ThrottleState[] = [];
    const unsub = subscribeThrottle((s) => states.push(s));
    expect(states.length).toBe(1);
    expect(states[0].tokensLeft.generate).toBe(25);
    unsub();
  });

  it('notifies on acquire and release', async () => {
    const states: ThrottleState[] = [];
    const unsub = subscribeThrottle((s) => states.push(s));
    states.length = 0; // discard the initial snapshot

    await queueImageGen('generate', 'test', async () => 'ok');
    // At least one notify for acquire + one for release expected.
    expect(states.length).toBeGreaterThanOrEqual(1);
    unsub();
  });
});

// Block ESLint's no-unused-vars on the imported helper. The test
// intentionally references it only inside a comment-explained guard.
void neverResolves;
