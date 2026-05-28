/**
 * Migration 0101 (mutation_ids) — DDL shape test.
 *
 * See `_plans/2026-05-29-persistence-rebuild.md` (Phase 1.1).
 */
import { describe, expect, it } from 'vitest';
import migration from '@/lib/migrations/0101_create_mutation_ids';
import type { MigrationClient } from '@/lib/migrations/types';

interface MockCall { text: string; }
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

describe('migration 0101 — mutation_ids', () => {
  it('declares the expected id and description', () => {
    expect(migration.id).toBe('0101_create_mutation_ids');
    expect(migration.description).toMatch(/dedup|idempot/i);
  });

  it('CREATE TABLE has id as PK and user_id with ON DELETE CASCADE', async () => {
    const { client, calls } = makeClient();
    await migration.up(client);
    const ddl = calls.find((c) => /CREATE TABLE IF NOT EXISTS mutation_ids/.test(c.text))!.text;

    expect(ddl).toContain('id          UUID PRIMARY KEY');
    expect(ddl).toContain('kind        TEXT NOT NULL');
    expect(ddl).toContain('user_id     UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE');
    expect(ddl).toContain('created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  it('creates the per-user index for retention sweep + telemetry', async () => {
    const { client, calls } = makeClient();
    await migration.up(client);
    const text = calls.map((c) => c.text).join('\n');
    expect(text).toContain('idx_mutation_ids_user_created');
    expect(text).toMatch(/user_id, created_at DESC/);
  });

  it('down drops the index then the table', async () => {
    const { client, calls } = makeClient();
    await migration.down!(client);
    const order = calls.map((c) => c.text);
    const idxIdx = order.findIndex((t) => t.includes('DROP INDEX'));
    const tableIdx = order.findIndex((t) => t.includes('DROP TABLE'));
    expect(idxIdx).toBeGreaterThanOrEqual(0);
    expect(tableIdx).toBeGreaterThan(idxIdx);
  });
});
