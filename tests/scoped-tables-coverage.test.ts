import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_TENANT_TABLES } from '@/lib/migrations/_workspace_scoped_tables';
import { SCOPED_TABLES } from '@/lib/workspace-scope';

/**
 * Two independent allowlists track which tables carry workspace_id:
 *
 *   - `ALL_TENANT_TABLES` in `src/lib/migrations/_workspace_scoped_tables.ts`
 *     — drives the backfill migrations, reheal migrations, and the
 *     tenancy-cascade tests.
 *   - `SCOPED_TABLES` in `src/lib/workspace-scope.ts`
 *     — the runtime allowlist for `assertOwnsResource` /
 *       `getResourceInWorkspace`. A typo here means a perfectly valid
 *       tenant query is rejected with `UnknownTableError`.
 *
 * Both lists drift independently. This test asserts:
 *   1. The two app-level lists agree with each other.
 *   2. Both lists are a superset of every table declared with
 *      workspace_id in the actual migrations / db.ts — i.e. nothing
 *      tenant-scoped on disk is missing from the app's awareness.
 *
 * Discovered tables that should NOT be in the tenant lists (junction
 * tables, the workspaces table itself, etc.) are explicitly allow-
 * listed below so the test stays loud about real omissions instead of
 * being noisy about intentional exclusions.
 */
describe('tenant table coverage', () => {
  it('SCOPED_TABLES (runtime) and ALL_TENANT_TABLES (migrations) agree', () => {
    const runtime = new Set<string>(SCOPED_TABLES);
    const migration = new Set<string>(ALL_TENANT_TABLES);
    const onlyInRuntime = [...runtime].filter((t) => !migration.has(t)).sort();
    const onlyInMigration = [...migration].filter((t) => !runtime.has(t)).sort();
    expect(onlyInRuntime, 'in SCOPED_TABLES but not ALL_TENANT_TABLES').toEqual([]);
    expect(onlyInMigration, 'in ALL_TENANT_TABLES but not SCOPED_TABLES').toEqual([]);
  });

  it('every table with a workspace_id column on disk is listed in both', () => {
    const canonical = discoverWorkspaceScopedTablesOnDisk();
    const runtime = new Set<string>(SCOPED_TABLES);
    const migration = new Set<string>(ALL_TENANT_TABLES);
    const missingFromRuntime = [...canonical].filter((t) => !runtime.has(t)).sort();
    const missingFromMigration = [...canonical].filter((t) => !migration.has(t)).sort();
    expect(missingFromRuntime, 'tenant tables missing from SCOPED_TABLES').toEqual([]);
    expect(missingFromMigration, 'tenant tables missing from ALL_TENANT_TABLES').toEqual([]);
  });
});

/**
 * Junction / global tables that legitimately have no workspace_id
 * (or are the workspaces table itself). Keeping the allowlist tight
 * means a future "I added a real tenant table" mistake fails the
 * test instead of slipping by under a permissive ignore.
 */
const INTENTIONALLY_NOT_SCOPED = new Set<string>([
  'workspaces',
  'workspace_members',
  'collaborators',
  'schedule_item_channels',
  'schedule_item_dependencies',
  'narrator_profiles',
  'schema_migrations',
]);

function discoverWorkspaceScopedTablesOnDisk(): Set<string> {
  const repoRoot = path.resolve(__dirname, '..');
  const migDir = path.join(repoRoot, 'src', 'lib', 'migrations');
  const files = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(migDir, f));
  files.push(path.join(repoRoot, 'src', 'lib', 'db.ts'));

  const tables = new Set<string>();
  const createRe = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]+?)\)\s*`/g;
  const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN[^;`]*?workspace_id/gi;

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8');
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(text)) !== null) {
      if (/workspace_id/.test(m[2])) tables.add(m[1]);
    }
    while ((m = alterRe.exec(text)) !== null) {
      tables.add(m[1]);
    }
  }

  for (const t of INTENTIONALLY_NOT_SCOPED) tables.delete(t);
  return tables;
}
