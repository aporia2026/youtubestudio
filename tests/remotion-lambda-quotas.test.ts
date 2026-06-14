import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLambdaQuotas, preflightLambdaQuota } from '@/lib/remotion-lambda-quotas';

// Hoisted SQL mock — vi.mock callback evaluates BEFORE imports, so we
// can't close over a module-scoped `sqlMock`. The `vi.hoisted` helper
// runs synchronously at the top of the file so the returned function
// reference is stable across mock registrations and `vi.mocked()` calls.
const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('@vercel/postgres', () => ({ sql: sqlMock }));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  sqlMock.mockReset();
  delete process.env.LAMBDA_IN_FLIGHT_MAX_AGE_MINUTES;
  delete process.env.LAMBDA_MAX_CONCURRENT_RENDERS;
  delete process.env.LAMBDA_MAX_SPEND_USD_PER_DAY;
});

describe('getLambdaQuotas', () => {
  it('defaults inFlightMaxAgeMinutes to 30', () => {
    expect(getLambdaQuotas().inFlightMaxAgeMinutes).toBe(30);
  });

  it('reads LAMBDA_IN_FLIGHT_MAX_AGE_MINUTES from env', () => {
    process.env.LAMBDA_IN_FLIGHT_MAX_AGE_MINUTES = '120';
    expect(getLambdaQuotas().inFlightMaxAgeMinutes).toBe(120);
  });

  it('falls back to default when env value is non-positive', () => {
    process.env.LAMBDA_IN_FLIGHT_MAX_AGE_MINUTES = '-5';
    expect(getLambdaQuotas().inFlightMaxAgeMinutes).toBe(30);
  });
});

describe('preflightLambdaQuota — age-based concurrent count', () => {
  it('counts only rows whose started_at is within the in-flight age window', async () => {
    // Two SQL calls in parallel: spend SELECT then concurrent SELECT.
    // We record what the concurrent query receives so we can assert
    // the cutoff parameter is the right number of ms from now.
    let capturedConcurrentArgs: unknown[] | null = null;
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...args: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('COALESCE(SUM(estimated_cost)')) {
        return Promise.resolve({ rows: [{ sum: 0 }] });
      }
      // Concurrent count query — record args and pretend the table has
      // 2 in-flight rows that are recent enough to count.
      capturedConcurrentArgs = args;
      return Promise.resolve({ rows: [{ count: '2' }] });
    });

    const before = Date.now();
    const decision = await preflightLambdaQuota();
    const after = Date.now();
    expect(decision.ok).toBe(true);

    // The concurrent query templates dayAgoMs (spend) is gone in this
    // branch; the only parameter is `inFlightCutoffMs`. Assert it lands
    // ~30 minutes before now (within a generous tolerance for the test
    // executing slowly).
    expect(capturedConcurrentArgs).not.toBeNull();
    expect(capturedConcurrentArgs!.length).toBe(1);
    const cutoff = capturedConcurrentArgs![0] as number;
    const expectedCutoff = before - 30 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(expectedCutoff - 1000);
    expect(cutoff).toBeLessThanOrEqual(after - 30 * 60 * 1000 + 1000);
  });

  it('passes the env-overridden window through to the cutoff', async () => {
    process.env.LAMBDA_IN_FLIGHT_MAX_AGE_MINUTES = '5';
    let capturedConcurrentArgs: unknown[] | null = null;
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...args: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('COALESCE(SUM(estimated_cost)')) {
        return Promise.resolve({ rows: [{ sum: 0 }] });
      }
      capturedConcurrentArgs = args;
      return Promise.resolve({ rows: [{ count: '0' }] });
    });

    const before = Date.now();
    await preflightLambdaQuota();
    const cutoff = capturedConcurrentArgs![0] as number;
    const expectedCutoff = before - 5 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(expectedCutoff - 1000);
    expect(cutoff).toBeLessThanOrEqual(expectedCutoff + 1000);
  });

  it('rejects with the cap-hit message when the recent count meets the cap', async () => {
    process.env.LAMBDA_MAX_CONCURRENT_RENDERS = '3';
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('COALESCE(SUM(estimated_cost)')) {
        return Promise.resolve({ rows: [{ sum: 0 }] });
      }
      return Promise.resolve({ rows: [{ count: '3' }] });
    });

    const decision = await preflightLambdaQuota();
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/Already 3 renders in flight \(cap 3\)/);
      expect(decision.retryAfterSeconds).toBe(60);
    }
  });

  it('fails closed when the DB read throws', async () => {
    sqlMock.mockRejectedValue(new Error('neon timeout'));
    const decision = await preflightLambdaQuota();
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/budget check temporarily unavailable/i);
  });
});
