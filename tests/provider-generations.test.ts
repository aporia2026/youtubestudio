/**
 * Tests for `src/lib/provider-generations.ts` — the server-side ledger
 * for paid AI-provider generations introduced by Phase 1.0 of the
 * 2026-05-29 persistence-rebuild plan. SQL is mocked at the
 * `@vercel/postgres` boundary so each helper's query shape and parameter
 * binding can be asserted without a real DB.
 *
 * See `_plans/2026-05-29-persistence-rebuild.md`.
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

// Module under test must import AFTER the mock so it picks up the
// mocked `sql` template literal.
import { recordIntent, markDelivered, markFailed } from '@/lib/provider-generations';

beforeEach(() => {
  sqlCalls.length = 0;
  sqlImpl = async () => ({ rows: [], rowCount: 0 });
});

const USER_ID = 'c0ffee00-0000-4000-8000-000000000001';
const WORKSPACE_ID = 'c0ffee00-0000-4000-8000-000000000002';
const PROJECT_ID = 'c0ffee00-0000-4000-8000-000000000003';
const ROW_ID = 'c0ffee00-0000-4000-8000-000000000099';
const INTENT_ID = 'c0ffee00-0000-4000-8000-000000000abc';

describe('recordIntent', () => {
  it('inserts a pending row WITHOUT ON CONFLICT when no clientIntentId is passed (Phase 1.0)', async () => {
    sqlImpl = async () => ({ rows: [{ id: ROW_ID }], rowCount: 1 });

    const result = await recordIntent({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      route: '/api/generate/production-doc/image',
      provider: 'kie',
      providerModel: 'nano-banana-2',
    });

    expect(result.id).toBe(ROW_ID);
    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0]!;
    // Phase 1.0 path: no ON CONFLICT clause. Phase 1.2 (mutate())
    // will populate clientIntentId and switch to the upsert branch.
    expect(call.text).not.toContain('ON CONFLICT');
    expect(call.text).toContain('INSERT INTO provider_generations');
    expect(call.text).toContain("'pending'");
    // Param shape (Phase 1.0, no clientIntentId): userId, workspaceId,
    // projectId (null), rowIndex (null), slot (null), route, provider,
    // providerModel.
    expect(call.values).toEqual([
      USER_ID,
      WORKSPACE_ID,
      null,
      null,
      null,
      '/api/generate/production-doc/image',
      'kie',
      'nano-banana-2',
    ]);
  });

  it('uses ON CONFLICT to dedupe on clientIntentId (Phase 1.2 path)', async () => {
    sqlImpl = async () => ({ rows: [{ id: ROW_ID }], rowCount: 1 });

    await recordIntent({
      clientIntentId: INTENT_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      route: '/api/generate/production-doc/image',
      provider: 'atlas',
      providerModel: 'gpt-image-2-low',
    });

    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0]!;
    expect(call.text).toContain('ON CONFLICT (client_intent_id)');
    expect(call.text).toContain('WHERE client_intent_id IS NOT NULL');
    expect(call.text).toContain('DO UPDATE SET');
    // First param is the intent id.
    expect(call.values[0]).toBe(INTENT_ID);
  });

  it('passes through optional project_id, row_index, slot when supplied', async () => {
    sqlImpl = async () => ({ rows: [{ id: ROW_ID }], rowCount: 1 });

    await recordIntent({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      rowIndex: 7,
      slot: 'image',
      route: '/api/generate/production-doc/image',
      provider: 'kie',
    });

    const values = sqlCalls[0]!.values;
    // Position: userId, workspaceId, projectId, rowIndex, slot, route, provider, providerModel
    expect(values[2]).toBe(PROJECT_ID);
    expect(values[3]).toBe(7);
    expect(values[4]).toBe('image');
  });

  it('throws when the INSERT fails — caller MUST NOT then call the provider', async () => {
    sqlImpl = async () => {
      throw new Error('postgres unavailable');
    };

    await expect(
      recordIntent({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        route: '/api/generate/production-doc/image',
        provider: 'kie',
      }),
    ).rejects.toThrow(/postgres unavailable/);
  });

  it('throws when INSERT returns no row — defends against driver quirks', async () => {
    sqlImpl = async () => ({ rows: [], rowCount: 0 });

    await expect(
      recordIntent({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        route: '/api/generate/production-doc/image',
        provider: 'kie',
      }),
    ).rejects.toThrow(/no id/);
  });
});

describe('markDelivered', () => {
  it("UPDATEs the row to 'delivered' with provider_request_id, response_url, cost_usd, duration_ms", async () => {
    await markDelivered({
      id: ROW_ID,
      providerRequestId: 'kie-task-abc123',
      responseUrl: 'https://r2.example.com/img.png',
      costUsd: 0.04,
      durationMs: 8400,
    });

    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0]!;
    expect(call.text).toContain("UPDATE provider_generations");
    expect(call.text).toContain("status = 'delivered'");
    expect(call.text).toContain("status = 'pending'");
    expect(call.values).toEqual([
      'kie-task-abc123',
      'https://r2.example.com/img.png',
      0.04,
      8400,
      ROW_ID,
    ]);
  });

  it('passes nulls through cleanly when optional fields are omitted', async () => {
    await markDelivered({
      id: ROW_ID,
      responseUrl: 'https://r2.example.com/img.png',
    });

    expect(sqlCalls[0]!.values).toEqual([
      null,
      'https://r2.example.com/img.png',
      null,
      null,
      ROW_ID,
    ]);
  });

  it('swallows DB errors so a logging failure never undoes the provider success', async () => {
    sqlImpl = async () => {
      throw new Error('connection reset');
    };

    // Should NOT throw — fire-and-forget contract.
    await expect(
      markDelivered({
        id: ROW_ID,
        responseUrl: 'https://r2.example.com/img.png',
      }),
    ).resolves.toBeUndefined();
  });

  it("only updates rows still in 'pending' status (idempotent re-delivery)", async () => {
    await markDelivered({
      id: ROW_ID,
      responseUrl: 'https://r2.example.com/img.png',
    });
    // Status-predicate keeps a stale retry from clobbering an
    // already-attached/recovered/refunded row.
    expect(sqlCalls[0]!.text).toContain("status = 'pending'");
  });
});

describe('markFailed', () => {
  it("UPDATEs the row to 'failed' with the truncated reason", async () => {
    await markFailed({
      id: ROW_ID,
      failureReason: 'Atlas returned 502: upstream unavailable',
      providerRequestId: 'atlas-req-xyz',
      durationMs: 1200,
    });

    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0]!;
    expect(call.text).toContain("status = 'failed'");
    expect(call.text).toContain("status = 'pending'");
    // Values order: providerRequestId, failureReason, durationMs, id
    expect(call.values).toEqual([
      'atlas-req-xyz',
      'Atlas returned 502: upstream unavailable',
      1200,
      ROW_ID,
    ]);
  });

  it('truncates failure_reason to 400 chars to fit comfortably in TEXT', async () => {
    const longReason = 'x'.repeat(1000);
    await markFailed({ id: ROW_ID, failureReason: longReason });
    expect((sqlCalls[0]!.values[1] as string).length).toBe(400);
  });

  it("uses COALESCE so a null providerRequestId doesn't wipe an earlier value", async () => {
    await markFailed({ id: ROW_ID, failureReason: 'timeout' });
    expect(sqlCalls[0]!.text).toContain('COALESCE');
  });

  it('swallows DB errors — same contract as markDelivered', async () => {
    sqlImpl = async () => {
      throw new Error('deadlock detected');
    };
    await expect(
      markFailed({ id: ROW_ID, failureReason: 'whatever' }),
    ).resolves.toBeUndefined();
  });
});
