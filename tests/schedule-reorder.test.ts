/**
 * Validation contract for POST /api/schedule/reorder.
 *
 * The endpoint rewrites schedule_items.position in a single transaction
 * driven by the supplied array order. A misbehaving client (or someone
 * crafting requests directly) could submit non-UUIDs, oversized arrays,
 * or duplicates — these tests pin the input gates so a regression there
 * doesn't quietly take a DB connection down.
 *
 * The SQL itself (the UPDATE … FROM unnest WITH ORDINALITY) is exercised
 * by the live system; we assert the route's contract by mocking
 * `@vercel/postgres` and watching what gets passed to `sql.query`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  ensureScheduleSchema: vi.fn(async () => {}),
  sql: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ limited: false })),
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

function makeReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request('https://app.test/api/schedule/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const uuidA = '11111111-1111-1111-1111-111111111111';
const uuidB = '22222222-2222-2222-2222-222222222222';
const uuidC = '33333333-3333-3333-3333-333333333333';

describe('POST /api/schedule/reorder', () => {
  let POST: (req: NextRequest) => Promise<Response>;
  let sqlQueryMock: ReturnType<typeof vi.fn>;
  let checkRateLimitMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    ({ POST } = await import('@/app/api/schedule/reorder/route'));
    const dbMod = await import('@/lib/db');
    // `sql` is the mocked object from vi.mock above — pull out the
    // typed mock fn so tests can clear / inspect calls.
    sqlQueryMock = (dbMod.sql as unknown as { query: ReturnType<typeof vi.fn> }).query;
    sqlQueryMock.mockClear();
    sqlQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const rateLimitMod = await import('@/lib/rate-limit');
    checkRateLimitMock = rateLimitMod.checkRateLimit as unknown as ReturnType<typeof vi.fn>;
    checkRateLimitMock.mockReset();
    checkRateLimitMock.mockReturnValue({ limited: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects requests with no ids array', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(sqlQueryMock).not.toHaveBeenCalled();
  });

  it('rejects an empty ids array', async () => {
    const res = await POST(makeReq({ ids: [] }));
    expect(res.status).toBe(400);
    expect(sqlQueryMock).not.toHaveBeenCalled();
  });

  it('rejects non-UUID ids', async () => {
    const res = await POST(makeReq({ ids: [uuidA, 'not-a-uuid'] }));
    expect(res.status).toBe(400);
    expect(sqlQueryMock).not.toHaveBeenCalled();
  });

  it('rejects arrays larger than the hard cap', async () => {
    // Spam the cap + 1 with valid UUIDs; the route shouldn't touch the DB.
    const huge = Array.from({ length: 501 }, (_, i) => {
      const hex = i.toString(16).padStart(12, '0');
      return `00000000-0000-0000-0000-${hex}`;
    });
    const res = await POST(makeReq({ ids: huge }));
    expect(res.status).toBe(400);
    expect(sqlQueryMock).not.toHaveBeenCalled();
  });

  it('returns 429 when the rate limit fires before touching the DB', async () => {
    checkRateLimitMock.mockReturnValueOnce({ limited: true });
    const res = await POST(makeReq({ ids: [uuidA, uuidB] }));
    expect(res.status).toBe(429);
    expect(sqlQueryMock).not.toHaveBeenCalled();
  });

  it('dedupes a repeated id (first occurrence wins) before persisting', async () => {
    // A buggy drag-and-drop loop could send the same id twice — we
    // collapse to the first instance so positions stay unambiguous.
    const res = await POST(makeReq({ ids: [uuidA, uuidB, uuidA] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);
    expect(sqlQueryMock).toHaveBeenCalledTimes(1);
    const passed = sqlQueryMock.mock.calls[0][1] as [string[]];
    expect(passed[0]).toEqual([uuidA, uuidB]);
  });

  it('passes ids in array order to the SQL UPDATE so position = index + 1', async () => {
    const res = await POST(makeReq({ ids: [uuidC, uuidA, uuidB] }));
    expect(res.status).toBe(200);
    expect(sqlQueryMock).toHaveBeenCalledTimes(1);
    const passed = sqlQueryMock.mock.calls[0][1] as [string[]];
    // The route trusts the array order — whatever the client shows after
    // the drag is what the next GET will return. The SQL fragment ordinality
    // numbers them 1, 2, 3 …
    expect(passed[0]).toEqual([uuidC, uuidA, uuidB]);
  });

  it('returns 500 if the DB call throws (rather than leaking the stack)', async () => {
    sqlQueryMock.mockRejectedValueOnce(new Error('connection terminated'));
    const res = await POST(makeReq({ ids: [uuidA] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed');
  });
});
