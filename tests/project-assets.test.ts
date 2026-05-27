/**
 * Tests for `src/lib/project/assets.ts` — the DB helpers that own
 * the per-row asset URL slots (image / overlay / clip) extracted out
 * of `user_history.payload` into the `project_assets` table.
 *
 * SQL is mocked at the `@vercel/postgres` boundary so each helper's
 * query shape + parameter binding can be asserted without a real DB.
 *
 * See `_plans/2026-05-24-project-assets-extraction.md`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── @vercel/postgres mock ───────────────────────────────────────────
// Captures every sql`` call so tests can inspect query text + values,
// and lets each test set the next response shape with `sqlImpl`.

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

// Imports MUST come after the mock so the module under test picks up
// the mocked client.
import {
  loadProjectAssets,
  writeProjectAsset,
  reindexProjectAssets,
  backfillFromPayload,
  bumpProjectVersion,
} from '@/lib/project/assets';

beforeEach(() => {
  sqlCalls.length = 0;
  sqlImpl = async () => ({ rows: [], rowCount: 0 });
});

const PROJECT_ID = 'c0ffee00-0000-4000-8000-000000000001';

// ── loadProjectAssets ───────────────────────────────────────────────

describe('loadProjectAssets', () => {
  it('returns empty maps when no rows exist', async () => {
    sqlImpl = async () => ({ rows: [], rowCount: 0 });
    const out = await loadProjectAssets(PROJECT_ID);
    expect(out).toEqual({ rowImages: {}, rowOverlays: {}, rowVideoClips: {} });
  });

  it('assembles all three slot kinds into their respective maps', async () => {
    sqlImpl = async () => ({
      rows: [
        { row_index: 0, slot: 'image', data: 'https://r2.example.com/a.png' },
        { row_index: 1, slot: 'overlay', data: { status: 'done', url: 'https://r2/o.png' } },
        { row_index: 2, slot: 'clip', data: { status: 'done', videoUrl: 'https://r2/v.mp4', durationSeconds: 3.5 } },
        { row_index: 5, slot: 'image', data: 'https://r2/b.png' },
      ],
      rowCount: 4,
    });
    const out = await loadProjectAssets(PROJECT_ID);
    expect(out.rowImages).toEqual({
      0: 'https://r2.example.com/a.png',
      5: 'https://r2/b.png',
    });
    expect(out.rowOverlays).toEqual({
      1: { status: 'done', url: 'https://r2/o.png' },
    });
    expect(out.rowVideoClips).toEqual({
      2: { status: 'done', videoUrl: 'https://r2/v.mp4', durationSeconds: 3.5 },
    });
  });

  it('skips rows whose data shape mismatches the slot discriminator', async () => {
    // image data must be a string; overlay/clip must be objects.
    sqlImpl = async () => ({
      rows: [
        { row_index: 0, slot: 'image', data: { wrong: true } }, // dropped
        { row_index: 1, slot: 'overlay', data: 'not-an-object' }, // dropped
        { row_index: 2, slot: 'clip', data: null }, // dropped
        { row_index: 3, slot: 'image', data: 'https://r2/x.png' }, // kept
      ],
      rowCount: 4,
    });
    const out = await loadProjectAssets(PROJECT_ID);
    expect(out.rowImages).toEqual({ 3: 'https://r2/x.png' });
    expect(out.rowOverlays).toEqual({});
    expect(out.rowVideoClips).toEqual({});
  });

  it('binds project_id as the first parameter', async () => {
    await loadProjectAssets(PROJECT_ID);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].values).toEqual([PROJECT_ID]);
  });
});

// ── writeProjectAsset ───────────────────────────────────────────────

describe('writeProjectAsset', () => {
  it('UPSERTs an image with the URL serialized as jsonb', async () => {
    await writeProjectAsset(PROJECT_ID, 7, 'image', 'https://r2/img.png');
    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0];
    expect(call.text).toContain('INSERT INTO project_assets');
    expect(call.text).toContain('ON CONFLICT');
    expect(call.values).toEqual([
      PROJECT_ID,
      7,
      'image',
      JSON.stringify('https://r2/img.png'),
    ]);
  });

  it('UPSERTs an overlay object', async () => {
    await writeProjectAsset(PROJECT_ID, 2, 'overlay', { status: 'done', url: 'https://r2/o.png' });
    const call = sqlCalls[0];
    expect(call.values).toEqual([
      PROJECT_ID,
      2,
      'overlay',
      JSON.stringify({ status: 'done', url: 'https://r2/o.png' }),
    ]);
  });

  it('DELETEs the slot when value === null', async () => {
    await writeProjectAsset(PROJECT_ID, 4, 'image', null);
    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0];
    expect(call.text).toContain('DELETE FROM project_assets');
    expect(call.values).toEqual([PROJECT_ID, 4, 'image']);
  });
});

// ── reindexProjectAssets ────────────────────────────────────────────

describe('reindexProjectAssets', () => {
  it('insert: shifts every row_index >= atIndex up by 1 in a single UPDATE', async () => {
    sqlImpl = async () => ({ rows: [], rowCount: 5 });
    const result = await reindexProjectAssets(PROJECT_ID, 'insert', 3);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toMatch(/UPDATE project_assets/);
    expect(sqlCalls[0].text).toMatch(/row_index\s*\+\s*1/);
    expect(sqlCalls[0].text).toMatch(/row_index\s*>=/);
    expect(sqlCalls[0].values).toEqual([PROJECT_ID, 3]);
    expect(result.affected).toBe(5);
  });

  it('delete: removes the row at atIndex AND shifts later rows down by 1', async () => {
    // Two SQL calls: DELETE, then UPDATE. Second response is the
    // shifted-row count that the helper returns.
    let callIndex = 0;
    sqlImpl = async () => {
      callIndex += 1;
      return { rows: [], rowCount: callIndex === 1 ? 1 : 4 };
    };
    const result = await reindexProjectAssets(PROJECT_ID, 'delete', 3);
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[0].text).toMatch(/DELETE FROM project_assets/);
    expect(sqlCalls[0].values).toEqual([PROJECT_ID, 3]);
    expect(sqlCalls[1].text).toMatch(/UPDATE project_assets/);
    expect(sqlCalls[1].text).toMatch(/row_index\s*-\s*1/);
    expect(sqlCalls[1].text).toMatch(/row_index\s*>/);
    expect(sqlCalls[1].values).toEqual([PROJECT_ID, 3]);
    // helper returns the shift-count from the UPDATE, not the DELETE.
    expect(result.affected).toBe(4);
  });
});

// ── backfillFromPayload ─────────────────────────────────────────────

describe('backfillFromPayload', () => {
  it('merges into a project_assets that already has rows (no early-skip)', async () => {
    // Pre-fix bug: a single existence probe found a row and the
    // entire backfill was skipped, dropping legacy entries that
    // belonged to other indices. Post-fix: no probe; INSERT with
    // ON CONFLICT DO NOTHING handles the merge per-row.
    sqlImpl = async () => ({
      rows: [{ row_index: 0 }, { row_index: 1 }], // 2 actually inserted
      rowCount: 2,
    });
    const result = await backfillFromPayload(PROJECT_ID, {
      rowImages: {
        0: 'https://r2/legacy-0.png',
        1: 'https://r2/legacy-1.png',
        5: 'https://r2/already-in-table.png',
      },
      rowOverlays: {},
      rowVideoClips: {},
    });
    // backfilled = rows the DB actually inserted (RETURNING count),
    // not the candidate count. Skipped is now always false: the
    // helper always tries the INSERT and lets the unique index decide.
    expect(result).toEqual({ backfilled: 2, skipped: false });
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toContain('INSERT INTO project_assets');
    expect(sqlCalls[0].text).toContain('ON CONFLICT');
    expect(sqlCalls[0].text).toContain('RETURNING');
    expect(sqlCalls[0].text).not.toContain('EXISTS');
  });

  it('reports skipped:false, backfilled:0 when payload is empty', async () => {
    const result = await backfillFromPayload(PROJECT_ID, {
      rowImages: {},
      rowOverlays: {},
      rowVideoClips: {},
    });
    expect(result).toEqual({ backfilled: 0, skipped: false });
    // No SQL fired — nothing to backfill, no point opening a tx.
    expect(sqlCalls).toHaveLength(0);
  });

  it('inserts one row per (slot, index) pair via a single bulk statement', async () => {
    sqlImpl = async () => ({
      rows: [{ row_index: 0 }, { row_index: 1 }, { row_index: 0 }],
      rowCount: 3,
    });
    const result = await backfillFromPayload(PROJECT_ID, {
      rowImages: { 0: 'https://r2/a.png', 1: 'https://r2/b.png' },
      rowOverlays: { 0: { status: 'done', url: 'https://r2/o.png' } },
      rowVideoClips: {},
    });
    expect(result).toEqual({ backfilled: 3, skipped: false });
    expect(sqlCalls).toHaveLength(1);
    const insertCall = sqlCalls[0];
    expect(insertCall.text).toContain('INSERT INTO project_assets');
    expect(insertCall.text).toContain('jsonb_array_elements');
    // Two binds: projectId + the batch JSON.
    expect(insertCall.values).toHaveLength(2);
    expect(insertCall.values[0]).toBe(PROJECT_ID);
    const batch = JSON.parse(insertCall.values[1] as string) as Array<Record<string, unknown>>;
    expect(batch).toHaveLength(3);
    expect(batch).toEqual(
      expect.arrayContaining([
        { row_index: 0, slot: 'image', data: 'https://r2/a.png' },
        { row_index: 1, slot: 'image', data: 'https://r2/b.png' },
        { row_index: 0, slot: 'overlay', data: { status: 'done', url: 'https://r2/o.png' } },
      ]),
    );
  });

  it('rejects malformed keys: negative indices, non-integer indices, empty strings, non-objects', async () => {
    sqlImpl = async () => ({ rows: [{ row_index: 7 }], rowCount: 1 });
    await backfillFromPayload(PROJECT_ID, {
      rowImages: {
        '-1': 'https://r2/neg.png', // dropped: negative
        '1.5': 'https://r2/frac.png', // dropped: non-integer (parses as NaN-ish)
        'abc': 'https://r2/text.png', // dropped: non-numeric
        0: '', // dropped: empty string
        7: 'https://r2/keep.png', // kept
      } as unknown as Record<number, string>,
      rowOverlays: {
        2: null as unknown as { status: string }, // dropped: not an object
      },
      rowVideoClips: {},
    });
    expect(sqlCalls).toHaveLength(1);
    const batch = JSON.parse(sqlCalls[0].values[1] as string) as Array<Record<string, unknown>>;
    expect(batch).toEqual([{ row_index: 7, slot: 'image', data: 'https://r2/keep.png' }]);
  });
});

// ── bumpProjectVersion ──────────────────────────────────────────────

describe('bumpProjectVersion', () => {
  it('UPDATEs the version and returns the new value', async () => {
    sqlImpl = async () => ({ rows: [{ new_version: 42 }], rowCount: 1 });
    const v = await bumpProjectVersion(PROJECT_ID);
    expect(v).toBe(42);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toContain('UPDATE user_history');
    expect(sqlCalls[0].text).toMatch(/version\s*\+\s*1/);
    expect(sqlCalls[0].values).toEqual([PROJECT_ID]);
  });

  it('returns 0 when no rows were updated (row missing)', async () => {
    sqlImpl = async () => ({ rows: [], rowCount: 0 });
    const v = await bumpProjectVersion(PROJECT_ID);
    expect(v).toBe(0);
  });
});
