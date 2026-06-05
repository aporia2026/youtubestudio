/**
 * Route-level tests for /api/history.
 *
 * Two slices:
 *   1. Auth gates — anonymous requests (no cookie) must 401 on every
 *      verb, mirroring the pattern from `tests/auth-gates.test.ts`.
 *   2. Validation — with a forged-but-valid session JWT and a mocked
 *      @vercel/postgres client, exercise the input-validation paths
 *      without touching a real database.
 *
 * The DB integration path (insert + cap-trim + dedupe via the
 * partial unique index) is not asserted here — it's covered by the
 * migration test suite at the SQL level.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { SESSION_COOKIE_NAME } from '@/lib/session';

// ── Test plumbing ──────────────────────────────────────────────────

/** Mutable cookie store the cookies() mock reads from. */
const cookieStore = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const v = cookieStore.get(name);
        return v === undefined ? undefined : { name, value: v };
      },
      getAll: () =>
        [...cookieStore.entries()].map(([name, value]) => ({ name, value })),
      has: (name: string) => cookieStore.has(name),
    }),
}));

/** Records every sql`` call so tests can assert query shape if needed. */
const sqlCalls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
let sqlImpl: (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<{ rows: unknown[]; rowCount: number }> = async () => ({
  rows: [],
  rowCount: 0,
});

vi.mock('@vercel/postgres', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ strings: [...strings], values });
    return sqlImpl(strings, ...values);
  },
}));

// Imports must come AFTER the mocks above so the route modules pick
// up the mocked cookies() + sql.
import * as historyRoute from '@/app/api/history/route';
import * as historyByIdRoute from '@/app/api/history/[id]/route';
import * as historyClearRoute from '@/app/api/history/clear/route';

const VALID_WS = 'ws-test-1';
const VALID_UID = 'uid-test-1';

async function setSessionCookie(): Promise<void> {
  const secret = new TextEncoder().encode(process.env.AUTH_SECRET!);
  const token = await new SignJWT({ uid: VALID_UID, sysrole: 'user', ws: VALID_WS })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
  cookieStore.set(SESSION_COOKIE_NAME, token);
}

function clearSessionCookie(): void {
  cookieStore.delete(SESSION_COOKIE_NAME);
}

beforeEach(() => {
  sqlCalls.length = 0;
  sqlImpl = async () => ({ rows: [], rowCount: 0 });
});

afterEach(() => {
  clearSessionCookie();
});

// ── 1. Auth gates ──────────────────────────────────────────────────

describe('history routes — anonymous requests must 401', () => {
  it('GET /api/history returns 401 without a session', async () => {
    const req = new NextRequest('http://localhost/api/history?kind=script');
    const res = await historyRoute.GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('POST /api/history returns 401 without a session', async () => {
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'script', payload: { x: 1 } }),
    });
    const res = await historyRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('PATCH /api/history/[id] returns 401 without a session', async () => {
    const req = new NextRequest('http://localhost/api/history/abc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: {} }),
    });
    const res = await historyByIdRoute.PATCH(req, {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/history/[id] returns 401 without a session', async () => {
    const req = new NextRequest('http://localhost/api/history/abc', { method: 'DELETE' });
    const res = await historyByIdRoute.DELETE(req, {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/history/clear returns 401 without a session', async () => {
    const req = new NextRequest('http://localhost/api/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'script' }),
    });
    const res = await historyClearRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });
});

// ── 2. Validation (with a valid session) ───────────────────────────

describe('history routes — input validation (authed)', () => {
  beforeEach(async () => {
    await setSessionCookie();
  });

  it('GET /api/history rejects a missing kind with 400', async () => {
    const req = new NextRequest('http://localhost/api/history');
    const res = await historyRoute.GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/kind is required/i);
  });

  it('GET /api/history rejects an unknown kind with 400', async () => {
    const req = new NextRequest('http://localhost/api/history?kind=nope');
    const res = await historyRoute.GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('POST /api/history rejects non-JSON body with 400', async () => {
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await historyRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('POST /api/history rejects a missing kind with 400', async () => {
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { x: 1 } }),
    });
    const res = await historyRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it.each([
    ['null payload', { kind: 'script', payload: null }],
    ['array payload', { kind: 'script', payload: [1, 2, 3] }],
    ['string payload', { kind: 'script', payload: 'oops' }],
    ['number payload', { kind: 'script', payload: 42 }],
    ['missing payload', { kind: 'script' }],
  ] as const)('POST /api/history rejects %s with 400', async (_label, body) => {
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await historyRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('POST /api/history rejects an empty clientId with 400', async () => {
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'script', payload: { x: 1 }, clientId: '' }),
    });
    const res = await historyRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('POST /api/history rejects a >200 char clientId with 400', async () => {
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'script', payload: { x: 1 }, clientId: 'x'.repeat(201) }),
    });
    const res = await historyRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('POST /api/history rejects a >MAX_PAYLOAD_BYTES payload with 413', async () => {
    // 300 KB string payload — exceeds the 256 KB cap in user-history.ts.
    const huge = { script: 'a'.repeat(300 * 1024) };
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'script', payload: huge }),
    });
    const res = await historyRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(413);
  });

  it('POST /api/history accepts a valid payload and scopes the insert', async () => {
    sqlImpl = async () => ({
      rows: [
        {
          id: 'uuid-1',
          kind: 'script',
          payload: { topic: 'x' },
          client_id: null,
          created_at: '2026-05-07T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    });
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'script', payload: { topic: 'x' } }),
    });
    const res = await historyRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { id: string } };
    expect(body.item.id).toBe('uuid-1');

    // INSERT must include the session's workspace_id + collaborator_id —
    // never user-supplied.
    const insertCall = sqlCalls.find((c) => c.strings.join('').includes('INSERT INTO user_history'));
    expect(insertCall, 'no INSERT call recorded').toBeDefined();
    expect(insertCall!.values[0]).toBe(VALID_WS);
    expect(insertCall!.values[1]).toBe(VALID_UID);
  });

  // A real UUID — the routes 404 on non-UUID ids before any SQL
  // runs (Postgres would otherwise raise `invalid input syntax for
  // type uuid` and surface as a 500).
  const VALID_UUID = '11111111-2222-4333-8444-555555555555';

  it('PATCH /api/history/[id] returns 404 for a non-UUID id (before SQL)', async () => {
    const req = new NextRequest('http://localhost/api/history/not-a-uuid', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { x: 1 } }),
    });
    const res = await historyByIdRoute.PATCH(req, {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(404);
    // Confirm no SQL ran — Postgres would have errored on the bad UUID.
    expect(sqlCalls.length).toBe(0);
  });

  it('PATCH /api/history/[id] rejects missing payload with 400', async () => {
    const req = new NextRequest(`http://localhost/api/history/${VALID_UUID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await historyByIdRoute.PATCH(req, {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/history/[id] returns 404 when no row matches the scope', async () => {
    sqlImpl = async () => ({ rows: [], rowCount: 0 });
    const req = new NextRequest(`http://localhost/api/history/${VALID_UUID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { foo: 'bar' } }),
    });
    const res = await historyByIdRoute.PATCH(req, {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(404);
    // The kind-lookup SELECT must scope by both workspace AND
    // collaborator — a leaked id from another user must NOT reach the
    // UPDATE at all. With the SELECT returning no rows, the UPDATE is
    // short-circuited.
    const selCall = sqlCalls.find((c) => c.strings.join('').includes('SELECT kind'));
    expect(selCall, 'no scoping SELECT recorded').toBeDefined();
    expect(selCall!.values).toContain(VALID_WS);
    expect(selCall!.values).toContain(VALID_UID);
    const upCall = sqlCalls.find((c) => c.strings.join('').includes('UPDATE user_history'));
    expect(upCall, 'UPDATE must NOT run when scope-SELECT returns no rows').toBeUndefined();
  });

  it('DELETE /api/history/[id] returns 404 for a non-UUID id (before SQL)', async () => {
    const req = new NextRequest('http://localhost/api/history/not-a-uuid', { method: 'DELETE' });
    const res = await historyByIdRoute.DELETE(req, {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(404);
    expect(sqlCalls.length).toBe(0);
  });

  it('DELETE /api/history/[id] returns 404 when no row matches the scope', async () => {
    sqlImpl = async () => ({ rows: [], rowCount: 0 });
    const req = new NextRequest(`http://localhost/api/history/${VALID_UUID}`, { method: 'DELETE' });
    const res = await historyByIdRoute.DELETE(req, {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(404);
    // The DELETE must scope by both workspace AND collaborator —
    // a leaked id from another user must NOT delete a row.
    const delCall = sqlCalls.find((c) => c.strings.join('').includes('DELETE FROM user_history'));
    expect(delCall, 'no DELETE call recorded').toBeDefined();
    expect(delCall!.values).toContain(VALID_WS);
    expect(delCall!.values).toContain(VALID_UID);
  });

  it('PATCH /api/history/[id] rejects a >MAX_PAYLOAD_BYTES_BY_KIND[kind] payload with 413', async () => {
    // The PATCH path SELECTs the existing row's kind first (so the
    // per-kind cap can be applied); mock that lookup to a 'script'
    // row, then the 300 KB payload trips the 256 KB script cap.
    sqlImpl = async (strings) => {
      const sqlText = strings.join('');
      if (sqlText.includes('SELECT kind')) {
        return { rows: [{ kind: 'script' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const huge = { script: 'a'.repeat(300 * 1024) };
    const req = new NextRequest(`http://localhost/api/history/${VALID_UUID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: huge }),
    });
    const res = await historyByIdRoute.PATCH(req, {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(413);
  });

  it('PATCH /api/history/[id] accepts a >256KB production_doc payload', async () => {
    // production_doc gets a 2 MB cap so the timeline editor can save
    // realistic 200+ shot docs (~300–500 KB). This is the regression
    // test for the original "Save → payload too large: 312253 > 262144"
    // bug.
    sqlImpl = async (strings) => {
      const sqlText = strings.join('');
      if (sqlText.includes('SELECT kind')) {
        return { rows: [{ kind: 'production_doc' }], rowCount: 1 };
      }
      // UPDATE returns rowCount=1 → 200.
      return { rows: [], rowCount: 1 };
    };
    // 500 KB payload — comfortably over the lighter kinds' 256 KB cap
    // but well under production_doc's 2 MB cap.
    const big = { doc: { rows: 'x'.repeat(500 * 1024) } };
    const req = new NextRequest(`http://localhost/api/history/${VALID_UUID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: big }),
    });
    const res = await historyByIdRoute.PATCH(req, {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(200);
  });

  it('PATCH /api/history/[id] rejects a >2MB production_doc payload with 413', async () => {
    sqlImpl = async (strings) => {
      const sqlText = strings.join('');
      if (sqlText.includes('SELECT kind')) {
        return { rows: [{ kind: 'production_doc' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    // 3 MB payload — over production_doc's 2 MB cap.
    const huge = { doc: { rows: 'x'.repeat(3 * 1024 * 1024) } };
    const req = new NextRequest(`http://localhost/api/history/${VALID_UUID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: huge }),
    });
    const res = await historyByIdRoute.PATCH(req, {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(413);
  });

  it('POST /api/history/clear rejects an unknown kind with 400', async () => {
    const req = new NextRequest('http://localhost/api/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'nope' }),
    });
    const res = await historyClearRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('POST /api/history dedupes via ON CONFLICT when clientId is reused', async () => {
    // First call: ON CONFLICT DO NOTHING returns zero rows (the
    // partial unique index collided), so the route falls through to
    // the SELECT that fetches the existing winning row.
    let calls = 0;
    sqlImpl = async () => {
      calls += 1;
      if (calls === 1) {
        // INSERT … ON CONFLICT DO NOTHING — returns no rows on conflict.
        return { rows: [], rowCount: 0 };
      }
      // Follow-up SELECT — returns the pre-existing row.
      return {
        rows: [
          {
            id: 'existing-uuid',
            kind: 'script',
            payload: { topic: 'first' },
            client_id: 'legacy-id-1',
            created_at: '2026-05-01T00:00:00.000Z',
          },
        ],
        rowCount: 1,
      };
    };
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'script',
        payload: { topic: 'duplicate-attempt' },
        clientId: 'legacy-id-1',
      }),
    });
    const res = await historyRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { id: string } };
    expect(body.item.id).toBe('existing-uuid');
    // Two queries were issued (INSERT, then dedupe SELECT). No trim.
    expect(calls).toBe(2);
    const followupSelect = sqlCalls.find((c) => c.strings.join('').includes('SELECT id, kind, payload, client_id, created_at'));
    expect(followupSelect, 'no follow-up SELECT recorded').toBeDefined();
    // The follow-up SELECT must scope by both workspace AND
    // collaborator AND clientId — same as the partial unique index.
    expect(followupSelect!.values).toContain(VALID_WS);
    expect(followupSelect!.values).toContain(VALID_UID);
    expect(followupSelect!.values).toContain('legacy-id-1');
  });

  it('POST /api/history scopes the trim DELETE by (workspace, collaborator, kind)', async () => {
    // Successful insert → trim runs.
    sqlImpl = async () => ({
      rows: [
        {
          id: 'new-uuid',
          kind: 'script',
          payload: {},
          client_id: null,
          created_at: '2026-05-07T00:00:00.000Z',
        },
      ],
      rowCount: 1,
    });
    const req = new NextRequest('http://localhost/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'script', payload: { topic: 'x' } }),
    });
    await historyRoute.POST(req, { params: Promise.resolve({}) });
    // The trim subquery must be scoped (no cross-tenant leakage).
    const trimCall = sqlCalls.find((c) => {
      const text = c.strings.join('');
      return text.includes('DELETE FROM user_history') && text.includes('OFFSET');
    });
    expect(trimCall, 'no trim call recorded').toBeDefined();
    expect(trimCall!.values).toContain(VALID_WS);
    expect(trimCall!.values).toContain(VALID_UID);
  });

  it('POST /api/history/clear scopes the DELETE by (workspace, collaborator, kind)', async () => {
    sqlImpl = async () => ({ rows: [], rowCount: 7 });
    const req = new NextRequest('http://localhost/api/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ideas' }),
    });
    const res = await historyClearRoute.POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: number };
    expect(body.removed).toBe(7);
    const delCall = sqlCalls.find((c) => c.strings.join('').includes('DELETE FROM user_history'));
    expect(delCall, 'no DELETE call recorded').toBeDefined();
    expect(delCall!.values).toEqual([VALID_WS, VALID_UID, 'ideas']);
  });
});
