import { describe, expect, it } from 'vitest';
import migration0011 from '@/lib/migrations/0011_add_workspace_id_columns';
import migration0012 from '@/lib/migrations/0012_backfill_workspace_id';
import migration0013 from '@/lib/migrations/0013_enforce_workspace_id';
import {
  ALL_TENANT_TABLES,
  ROOT_TENANT_TABLES,
  CHILD_TENANT_TABLES,
} from '@/lib/migrations/_workspace_scoped_tables';
import type { MigrationClient } from '@/lib/migrations/types';

interface CapturedQuery {
  text: string;
  params?: unknown[];
}

function makeRecorder(handlers: Array<[RegExp, () => Promise<{ rows: unknown[]; rowCount: number | null }>]> = []) {
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

/** Default handler set used by the 0012 / 0013 specs: pretends every tenant
 *  table physically exists. Real failure modes (missing tables, etc.) are
 *  exercised separately in the missing-tables tests below. */
const SCHEMA_INTROSPECTION_RE = /SELECT table_name FROM information_schema\.tables/;
function fullSchemaHandlers(): Array<[RegExp, () => Promise<{ rows: unknown[]; rowCount: number | null }>]> {
  return [
    [SCHEMA_INTROSPECTION_RE, async () => ({
      rows: ALL_TENANT_TABLES.map((t) => ({ table_name: t })),
      rowCount: ALL_TENANT_TABLES.length,
    })],
  ];
}

describe('tenant table list invariants', () => {
  it('every root and child name is a safe SQL identifier', () => {
    const SAFE = /^[a-z_][a-z0-9_]*$/;
    for (const t of ALL_TENANT_TABLES) expect(SAFE.test(t)).toBe(true);
  });

  it('contains no duplicates between root and child', () => {
    const set = new Set<string>(ROOT_TENANT_TABLES);
    for (const c of CHILD_TENANT_TABLES) {
      expect(set.has(c.table), `child ${c.table} must not also be a root`).toBe(false);
    }
  });

  it('every child references a parent that is itself tenant-scoped', () => {
    const knownTables = new Set<string>([
      ...ROOT_TENANT_TABLES,
      ...CHILD_TENANT_TABLES.map((c) => c.table),
    ]);
    for (const c of CHILD_TENANT_TABLES) {
      expect(knownTables.has(c.parentTable), `${c.table}.parent ${c.parentTable} not in tenant set`).toBe(true);
    }
  });

  it('every child has a valid depth (1..4) and parents are at depth-1', () => {
    const depthOf = new Map<string, number>();
    for (const t of ROOT_TENANT_TABLES) depthOf.set(t, 0);
    for (const c of CHILD_TENANT_TABLES) depthOf.set(c.table, c.depth);
    for (const c of CHILD_TENANT_TABLES) {
      expect(c.depth).toBeGreaterThanOrEqual(1);
      expect(c.depth).toBeLessThanOrEqual(4);
      const parentDepth = depthOf.get(c.parentTable);
      expect(parentDepth, `${c.table}.parentTable ${c.parentTable} has no depth`).toBeDefined();
      expect(parentDepth).toBe(c.depth - 1);
    }
  });

  it('includes the post-PR-2 narration_take_comments table at depth 4', () => {
    const t = CHILD_TENANT_TABLES.find((c) => c.table === 'narration_take_comments');
    expect(t).toBeDefined();
    expect(t!.depth).toBe(4);
    expect(t!.parentTable).toBe('narrator_takes');
  });
});

describe('migration 0011 — add workspace_id columns', () => {
  it('issues ALTER TABLE IF EXISTS … ADD COLUMN IF NOT EXISTS for every tenant table', async () => {
    const { client, calls } = makeRecorder();
    await migration0011.up(client);

    expect(calls.length).toBe(ALL_TENANT_TABLES.length);
    for (const table of ALL_TENANT_TABLES) {
      const matchingCall = calls.find(
        (c) => c.text.includes(`ALTER TABLE IF EXISTS ${table}`) && c.text.includes('workspace_id UUID'),
      );
      expect(matchingCall, `no ALTER … ADD workspace_id for ${table}`).toBeDefined();
    }
  });

  it('declares the FK with ON DELETE CASCADE for every table', async () => {
    const { client, calls } = makeRecorder();
    await migration0011.up(client);

    for (const c of calls) {
      expect(c.text).toMatch(/REFERENCES workspaces\(id\)\s+ON DELETE CASCADE/);
    }
  });
});

describe('migration 0012 — backfill workspace_id', () => {
  const SELECT_BOOTSTRAP_RE = /SELECT id FROM workspaces ORDER BY created_at/;

  it('throws if no workspace exists', async () => {
    const { client } = makeRecorder([
      [SELECT_BOOTSTRAP_RE, async () => ({ rows: [], rowCount: 0 })],
    ]);
    await expect(migration0012.up(client)).rejects.toThrow(/No workspace exists/);
  });

  it('updates every root table with the bootstrap workspace id', async () => {
    const { client, calls } = makeRecorder([
      [SELECT_BOOTSTRAP_RE, async () => ({ rows: [{ id: 'bootstrap-ws' }], rowCount: 1 })],
      ...fullSchemaHandlers(),
    ]);
    await migration0012.up(client);

    for (const table of ROOT_TENANT_TABLES) {
      const update = calls.find(
        (c) => c.text.includes(`UPDATE ${table}`) && c.text.includes('workspace_id IS NULL') && !c.text.includes(`UPDATE ${table} AS t`),
      );
      expect(update, `no root UPDATE for ${table}`).toBeDefined();
      expect(update!.params).toEqual(['bootstrap-ws']);
    }
  });

  it('updates every child table by joining its parent', async () => {
    const { client, calls } = makeRecorder([
      [SELECT_BOOTSTRAP_RE, async () => ({ rows: [{ id: 'bootstrap-ws' }], rowCount: 1 })],
      ...fullSchemaHandlers(),
    ]);
    await migration0012.up(client);

    for (const c of CHILD_TENANT_TABLES) {
      const update = calls.find(
        (call) =>
          call.text.includes(`UPDATE ${c.table} AS t`) &&
          call.text.includes(`FROM ${c.parentTable} AS parent`) &&
          call.text.includes(`parent.id = t.${c.fkColumn}`),
      );
      expect(update, `no child UPDATE for ${c.table}`).toBeDefined();
    }
  });

  it('processes children in increasing depth order (1 → 4)', async () => {
    const { client, calls } = makeRecorder([
      [SELECT_BOOTSTRAP_RE, async () => ({ rows: [{ id: 'bootstrap-ws' }], rowCount: 1 })],
      ...fullSchemaHandlers(),
    ]);
    await migration0012.up(client);

    const positions = new Map<string, number>();
    for (const c of CHILD_TENANT_TABLES) {
      const idx = calls.findIndex((call) => call.text.includes(`UPDATE ${c.table} AS t`));
      expect(idx).toBeGreaterThanOrEqual(0);
      positions.set(c.table, idx);
    }

    for (const c of CHILD_TENANT_TABLES) {
      for (const earlier of CHILD_TENANT_TABLES) {
        if (earlier.depth < c.depth) {
          expect(
            positions.get(earlier.table)!,
            `${earlier.table} (depth ${earlier.depth}) must run before ${c.table} (depth ${c.depth})`,
          ).toBeLessThan(positions.get(c.table)!);
        }
      }
    }
  });

  it('runs every root UPDATE before any child UPDATE', async () => {
    const { client, calls } = makeRecorder([
      [SELECT_BOOTSTRAP_RE, async () => ({ rows: [{ id: 'bootstrap-ws' }], rowCount: 1 })],
      ...fullSchemaHandlers(),
    ]);
    await migration0012.up(client);

    const lastRootIdx = Math.max(
      ...ROOT_TENANT_TABLES.map((table) =>
        calls.findIndex(
          (c) =>
            c.text.includes(`UPDATE ${table}`) &&
            c.text.includes('workspace_id IS NULL') &&
            !c.text.includes(`UPDATE ${table} AS t`),
        ),
      ),
    );
    const firstChildIdx = Math.min(
      ...CHILD_TENANT_TABLES.map((c) => calls.findIndex((call) => call.text.includes(`UPDATE ${c.table} AS t`))),
    );

    expect(lastRootIdx).toBeGreaterThanOrEqual(0);
    expect(firstChildIdx).toBeGreaterThan(lastRootIdx);
  });

  it('skips tables that physically do not exist on the target DB', async () => {
    // information_schema returns ONLY two tables — projects + scripts.
    // The migration must skip every other table without throwing.
    const { client, calls } = makeRecorder([
      [SELECT_BOOTSTRAP_RE, async () => ({ rows: [{ id: 'bootstrap-ws' }], rowCount: 1 })],
      [SCHEMA_INTROSPECTION_RE, async () => ({
        rows: [{ table_name: 'projects' }, { table_name: 'scripts' }],
        rowCount: 2,
      })],
    ]);
    await expect(migration0012.up(client)).resolves.toBeUndefined();

    // Every UPDATE must hit only one of the two known-existing tables.
    // Three structural passes per table that exists: initial root/child
    // backfill + final NULL sweep. No UPDATE should reference any of the
    // 27 tables that don't exist.
    const updates = calls.filter((c) => c.text.startsWith('UPDATE'));
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      const referencesProjects = /\bprojects\b/.test(u.text);
      const referencesScripts = /\bscripts\b/.test(u.text);
      expect(
        referencesProjects || referencesScripts,
        `UPDATE references a missing table: ${u.text}`,
      ).toBe(true);
    }
    expect(updates.some((c) => c.text.includes('UPDATE projects'))).toBe(true);
    expect(updates.some((c) => c.text.includes('UPDATE scripts AS t'))).toBe(true);
  });

  it('runs a final NULL-sweep pass that attributes orphans to the bootstrap workspace', async () => {
    const { client, calls } = makeRecorder([
      [SELECT_BOOTSTRAP_RE, async () => ({ rows: [{ id: 'bootstrap-ws' }], rowCount: 1 })],
      ...fullSchemaHandlers(),
    ]);
    await migration0012.up(client);

    // Every tenant table must have at least one root-style UPDATE
    // (UPDATE x SET workspace_id = $1 WHERE workspace_id IS NULL) — this
    // is the sweep, regardless of root vs child.
    for (const table of ALL_TENANT_TABLES) {
      const rootishUpdates = calls.filter(
        (c) =>
          c.text.startsWith(`UPDATE ${table} `) &&
          c.text.includes('workspace_id IS NULL') &&
          !c.text.includes(`UPDATE ${table} AS t`),
      );
      expect(rootishUpdates.length, `no sweep UPDATE for ${table}`).toBeGreaterThan(0);
    }
  });
});

describe('migration 0013 — enforce workspace_id', () => {
  it('issues SET NOT NULL + CREATE INDEX for every tenant table that exists', async () => {
    const { client, calls } = makeRecorder(fullSchemaHandlers());
    await migration0013.up(client);

    for (const table of ALL_TENANT_TABLES) {
      const notNull = calls.find(
        (c) => c.text.includes(`ALTER TABLE ${table}`) && c.text.includes('SET NOT NULL'),
      );
      const index = calls.find(
        (c) => c.text.includes(`CREATE INDEX IF NOT EXISTS idx_${table}_workspace`),
      );
      expect(notNull, `no SET NOT NULL for ${table}`).toBeDefined();
      expect(index, `no scoping index for ${table}`).toBeDefined();
    }
  });

  it('emits the NOT NULL ALTER before the CREATE INDEX for the same table', async () => {
    const { client, calls } = makeRecorder(fullSchemaHandlers());
    await migration0013.up(client);

    for (const table of ALL_TENANT_TABLES) {
      const notNullIdx = calls.findIndex(
        (c) => c.text.includes(`ALTER TABLE ${table}`) && c.text.includes('SET NOT NULL'),
      );
      const indexIdx = calls.findIndex(
        (c) => c.text.includes(`CREATE INDEX IF NOT EXISTS idx_${table}_workspace`),
      );
      expect(notNullIdx).toBeLessThan(indexIdx);
    }
  });

  it('skips tables that physically do not exist on the target DB', async () => {
    const { client, calls } = makeRecorder([
      [SCHEMA_INTROSPECTION_RE, async () => ({
        rows: [{ table_name: 'projects' }],
        rowCount: 1,
      })],
    ]);
    await expect(migration0013.up(client)).resolves.toBeUndefined();

    const ddl = calls.filter(
      (c) => c.text.startsWith('ALTER TABLE') || c.text.startsWith('CREATE INDEX'),
    );
    // exactly 2 DDLs — the ALTER + CREATE INDEX for `projects`.
    expect(ddl).toHaveLength(2);
    expect(ddl.every((c) => c.text.includes('projects'))).toBe(true);
  });
});
