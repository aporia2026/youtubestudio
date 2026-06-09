import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 1 of `_plans/2026-06-09-motion-collage-async-bulk-regen.md`.
//
// The /bulk-regen endpoint queues motion-collage rows for the
// auto-pipeline to regenerate server-side. These tests pin its
// validation gates (rejected reasons, cost cap, rate limit) and the
// happy-path artefact mutation. The actual auto-pipeline tick is
// mocked — we verify the endpoint clears URLs + re-activates the
// video, and trust the existing auto-pipeline tests to cover the
// downstream generation.

// Mock the @vercel/postgres module BEFORE importing the route. Each
// test installs its own fixture rows via the per-call `mockResolvedValueOnce`.
const sqlMock = vi.hoisted(() => {
  return {
    query: vi.fn(),
  };
});
vi.mock('@vercel/postgres', () => ({
  sql: sqlMock,
}));

// Auth + rate limit + logger mocks. checkRateLimit's default returns
// `{ limited: false }`; individual tests can flip to `{ limited: true }`
// to assert the 429 path. The session is injected through the
// `apiRoute.authed` wrapper, which we also stub.
const rateLimitMock = vi.hoisted(() => vi.fn(() => ({ limited: false, resetIn: 0 })));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: rateLimitMock,
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/route-helpers', () => ({
  apiRoute: {
    authed:
      (handler: (session: { uid: string; ws: string }, req: Request) => Promise<Response>) =>
      (req: Request) =>
        handler({ uid: 'test-uid', ws: 'test-ws' }, req),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// fetch — kick to the tick endpoint. Always succeeds; tests don't
// verify the kick contents directly (the kick is best-effort + the
// downstream tick is separately tested).
const fetchMock = vi.hoisted(() => vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
vi.stubGlobal('fetch', fetchMock);

import { POST } from '@/app/api/generate/production-doc/motion-collage/bulk-regen/route';

interface DocRow {
  shot_kind?: string;
  motion_collage_grid?: { cols: number; rows: number };
  motion_collage_panel_prompts?: string[];
  motion_collage_panel_urls?: string[];
  motion_collage_image_url?: string;
  image_url?: string;
  attempts?: number;
  last_error?: unknown;
}

function makeDoc(rows: DocRow[]): { rows: DocRow[] } {
  return { rows };
}

function makeArtefactFixture(rows: DocRow[]) {
  return {
    rows: [
      {
        attempt_number: 1,
        metadata_jsonb: { doc: makeDoc(rows) },
        pipeline_run_video_id: 'pv-1',
      },
    ],
  };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/generate/production-doc/motion-collage/bulk-regen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Next.js handler signature is `(req, ctx)`; ctx carries route
// params via a promise (the App Router contract). Our route doesn't
// read params, but the type signature still requires both args.
const NEXT_CTX = { params: Promise.resolve({}) };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callPost = (req: Request) => (POST as any)(req, NEXT_CTX) as Promise<Response>;

function validMotionCollageRow(overrides: Partial<DocRow> = {}): DocRow {
  return {
    shot_kind: 'motion_collage',
    motion_collage_grid: { cols: 2, rows: 2 },
    motion_collage_panel_prompts: ['p1', 'p2', 'p3', 'p4'],
    motion_collage_panel_urls: ['u1', 'u2', 'u3', 'u4'],
    motion_collage_image_url: 'collage-url',
    image_url: 'mirror-url',
    attempts: 1,
    last_error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockReturnValue({ limited: false, resetIn: 0 });
});

afterEach(() => {
  delete process.env.MOTION_COLLAGE_BULK_REGEN_CAP_USD;
});

describe('bulk-regen — body validation (returns 400 without touching DB)', () => {
  it('rejects when projectId is missing', async () => {
    const res = await callPost(makeRequest({ rowIndices: [0, 1] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/projectId is required/);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });

  it('rejects when rowIndices is empty', async () => {
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rowIndices/);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });

  it('rejects when rowIndices is not an array', async () => {
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: 'not-an-array' }));
    expect(res.status).toBe(400);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });

  it('rejects when rowIndices contains a non-integer', async () => {
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0, 1.5, 2] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid index/);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });

  it('rejects when rowIndices contains a negative integer', async () => {
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [-1, 0] }));
    expect(res.status).toBe(400);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });

  it('rejects when rowIndices exceeds the per-call cap', async () => {
    const huge = Array.from({ length: 201 }, (_, i) => i);
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: huge }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot exceed 200/);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });
});

describe('bulk-regen — rate limiting', () => {
  it('returns 429 when the per-IP limit is hit before any DB work', async () => {
    rateLimitMock.mockReturnValueOnce({ limited: true, resetIn: 5_000 });
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect(res.status).toBe(429);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-uid limit is hit (IP limit passed first)', async () => {
    rateLimitMock
      .mockReturnValueOnce({ limited: false, resetIn: 0 }) // IP
      .mockReturnValueOnce({ limited: true, resetIn: 10_000 }); // uid
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/Rate limited \(account\)/);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });
});

describe('bulk-regen — artefact resolution', () => {
  it('returns 404 when no artefact exists for the project (workspace-scoped)', async () => {
    sqlMock.query.mockResolvedValueOnce({ rows: [] });
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no production-doc artefact/);
  });

  it('returns 500 when the artefact has no rows array', async () => {
    sqlMock.query.mockResolvedValueOnce({
      rows: [
        {
          attempt_number: 1,
          metadata_jsonb: { doc: { not_rows: true } },
          pipeline_run_video_id: 'pv-1',
        },
      ],
    });
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/no rows array/);
  });
});

describe('bulk-regen — per-row rejection reasons', () => {
  it('rejects index_out_of_range when the index exceeds doc length', async () => {
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([validMotionCollageRow()]),
    );
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [5] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no rows accepted/);
    expect(body.rejected).toEqual([{ rowIndex: 5, reason: 'index_out_of_range' }]);
  });

  it('rejects not_motion_collage for non-motion-collage rows', async () => {
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([{ shot_kind: 'static' }]),
    );
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.rejected).toEqual([{ rowIndex: 0, reason: 'not_motion_collage' }]);
  });

  it('rejects invalid_grid when cols/rows are missing', async () => {
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([
        validMotionCollageRow({ motion_collage_grid: undefined }),
      ]),
    );
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect(res.status).toBe(400);
    expect((await res.json()).rejected).toEqual([
      { rowIndex: 0, reason: 'invalid_grid' },
    ]);
  });

  it('rejects panel_prompts_length_mismatch when prompts.length !== cols*rows', async () => {
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([
        validMotionCollageRow({ motion_collage_panel_prompts: ['only', 'two'] }),
      ]),
    );
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect((await res.json()).rejected).toEqual([
      { rowIndex: 0, reason: 'panel_prompts_length_mismatch' },
    ]);
  });

  it('rejects panel_prompt_empty when any prompt is whitespace-only', async () => {
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([
        validMotionCollageRow({
          motion_collage_panel_prompts: ['ok', '   \n  ', 'ok', 'ok'],
        }),
      ]),
    );
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect((await res.json()).rejected).toEqual([
      { rowIndex: 0, reason: 'panel_prompt_empty' },
    ]);
  });
});

describe('bulk-regen — cost cap', () => {
  it('rejects when estimated cost exceeds the cap', async () => {
    process.env.MOTION_COLLAGE_BULK_REGEN_CAP_USD = '0.05';
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([validMotionCollageRow()]),
    );
    // 4 panels × $0.0135 = $0.054, just over a $0.05 cap.
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds per-batch cap/);
    expect(body.estCostUsd).toBeCloseTo(0.054, 3);
    expect(body.capUsd).toBeCloseTo(0.05, 3);
  });

  it('accepts when estimated cost is at or under the cap', async () => {
    process.env.MOTION_COLLAGE_BULK_REGEN_CAP_USD = '0.10';
    sqlMock.query
      .mockResolvedValueOnce(makeArtefactFixture([validMotionCollageRow()]))
      .mockResolvedValueOnce({ rows: [] }) // UPDATE artefact
      .mockResolvedValueOnce({ rows: [] }); // UPDATE stage
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect(res.status).toBe(200);
  });
});

describe('bulk-regen — happy path', () => {
  it('clears URLs + attempts + last_error on each queued row, persists artefact, kicks tick', async () => {
    const rows = [
      validMotionCollageRow(),
      validMotionCollageRow({
        motion_collage_grid: { cols: 3, rows: 2 },
        motion_collage_panel_prompts: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      }),
    ];
    sqlMock.query
      .mockResolvedValueOnce(makeArtefactFixture(rows))
      .mockResolvedValueOnce({ rows: [] }) // UPDATE artefact
      .mockResolvedValueOnce({ rows: [] }); // UPDATE stage
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0, 1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(2);
    expect(body.rejected).toEqual([]);
    // 4 + 6 panels × $0.0135 each = $0.135
    expect(body.estCostUsd).toBeCloseTo(0.135, 3);
    expect(body.kickedTick).toBe(true);
    // Three DB queries: artefact lookup, artefact UPDATE, stage UPDATE.
    expect(sqlMock.query).toHaveBeenCalledTimes(3);
    // Verify the kick fired.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kickUrl = String(((fetchMock.mock.calls as any[])[0]?.[0]) ?? '');
    expect(kickUrl).toMatch(/\/api\/auto-pipeline\/tick$/);
    // The UPDATE artefact call (second sql.query) writes the doc back.
    // Pull the JSON payload and assert both rows had their URLs +
    // attempts + last_error cleared.
    const updateCall = sqlMock.query.mock.calls[1];
    expect(updateCall?.[0]).toMatch(/UPDATE pipeline_stage_artefacts/);
    const writtenJson = updateCall?.[1]?.[0] as string;
    const written = JSON.parse(writtenJson) as {
      doc: { rows: Record<string, unknown>[] };
    };
    for (let i = 0; i < 2; i++) {
      const row = written.doc.rows[i];
      expect(row.image_url).toBeUndefined();
      expect(row.motion_collage_image_url).toBeUndefined();
      expect(row.motion_collage_panel_urls).toBeUndefined();
      expect(row.attempts).toBeUndefined();
      expect(row.last_error).toBeUndefined();
      // Preserved fields:
      expect(row.shot_kind).toBe('motion_collage');
      expect(row.motion_collage_grid).toBeDefined();
      expect(row.motion_collage_panel_prompts).toBeDefined();
    }
  });

  it('mixed batch: accepts valid rows + reports rejected ones in the same response', async () => {
    const rows = [
      validMotionCollageRow(), // 0: valid
      { shot_kind: 'static' } as DocRow, // 1: rejected — not_motion_collage
      validMotionCollageRow({ motion_collage_panel_prompts: ['p'] }), // 2: rejected — length mismatch (grid says 4)
    ];
    sqlMock.query
      .mockResolvedValueOnce(makeArtefactFixture(rows))
      .mockResolvedValueOnce({ rows: [] }) // UPDATE artefact
      .mockResolvedValueOnce({ rows: [] }); // UPDATE stage
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0, 1, 2] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued).toBe(1);
    expect(body.rejected).toEqual([
      { rowIndex: 1, reason: 'not_motion_collage' },
      { rowIndex: 2, reason: 'panel_prompts_length_mismatch' },
    ]);
  });

  it('survives a kick-tick failure — returns kickedTick=false but still 200', async () => {
    sqlMock.query
      .mockResolvedValueOnce(makeArtefactFixture([validMotionCollageRow()]))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    fetchMock.mockRejectedValueOnce(new Error('kick failed'));
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(1);
    expect(body.kickedTick).toBe(false);
  });

  it('de-duplicates repeated indices in the request', async () => {
    sqlMock.query
      .mockResolvedValueOnce(makeArtefactFixture([validMotionCollageRow()]))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await callPost(makeRequest({ projectId: 'p1', rowIndices: [0, 0, 0] }));
    expect((await res.json()).queued).toBe(1);
  });
});
