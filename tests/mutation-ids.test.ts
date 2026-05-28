/**
 * Tests for `src/lib/mutation-ids.ts` — the server-side dedup helper
 * pairs with the client-side mutate() chokepoint. Phase 1.2 of the
 * 2026-05-29 persistence-rebuild plan.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

interface CapturedCall {
  text: string;
  values: unknown[];
}

const sqlCalls: CapturedCall[] = [];
let sqlImpl: (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<{ rows: unknown[]; rowCount?: number }> = async () => ({
  rows: [],
  rowCount: 0,
});

vi.mock('@vercel/postgres', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    return sqlImpl(strings, ...values);
  },
}));

import { tryClaimIntent } from '@/lib/mutation-ids';

beforeEach(() => {
  sqlCalls.length = 0;
  sqlImpl = async () => ({ rows: [], rowCount: 0 });
});

const USER_ID = 'c0ffee00-0000-4000-8000-000000000001';
const VALID_INTENT_ID = 'c0ffee00-0000-4000-8000-000000000abc';

function makeReq(headers: Record<string, string>): Request {
  return new Request('http://localhost/test', { headers });
}

describe('tryClaimIntent', () => {
  it("returns 'no-intent' when X-Intent-Id header is missing", async () => {
    const req = makeReq({});
    const result = await tryClaimIntent(req, USER_ID, 'row-asset.set');
    expect(result).toBe('no-intent');
    expect(sqlCalls).toHaveLength(0);
  });

  it("returns 'no-intent' when X-Intent-Id is malformed (treated as legacy)", async () => {
    const req = makeReq({ 'x-intent-id': 'not-a-uuid' });
    const result = await tryClaimIntent(req, USER_ID, 'row-asset.set');
    expect(result).toBe('no-intent');
    expect(sqlCalls).toHaveLength(0);
  });

  it("returns 'claimed' when the INSERT writes a fresh row", async () => {
    sqlImpl = async () => ({ rows: [{ id: VALID_INTENT_ID }], rowCount: 1 });
    const req = makeReq({ 'x-intent-id': VALID_INTENT_ID });

    const result = await tryClaimIntent(req, USER_ID, 'row-asset.set');

    expect(result).toBe('claimed');
    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0]!;
    expect(call.text).toContain('INSERT INTO mutation_ids');
    expect(call.text).toContain('ON CONFLICT (id) DO NOTHING');
    expect(call.values).toEqual([VALID_INTENT_ID, 'row-asset.set', USER_ID]);
  });

  it("returns 'duplicate' when ON CONFLICT fires and the existing kind matches", async () => {
    let sqlCallCount = 0;
    sqlImpl = async () => {
      sqlCallCount++;
      if (sqlCallCount === 1) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ kind: 'row-asset.set' }], rowCount: 1 };
    };

    const req = makeReq({ 'x-intent-id': VALID_INTENT_ID });
    const result = await tryClaimIntent(req, USER_ID, 'row-asset.set');

    expect(result).toBe('duplicate');
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[1]!.text).toContain('SELECT kind FROM mutation_ids');
  });

  it("returns 'kind-mismatch' when ON CONFLICT fires and the existing kind differs", async () => {
    let sqlCallCount = 0;
    sqlImpl = async () => {
      sqlCallCount++;
      if (sqlCallCount === 1) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ kind: 'user-settings.set' }], rowCount: 1 };
    };

    const req = makeReq({ 'x-intent-id': VALID_INTENT_ID });
    const result = await tryClaimIntent(req, USER_ID, 'row-asset.set');

    expect(result).toBe('kind-mismatch');
  });

  it("fails open ('no-intent') when the DB INSERT throws — never blocks the user's action on a dedup-table outage", async () => {
    sqlImpl = async () => {
      throw new Error('postgres connection refused');
    };
    const req = makeReq({ 'x-intent-id': VALID_INTENT_ID });

    const result = await tryClaimIntent(req, USER_ID, 'row-asset.set');

    expect(result).toBe('no-intent');
  });
});
