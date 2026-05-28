/**
 * Migration 0100 (provider_generations) — DDL shape test.
 *
 * Verifies that the migration's `up` issues the CREATE TABLE statement
 * with the expected columns, constraints, and index definitions.
 * Doesn't run against a real DB — uses a mock MigrationClient that
 * captures every query.
 *
 * See `_plans/2026-05-29-persistence-rebuild.md`.
 */
import { describe, expect, it } from 'vitest';
import migration from '@/lib/migrations/0100_create_provider_generations';
import type { MigrationClient } from '@/lib/migrations/types';

interface MockCall {
  text: string;
}

function makeClient(): { client: MigrationClient; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const client: MigrationClient = {
    query: async (text: string) => {
      calls.push({ text });
      return { rows: [], rowCount: null };
    },
  };
  return { client, calls };
}

describe('migration 0100 — provider_generations', () => {
  it('declares the expected id and description', () => {
    expect(migration.id).toBe('0100_create_provider_generations');
    expect(migration.description).toMatch(/provider/i);
  });

  it('CREATE TABLE includes every required column', async () => {
    const { client, calls } = makeClient();
    await migration.up(client);

    const createTable = calls.find((c) => /CREATE TABLE IF NOT EXISTS provider_generations/.test(c.text));
    expect(createTable, 'CREATE TABLE missing').toBeDefined();
    const ddl = createTable!.text;

    // Identifiers + tenancy.
    expect(ddl).toContain('id                  UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(ddl).toContain('client_intent_id    UUID');
    expect(ddl).toContain('user_id             UUID REFERENCES collaborators(id) ON DELETE SET NULL');
    expect(ddl).toContain('workspace_id        UUID REFERENCES workspaces(id) ON DELETE SET NULL');

    // Where the asset is supposed to land. Nullable per the helper contract.
    expect(ddl).toContain('project_id          UUID');
    expect(ddl).toContain('row_index           INTEGER');
    expect(ddl).toContain('slot                TEXT');

    // Provider + lifecycle columns.
    expect(ddl).toContain('route               TEXT NOT NULL');
    expect(ddl).toContain('provider            TEXT NOT NULL');
    expect(ddl).toContain('provider_model      TEXT');
    expect(ddl).toContain('provider_request_id TEXT');
    expect(ddl).toContain('response_url        TEXT');
    expect(ddl).toContain('cost_usd            NUMERIC(10, 6)');
    expect(ddl).toContain('duration_ms         INTEGER');
    expect(ddl).toContain("status              TEXT NOT NULL DEFAULT 'pending'");
    expect(ddl).toContain('failure_reason      TEXT');
    expect(ddl).toContain('attached_at         TIMESTAMPTZ');
  });

  it('CHECK constraint enumerates every status value the helper writes', async () => {
    const { client, calls } = makeClient();
    await migration.up(client);
    const ddl = calls.find((c) => c.text.includes('CREATE TABLE'))!.text;

    expect(ddl).toContain('provider_generations_status_chk');
    for (const status of [
      'pending', 'delivered', 'attached',
      'failed', 'refund_pending', 'recovered', 'refunded',
    ]) {
      expect(ddl).toContain(`'${status}'`);
    }
  });

  it('CHECK constraint enumerates allowed slot values', async () => {
    const { client, calls } = makeClient();
    await migration.up(client);
    const ddl = calls.find((c) => c.text.includes('CREATE TABLE'))!.text;

    expect(ddl).toContain('provider_generations_slot_chk');
    for (const slot of ['image', 'overlay', 'clip', 'thumbnail']) {
      expect(ddl).toContain(`'${slot}'`);
    }
  });

  it('creates the four indexes the reconciliation cron / per-user lookups depend on', async () => {
    const { client, calls } = makeClient();
    await migration.up(client);
    const allText = calls.map((c) => c.text).join('\n');

    // Reconciliation hot path — partial on delivered/refund_pending.
    expect(allText).toContain('idx_provider_generations_reconcile');
    expect(allText).toMatch(/status IN \('delivered', 'refund_pending'\)/);

    // Server-side idempotency for Phase 1.2 retries.
    expect(allText).toContain('idx_provider_generations_client_intent');
    expect(allText).toMatch(/UNIQUE INDEX[^;]*client_intent_id/);

    // Per-user audit query support.
    expect(allText).toContain('idx_provider_generations_user_created');

    // Reverse-lookup from a provider's webhook/invoice.
    expect(allText).toContain('idx_provider_generations_provider_request');
    expect(allText).toMatch(/provider, provider_request_id/);
  });

  it('down drops every index and the table in reverse order', async () => {
    const { client, calls } = makeClient();
    await migration.down!(client);
    const order = calls.map((c) => c.text.trim());

    // Indexes drop before the table to be defensive against pg
    // versions that DROP INDEX implicitly on DROP TABLE (so the
    // explicit DROP INDEX is a no-op + the test still asserts the
    // execution order).
    const tableIdx = order.findIndex((t) => t.includes('DROP TABLE'));
    const idxIdx = order.findIndex((t) => t.includes('DROP INDEX'));
    expect(idxIdx).toBeLessThan(tableIdx);
    expect(order[tableIdx]).toContain('DROP TABLE IF EXISTS provider_generations');
  });
});
