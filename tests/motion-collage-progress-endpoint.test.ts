import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 3 of `_plans/2026-06-09-motion-collage-async-bulk-regen.md`.
//
// The slim GET /motion-collage/progress endpoint that the editor
// polls every 8 s. These tests pin its auth + workspace scoping,
// rate limiting, and the slim response shape — the editor only
// needs the panel URLs + image URL per motion-collage row, NOT
// the full image-progress payload, so the response is intentionally
// minimal.

const sqlMock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@vercel/postgres', () => ({ sql: sqlMock }));

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

import { GET } from '@/app/api/generate/production-doc/motion-collage/progress/route';

// Next.js handler signature requires a 2nd ctx arg; the route ignores
// it but the type does not.
const NEXT_CTX = { params: Promise.resolve({}) };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callGet = (req: Request) => (GET as any)(req, NEXT_CTX) as Promise<Response>;

interface DocRow {
  shot_kind?: string;
  motion_collage_panel_urls?: string[];
  motion_collage_image_url?: string;
  image_url?: string;
  attempts?: number;
  last_error?: { class: string; message: string; at: string } | null;
}

function makeArtefactFixture(rows: DocRow[]) {
  return {
    rows: [
      {
        attempt_number: 1,
        metadata_jsonb: { doc: { rows } },
      },
    ],
  };
}

function makeRequest(projectId?: string): Request {
  const url = projectId
    ? `http://localhost/api/generate/production-doc/motion-collage/progress?projectId=${encodeURIComponent(projectId)}`
    : 'http://localhost/api/generate/production-doc/motion-collage/progress';
  return new Request(url, { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockReturnValue({ limited: false, resetIn: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('progress — query param validation', () => {
  it('rejects when projectId query param is missing', async () => {
    const res = await callGet(makeRequest(undefined));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/projectId/);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });

  it('rejects when projectId is whitespace-only', async () => {
    const res = await callGet(makeRequest('   '));
    expect(res.status).toBe(400);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });
});

describe('progress — rate limiting', () => {
  it('returns 429 on the per-IP limit before touching the DB', async () => {
    rateLimitMock.mockReturnValueOnce({ limited: true, resetIn: 5_000 });
    const res = await callGet(makeRequest('p1'));
    expect(res.status).toBe(429);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });

  it('returns 429 on the per-uid limit (IP passed first)', async () => {
    rateLimitMock
      .mockReturnValueOnce({ limited: false, resetIn: 0 })
      .mockReturnValueOnce({ limited: true, resetIn: 10_000 });
    const res = await callGet(makeRequest('p1'));
    expect(res.status).toBe(429);
    expect(sqlMock.query).not.toHaveBeenCalled();
  });
});

describe('progress — artefact resolution', () => {
  it('returns 404 when no artefact exists for the project (workspace-scoped)', async () => {
    sqlMock.query.mockResolvedValueOnce({ rows: [] });
    const res = await callGet(makeRequest('p1'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no production-doc artefact/);
  });

  it('returns 500 when the artefact has no rows array', async () => {
    sqlMock.query.mockResolvedValueOnce({
      rows: [{ attempt_number: 1, metadata_jsonb: { doc: { not_rows: true } } }],
    });
    const res = await callGet(makeRequest('p1'));
    expect(res.status).toBe(500);
  });
});

describe('progress — slim response shape', () => {
  it('returns ONLY motion-collage rows; other shot kinds are filtered out', async () => {
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([
        { shot_kind: 'static' },
        { shot_kind: 'motion_collage', motion_collage_panel_urls: ['a', 'b', 'c', 'd'] },
        { shot_kind: 'Title Card' },
        { shot_kind: 'motion_collage', motion_collage_panel_urls: ['e', '', '', ''] },
      ]),
    );
    const res = await callGet(makeRequest('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].rowIndex).toBe(1);
    expect(body.rows[1].rowIndex).toBe(3);
  });

  it('emits every editor-needed field per motion-collage row', async () => {
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([
        {
          shot_kind: 'motion_collage',
          motion_collage_panel_urls: ['u0', 'u1', 'u2', 'u3'],
          motion_collage_image_url: 'collage-url',
          image_url: 'mirror-url',
          attempts: 2,
          last_error: { class: 'timeout', message: 'kie poll timed out', at: '2026-06-09T00:00:00Z' },
        },
      ]),
    );
    const res = await callGet(makeRequest('p1'));
    const body = await res.json();
    expect(body.rows[0]).toEqual({
      rowIndex: 0,
      motionCollagePanelUrls: ['u0', 'u1', 'u2', 'u3'],
      motionCollageImageUrl: 'collage-url',
      imageUrl: 'mirror-url',
      attempts: 2,
      lastErrorMessage: 'kie poll timed out',
    });
  });

  it('coerces missing fields to safe defaults (empty array / null / 0)', async () => {
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([{ shot_kind: 'motion_collage' }]),
    );
    const res = await callGet(makeRequest('p1'));
    const body = await res.json();
    expect(body.rows[0]).toEqual({
      rowIndex: 0,
      motionCollagePanelUrls: [],
      motionCollageImageUrl: null,
      imageUrl: null,
      attempts: 0,
      lastErrorMessage: null,
    });
  });

  it('returns an empty rows array when the doc has no motion-collage rows', async () => {
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([{ shot_kind: 'static' }, { shot_kind: 'Title Card' }]),
    );
    const res = await callGet(makeRequest('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([]);
  });

  it('preserves sparse panel URL arrays (does not compact empty slots)', async () => {
    // The editor needs to know WHICH slots are missing to render
    // per-panel "queued" placeholders correctly. The endpoint must NOT
    // filter out empty strings — they signal "this panel is still
    // pending generation."
    sqlMock.query.mockResolvedValueOnce(
      makeArtefactFixture([
        {
          shot_kind: 'motion_collage',
          motion_collage_panel_urls: ['u0', '', 'u2', ''],
        },
      ]),
    );
    const res = await callGet(makeRequest('p1'));
    const body = await res.json();
    expect(body.rows[0].motionCollagePanelUrls).toEqual(['u0', '', 'u2', '']);
  });
});
