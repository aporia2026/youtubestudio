import { describe, expect, it, vi } from 'vitest';
import { planPending, runOne } from '@/lib/migrations/index';
import type { Migration, MigrationClient } from '@/lib/migrations/types';

const m = (id: string, up: Migration['up'] = async () => {}): Migration => ({
  id,
  description: `desc for ${id}`,
  up,
});

describe('planPending', () => {
  it('returns nothing when all migrations are applied', () => {
    const declared = [m('0001_a'), m('0002_b'), m('0003_c')];
    const applied = new Set(['0001_a', '0002_b', '0003_c']);
    expect(planPending(declared, applied)).toEqual([]);
  });

  it('returns every declared migration when none have been applied', () => {
    const declared = [m('0001_a'), m('0002_b'), m('0003_c')];
    expect(planPending(declared, new Set()).map((x) => x.id)).toEqual([
      '0001_a',
      '0002_b',
      '0003_c',
    ]);
  });

  it('returns only the unapplied tail in declared order', () => {
    const declared = [m('0001_a'), m('0002_b'), m('0003_c'), m('0004_d')];
    const applied = new Set(['0001_a', '0002_b']);
    expect(planPending(declared, applied).map((x) => x.id)).toEqual(['0003_c', '0004_d']);
  });

  it('throws when an applied migration follows an unapplied one (renumbered/reordered)', () => {
    const declared = [m('0001_a'), m('0002_b'), m('0003_c')];
    // 0001 is missing from applied but 0002 is — that means 0002 was applied
    // before 0001 ever existed. Likely a renumber. Refuse to continue.
    const applied = new Set(['0002_b']);
    expect(() => planPending(declared, applied)).toThrow(/ordering violation/i);
  });

  it('returns an empty plan when nothing is declared', () => {
    expect(planPending([], new Set())).toEqual([]);
    expect(planPending([], new Set(['0001_a']))).toEqual([]);
  });
});

interface MockCall {
  text: string;
  params?: unknown[];
}

function makeMockClient(
  handlers: Record<string, () => Promise<{ rows: unknown[]; rowCount: number | null }>> = {},
) {
  const calls: MockCall[] = [];
  const query = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const handler = handlers[text.trim()];
    if (handler) return handler();
    return { rows: [], rowCount: null };
  }) as MigrationClient['query'];
  const client: MigrationClient = { query };
  return { client, calls };
}

describe('runOne', () => {
  it('wraps a successful migration in BEGIN / INSERT / COMMIT', async () => {
    const upSpy = vi.fn().mockResolvedValue(undefined);
    const { client, calls } = makeMockClient();
    await runOne(client, m('0007_test', upSpy));

    expect(upSpy).toHaveBeenCalledOnce();
    expect(upSpy).toHaveBeenCalledWith(client);

    const verbs = calls.map((c) => c.text.split(/\s+/)[0].toUpperCase());
    expect(verbs[0]).toBe('BEGIN');
    expect(verbs.at(-1)).toBe('COMMIT');

    // The bookkeeping insert uses the id as a parameter — never inline.
    const insert = calls.find((c) => c.text.includes('INSERT INTO schema_migrations'));
    expect(insert).toBeDefined();
    expect(insert!.params).toEqual(['0007_test']);
  });

  it('rolls back and rethrows when the migration body throws', async () => {
    const boom = new Error('table already exists');
    const { client, calls } = makeMockClient();
    await expect(
      runOne(
        client,
        m('0007_fail', async () => {
          throw boom;
        }),
      ),
    ).rejects.toThrowError(/0007_fail failed: table already exists/);

    const verbs = calls.map((c) => c.text.split(/\s+/)[0].toUpperCase());
    expect(verbs).toContain('ROLLBACK');
    expect(verbs).not.toContain('COMMIT');
  });

  it('rolls back when the bookkeeping insert fails', async () => {
    const upSpy = vi.fn().mockResolvedValue(undefined);
    const { client, calls } = makeMockClient({
      'INSERT INTO schema_migrations (id) VALUES ($1)': () => {
        throw new Error('duplicate key');
      },
    });
    await expect(runOne(client, m('0007_dup', upSpy))).rejects.toThrowError(/duplicate key/);
    expect(calls.map((c) => c.text.split(/\s+/)[0].toUpperCase())).toContain('ROLLBACK');
  });

  it('preserves the original error as `cause`', async () => {
    const original = new Error('underlying');
    const { client } = makeMockClient();
    try {
      await runOne(
        client,
        m('0007_cause', async () => {
          throw original;
        }),
      );
      throw new Error('expected runOne to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBe(original);
    }
  });
});
