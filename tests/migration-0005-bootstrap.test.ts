import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compare } from 'bcryptjs';
import migration0005 from '@/lib/migrations/0005_bootstrap_admin_and_default_workspace';
import type { MigrationClient } from '@/lib/migrations/types';

interface CapturedQuery {
  text: string;
  params?: unknown[];
}

/**
 * A mock client that captures every query and returns scripted results based
 * on a "table" of (queryRegex → response) handlers. Sufficient to assert the
 * migration's SQL flow without a real Postgres.
 */
function makeRecordingClient(handlers: Array<[RegExp, () => Promise<{ rows: unknown[]; rowCount: number | null }>]>) {
  const calls: CapturedQuery[] = [];
  const query: MigrationClient['query'] = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    for (const [pattern, handler] of handlers) {
      if (pattern.test(text)) return handler();
    }
    return { rows: [], rowCount: null };
  }) as MigrationClient['query'];
  return { client: { query } as MigrationClient, calls };
}

const ORIGINAL_ENV = { ...process.env };

describe('migration 0005 — bootstrap admin and default workspace', () => {
  beforeEach(() => {
    process.env.ADMIN_EMAIL = 'owner@example.com';
    process.env.ADMIN_PASSWORD = 'a-strong-password-1234';
  });

  afterEach(() => {
    // Restore env so a stray ADMIN_* var from one test doesn't leak.
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    vi.restoreAllMocks();
  });

  it('is a no-op when an admin already exists (idempotency safety net)', async () => {
    const { client, calls } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [{ id: 'existing-admin-uuid' }],
        rowCount: 1,
      })],
    ]);

    await migration0005.up(client);

    // Only the existence check should have run — no INSERTs.
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/SELECT id FROM collaborators WHERE system_role/);
    expect(calls.find((c) => /^\s*INSERT/i.test(c.text))).toBeUndefined();
  });

  it('throws a clear error when ADMIN_EMAIL is missing', async () => {
    delete process.env.ADMIN_EMAIL;
    const { client } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [],
        rowCount: 0,
      })],
    ]);
    await expect(migration0005.up(client)).rejects.toThrow(/ADMIN_EMAIL.*ADMIN_PASSWORD/);
  });

  it('throws a clear error when ADMIN_PASSWORD is missing', async () => {
    delete process.env.ADMIN_PASSWORD;
    const { client } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [],
        rowCount: 0,
      })],
    ]);
    await expect(migration0005.up(client)).rejects.toThrow(/ADMIN_EMAIL.*ADMIN_PASSWORD/);
  });

  it('rejects an obviously malformed ADMIN_EMAIL', async () => {
    process.env.ADMIN_EMAIL = 'not-an-email';
    const { client } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [],
        rowCount: 0,
      })],
    ]);
    await expect(migration0005.up(client)).rejects.toThrow(/not a valid email/i);
  });

  it('rejects a too-short ADMIN_PASSWORD', async () => {
    process.env.ADMIN_PASSWORD = 'short';
    const { client } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [],
        rowCount: 0,
      })],
    ]);
    await expect(migration0005.up(client)).rejects.toThrow(/at least 12 characters/i);
  });

  it('inserts admin, workspace, and owner membership in the correct order', async () => {
    const { client, calls } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [],
        rowCount: 0,
      })],
      [/INSERT INTO collaborators[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'new-admin-uuid' }],
        rowCount: 1,
      })],
      [/INSERT INTO workspaces[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'new-workspace-uuid' }],
        rowCount: 1,
      })],
    ]);

    await migration0005.up(client);

    const insertOrder = calls
      .map((c) => c.text)
      .filter((t) => /^\s*INSERT/i.test(t))
      .map((t) =>
        /INTO collaborators/i.test(t)
          ? 'admin'
          : /INTO workspaces\b/i.test(t)
            ? 'workspace'
            : /INTO workspace_members/i.test(t)
              ? 'membership'
              : 'other',
      );

    expect(insertOrder).toEqual(['admin', 'workspace', 'membership']);
  });

  it('hashes the password with bcrypt cost ≥ 10 before inserting', async () => {
    let capturedHash = '';
    const { client } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [],
        rowCount: 0,
      })],
      [/INSERT INTO collaborators[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'admin-uuid' }],
        rowCount: 1,
      })],
      [/INSERT INTO workspaces[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'workspace-uuid' }],
        rowCount: 1,
      })],
    ]);

    // Wrap query() to capture the password_hash param on the admin INSERT.
    const original = client.query.bind(client);
    client.query = (async (text: string, params?: unknown[]) => {
      const result = await original(text, params);
      if (/INSERT INTO collaborators[\s\S]*system_role/.test(text) && params && typeof params[2] === 'string') {
        capturedHash = params[2];
      }
      return result;
    }) as MigrationClient['query'];

    await migration0005.up(client);

    // bcrypt-format hash starts with $2a$ / $2b$ / $2y$ then a 2-digit cost
    expect(capturedHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    const cost = parseInt(capturedHash.split('$')[2], 10);
    expect(cost).toBeGreaterThanOrEqual(10);

    // Verify the hash actually decrypts the original password
    expect(await compare('a-strong-password-1234', capturedHash)).toBe(true);
    expect(await compare('wrong-password', capturedHash)).toBe(false);
  });

  it('lowercases and trims the email before insertion', async () => {
    process.env.ADMIN_EMAIL = '  Owner@EXAMPLE.com  ';

    let capturedEmail: unknown = null;
    const { client } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [],
        rowCount: 0,
      })],
      [/INSERT INTO collaborators[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'admin-uuid' }],
        rowCount: 1,
      })],
      [/INSERT INTO workspaces[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'workspace-uuid' }],
        rowCount: 1,
      })],
    ]);

    const original = client.query.bind(client);
    client.query = (async (text: string, params?: unknown[]) => {
      if (/INSERT INTO collaborators[\s\S]*system_role/.test(text) && params) {
        capturedEmail = params[1];
      }
      return original(text, params);
    }) as MigrationClient['query'];

    await migration0005.up(client);

    expect(capturedEmail).toBe('owner@example.com');
  });

  it('passes the new admin id to the workspace insert and the membership insert', async () => {
    const { client, calls } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [],
        rowCount: 0,
      })],
      [/INSERT INTO collaborators[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'admin-uuid-7' }],
        rowCount: 1,
      })],
      [/INSERT INTO workspaces[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'workspace-uuid-9' }],
        rowCount: 1,
      })],
    ]);

    await migration0005.up(client);

    const workspaceInsert = calls.find((c) => /INSERT INTO workspaces\b/i.test(c.text));
    expect(workspaceInsert?.params).toEqual(['Default', 'admin-uuid-7']);

    const membershipInsert = calls.find((c) => /INSERT INTO workspace_members/i.test(c.text));
    expect(membershipInsert?.params).toEqual(['workspace-uuid-9', 'admin-uuid-7']);
  });

  it('does not throw when the legacy token columns are absent (best-effort backfill)', async () => {
    const { client } = makeRecordingClient([
      [/SELECT id FROM collaborators WHERE system_role = 'admin'/, async () => ({
        rows: [],
        rowCount: 0,
      })],
      [/INSERT INTO collaborators[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'admin-uuid' }],
        rowCount: 1,
      })],
      [/UPDATE collaborators\s+SET unsubscribe_token/, async () => {
        throw new Error('column "unsubscribe_token" does not exist');
      }],
      [/INSERT INTO workspaces[\s\S]*RETURNING id/, async () => ({
        rows: [{ id: 'workspace-uuid' }],
        rowCount: 1,
      })],
    ]);

    await expect(migration0005.up(client)).resolves.toBeUndefined();
  });
});
