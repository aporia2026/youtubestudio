/**
 * Migration 0102 (user_settings) — DDL shape test.
 *
 * See `_plans/2026-05-29-persistence-rebuild.md` (Phase 1.1 / 3.1).
 */
import { describe, expect, it } from 'vitest';
import migration from '@/lib/migrations/0102_create_user_settings';
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

describe('migration 0102 — user_settings', () => {
  it('declares the expected id and description', () => {
    expect(migration.id).toBe('0102_create_user_settings');
    expect(migration.description).toMatch(/per-user|cross-machine|settings/i);
  });

  it('CREATE TABLE has composite PK on (user_id, key) and JSONB value', async () => {
    const { client, calls } = makeClient();
    await migration.up(client);
    const ddl = calls.find((c) => /CREATE TABLE IF NOT EXISTS user_settings/.test(c.text))!.text;

    expect(ddl).toContain('user_id     UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE');
    expect(ddl).toContain('key         TEXT NOT NULL');
    expect(ddl).toContain('value       JSONB NOT NULL');
    expect(ddl).toContain('updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(ddl).toContain('PRIMARY KEY (user_id, key)');
  });

  it('creates the user-only index used by the load-all GET', async () => {
    const { client, calls } = makeClient();
    await migration.up(client);
    const text = calls.map((c) => c.text).join('\n');
    expect(text).toContain('idx_user_settings_user');
    expect(text).toMatch(/ON user_settings\(user_id\)/);
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
