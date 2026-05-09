/**
 * Unit tests for `actAsCollaborator`.
 *
 * The helper is small and depends only on `@vercel/postgres`, so we mock
 * the sql tag directly and assert against the recorded calls. Two slices:
 *
 *   1. Tenancy gate — the target collaborator must have at least one
 *      assignment or share-link in the actor's workspace; otherwise the
 *      helper throws ActAsTenancyError before invoking `fn` and writes
 *      no audit row.
 *   2. Audit lifecycle — both success and failure of `fn` write exactly
 *      one row to team_hub_audit_log with the expected `result`. A DB
 *      failure on the audit write itself is swallowed (logged) so the
 *      original outcome of `fn` propagates unchanged.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mock plumbing ──────────────────────────────────────────────────

interface RecordedCall {
  text: string;
  values: unknown[];
}

const calls: RecordedCall[] = [];

/** Per-test response queue. Each `sql\`\`` invocation pulls the next
 *  response. Tests push responses in the order they expect queries to
 *  fire (gate query first, then audit insert). */
type Response =
  | { kind: 'rows'; rows: unknown[] }
  | { kind: 'throw'; error: Error };

const responseQueue: Response[] = [];

vi.mock('@vercel/postgres', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''),
      '',
    );
    calls.push({ text, values });
    const next = responseQueue.shift();
    if (!next) {
      // Default to "no rows" so a missed-queue test fails loudly on the
      // gate (returning false → ActAsTenancyError) instead of silently
      // proceeding with stale state from a prior test.
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (next.kind === 'throw') return Promise.reject(next.error);
    return Promise.resolve({ rows: next.rows, rowCount: next.rows.length });
  },
}));

// Logger is exercised by the "audit insert failure is swallowed" test —
// stub it so the test doesn't pollute stderr.
vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Imports must come AFTER the mocks so the helper picks them up.
import { actAsCollaborator, ActAsTenancyError, type ActAsContext } from '@/lib/team-act-as';
import { logger } from '@/lib/logger';

// ── Test fixtures ──────────────────────────────────────────────────

const baseCtx: ActAsContext = {
  actorUserId: 'actor-uuid',
  workspaceId: 'ws-uuid',
  targetCollaboratorId: 'target-uuid',
  actionType: 'post_comment',
  surface: 'narration_take_comment',
  targetId: 'take-uuid',
};

beforeEach(() => {
  calls.length = 0;
  responseQueue.length = 0;
  vi.clearAllMocks();
});

// ── Tenancy gate ───────────────────────────────────────────────────

describe('actAsCollaborator — tenancy gate', () => {
  it('throws ActAsTenancyError when the target has no scoped row in the workspace', async () => {
    // Gate query returns no rows.
    responseQueue.push({ kind: 'rows', rows: [] });

    const fn = vi.fn();
    await expect(actAsCollaborator(baseCtx, fn)).rejects.toBeInstanceOf(ActAsTenancyError);

    // fn must NOT have been invoked.
    expect(fn).not.toHaveBeenCalled();

    // Only the gate query fired — no audit insert when the gate refuses.
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/UNION ALL/);
    expect(calls[0].text).not.toMatch(/INSERT INTO team_hub_audit_log/);
  });

  it('proceeds and runs fn when the target has at least one scoped row', async () => {
    // Gate query returns one row → in workspace.
    responseQueue.push({ kind: 'rows', rows: [{ exists: 1 }] });
    // Audit insert succeeds.
    responseQueue.push({ kind: 'rows', rows: [] });

    const fn = vi.fn().mockResolvedValue('ok');
    const out = await actAsCollaborator(baseCtx, fn);

    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
    // Two queries: gate + audit insert.
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toMatch(/INSERT INTO team_hub_audit_log/);
  });

  it('passes the right (target, workspace) parameters to the gate query', async () => {
    responseQueue.push({ kind: 'rows', rows: [{ exists: 1 }] });
    responseQueue.push({ kind: 'rows', rows: [] });

    await actAsCollaborator(baseCtx, async () => 1);

    const gate = calls[0];
    // Tagged-template values include both the target id (for each branch)
    // and the workspace id (for each branch). Look for both.
    expect(gate.values).toContain(baseCtx.targetCollaboratorId);
    expect(gate.values).toContain(baseCtx.workspaceId);
  });
});

// ── Audit lifecycle ─────────────────────────────────────────────────

describe('actAsCollaborator — audit lifecycle', () => {
  it('writes a success audit row when fn resolves', async () => {
    responseQueue.push({ kind: 'rows', rows: [{ exists: 1 }] });
    responseQueue.push({ kind: 'rows', rows: [] });

    await actAsCollaborator(baseCtx, async () => 'done');

    const insert = calls.find((c) => c.text.includes('INSERT INTO team_hub_audit_log'));
    expect(insert).toBeDefined();
    // Values are bound positionally in the order:
    //   workspace_id, actor_user_id, target_collaborator_id,
    //   action_type, surface, target_id, result, error_message
    expect(insert!.values).toEqual([
      baseCtx.workspaceId,
      baseCtx.actorUserId,
      baseCtx.targetCollaboratorId,
      baseCtx.actionType,
      baseCtx.surface,
      baseCtx.targetId,
      'success',
      null,
    ]);
  });

  it('writes a failure audit row carrying the error message when fn throws an Error', async () => {
    responseQueue.push({ kind: 'rows', rows: [{ exists: 1 }] });
    responseQueue.push({ kind: 'rows', rows: [] });

    const boom = new Error('underlying write failed');
    await expect(
      actAsCollaborator(baseCtx, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const insert = calls.find((c) => c.text.includes('INSERT INTO team_hub_audit_log'));
    expect(insert).toBeDefined();
    // Last two values: result + error_message.
    expect(insert!.values.at(-2)).toBe('failure');
    expect(insert!.values.at(-1)).toBe('underlying write failed');
  });

  it('coerces non-Error throws to a string for the audit error_message', async () => {
    responseQueue.push({ kind: 'rows', rows: [{ exists: 1 }] });
    responseQueue.push({ kind: 'rows', rows: [] });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      actAsCollaborator(baseCtx, async () => {
        throw 'string thrown';
      }),
    ).rejects.toBe('string thrown');

    const insert = calls.find((c) => c.text.includes('INSERT INTO team_hub_audit_log'));
    expect(insert!.values.at(-1)).toBe('string thrown');
  });

  it('omits target_id from the audit row when not provided', async () => {
    responseQueue.push({ kind: 'rows', rows: [{ exists: 1 }] });
    responseQueue.push({ kind: 'rows', rows: [] });

    const ctxNoTarget: ActAsContext = { ...baseCtx, targetId: undefined };
    await actAsCollaborator(ctxNoTarget, async () => 1);

    const insert = calls.find((c) => c.text.includes('INSERT INTO team_hub_audit_log'));
    // target_id is the 6th positional value.
    expect(insert!.values[5]).toBeNull();
  });

  it('does not mask a failed action when the audit insert itself throws', async () => {
    responseQueue.push({ kind: 'rows', rows: [{ exists: 1 }] }); // gate ok
    responseQueue.push({ kind: 'throw', error: new Error('audit table missing') });

    const boom = new Error('underlying write failed');
    await expect(
      actAsCollaborator(baseCtx, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom); // original error wins, not the audit error

    expect(logger.error).toHaveBeenCalled();
  });

  it('does not mask a successful action when the audit insert itself throws', async () => {
    responseQueue.push({ kind: 'rows', rows: [{ exists: 1 }] }); // gate ok
    responseQueue.push({ kind: 'throw', error: new Error('audit table missing') });

    const out = await actAsCollaborator(baseCtx, async () => 'still-ok');
    expect(out).toBe('still-ok');
    expect(logger.error).toHaveBeenCalled();
  });
});
