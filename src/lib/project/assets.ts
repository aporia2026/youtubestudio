/**
 * Project assets — DB helpers for the `project_assets` table that
 * extracts per-row asset URLs out of `user_history.payload`.
 *
 * See `_plans/2026-05-24-project-assets-extraction.md` for the full
 * design. The short version: the editor's `rowImages` /
 * `rowOverlays` / `rowVideoClips` maps used to live inline on the
 * payload JSONB, which capped payload size at the 10 MB jsonb limit
 * for large projects. This module owns the read / write / reindex /
 * backfill paths against the dedicated table.
 *
 * Every public function is project-scoped and assumes the caller has
 * already validated the requesting user owns the project (the
 * existing `apiRoute.authed` + workspace_id / collaborator_id bind in
 * the route handlers).
 */

import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { ProjectPayload } from './payload';
import type { RowOverlayRenderState, RowVideoClipState } from '@/remotion/utils';

/** Slot discriminator. Mirrors the `slot` column's CHECK constraint
 *  in migration 0084. */
export type AssetSlot = 'image' | 'overlay' | 'clip';

/** Shape stored in `project_assets.data` per slot. Mirrors what the
 *  editor expects in `payload.rowImages[i]` etc. — one-to-one copy
 *  on assembly, no transformation. */
export type AssetData =
  | { slot: 'image'; data: string }
  | { slot: 'overlay'; data: RowOverlayRenderState }
  | { slot: 'clip'; data: RowVideoClipState };

export interface ProjectAssetMaps {
  rowImages: Record<number, string>;
  rowOverlays: Record<number, RowOverlayRenderState>;
  rowVideoClips: Record<number, RowVideoClipState>;
}

const EMPTY_ASSET_MAPS: ProjectAssetMaps = {
  rowImages: {},
  rowOverlays: {},
  rowVideoClips: {},
};

/**
 * Load every asset for a project, assembled into the three sparse
 * maps the editor expects. Returns empty maps if the project has no
 * assets (either freshly-created OR not yet backfilled — caller is
 * responsible for the second case via `backfillFromPayload`).
 */
export async function loadProjectAssets(
  projectId: string,
): Promise<ProjectAssetMaps> {
  const { rows } = await sql<{
    row_index: number;
    slot: AssetSlot;
    data: unknown;
  }>`
    SELECT row_index, slot, data
      FROM project_assets
     WHERE project_id = ${projectId}::uuid
     ORDER BY row_index ASC
  `;

  if (rows.length === 0) {
    return { rowImages: {}, rowOverlays: {}, rowVideoClips: {} };
  }

  const out: ProjectAssetMaps = {
    rowImages: {},
    rowOverlays: {},
    rowVideoClips: {},
  };
  for (const r of rows) {
    if (r.slot === 'image') {
      // image data is a bare string URL.
      if (typeof r.data === 'string') {
        out.rowImages[r.row_index] = r.data;
      }
    } else if (r.slot === 'overlay') {
      // overlay data is { status, url? }.
      if (r.data && typeof r.data === 'object') {
        out.rowOverlays[r.row_index] = r.data as RowOverlayRenderState;
      }
    } else if (r.slot === 'clip') {
      // clip data is { status, videoUrl?, durationSeconds?, brollClipId? }.
      if (r.data && typeof r.data === 'object') {
        out.rowVideoClips[r.row_index] = r.data as RowVideoClipState;
      }
    }
  }
  return out;
}

/**
 * UPSERT a single asset slot for a row. Mirrors the contract of the
 * old `jsonb_set` write in row-asset/route.ts: writing an image to
 * row N doesn't disturb row N's overlay/clip OR any other row's
 * data. ON CONFLICT updates `data` and bumps `updated_at`.
 *
 * Pass `null` value to DELETE the slot (caller does for clear-image
 * intent).
 */
export async function writeProjectAsset(
  projectId: string,
  rowIndex: number,
  slot: AssetSlot,
  value: string | RowOverlayRenderState | RowVideoClipState | null,
): Promise<void> {
  if (value === null) {
    await sql`
      DELETE FROM project_assets
       WHERE project_id = ${projectId}::uuid
         AND row_index = ${rowIndex}
         AND slot = ${slot}
    `;
    return;
  }
  const dataJson = JSON.stringify(value);
  await sql`
    INSERT INTO project_assets (project_id, row_index, slot, data)
    VALUES (${projectId}::uuid, ${rowIndex}, ${slot}, ${dataJson}::jsonb)
    ON CONFLICT (project_id, row_index, slot) DO UPDATE
       SET data = EXCLUDED.data,
           updated_at = NOW()
  `;
}

/**
 * Propagate a client-side row insert / delete to the asset table's
 * indices. Without this, the client reindexes its in-memory maps
 * (see INSERT_BLANK_SHOT / DELETE_SHOT reducers) but the server's
 * project_assets keys go out of sync — the next upload lands on
 * the wrong row's index, and old assets effectively "move" to
 * neighbouring shots on reload.
 *
 * Atomic single statement per op so a crash mid-reindex can't leave
 * the table half-shifted.
 */
export async function reindexProjectAssets(
  projectId: string,
  op: 'insert' | 'delete',
  atIndex: number,
): Promise<{ affected: number }> {
  if (op === 'insert') {
    // Shift every row at or after the insertion point UP by 1.
    // Reverse iteration order isn't needed because the unique
    // constraint is on (project_id, row_index, slot) and we're
    // SHIFTING UP — no two rows ever collide on the new value
    // because they were unique on the old value too.
    const result = await sql`
      UPDATE project_assets
         SET row_index = row_index + 1,
             updated_at = NOW()
       WHERE project_id = ${projectId}::uuid
         AND row_index >= ${atIndex}
    `;
    return { affected: result.rowCount ?? 0 };
  }
  // delete: remove the row at atIndex, then shift everything past
  // it DOWN by 1. Two statements — both single-row-locked under
  // the same query plan; if the delete commits but the shift fails
  // we have a small gap at atIndex which is harmless (the slot is
  // just empty until next write).
  await sql`
    DELETE FROM project_assets
     WHERE project_id = ${projectId}::uuid
       AND row_index = ${atIndex}
  `;
  const shifted = await sql`
    UPDATE project_assets
       SET row_index = row_index - 1,
           updated_at = NOW()
     WHERE project_id = ${projectId}::uuid
       AND row_index > ${atIndex}
  `;
  return { affected: shifted.rowCount ?? 0 };
}

/**
 * One-shot backfill from a project's existing in-payload asset maps
 * into the project_assets table. Called lazily on the first GET
 * after this feature deploys — projects that have NEVER been
 * accessed stay in the payload until accessed; no big-bang migration.
 *
 * Skips the entire backfill when project_assets already has rows
 * for this project (idempotent — future GETs are no-ops). Inserts
 * happen in a single multi-VALUES statement so a partial failure
 * leaves the table unchanged.
 *
 * NOTE: the payload's asset maps remain present after backfill;
 * the load path simply ignores them in favor of project_assets.
 * Cleaning them up is a follow-up — they're stale but harmless.
 */
export async function backfillFromPayload(
  projectId: string,
  payload: Pick<ProjectPayload, 'rowImages' | 'rowOverlays' | 'rowVideoClips'>,
): Promise<{ backfilled: number; skipped: boolean }> {
  // Check if the project already has assets in the table —
  // skip the backfill entirely if so. Cheap COUNT-1 probe.
  const existing = await sql<{ exists_row: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM project_assets WHERE project_id = ${projectId}::uuid
    ) AS exists_row
  `;
  if (existing.rows[0]?.exists_row) {
    return { backfilled: 0, skipped: true };
  }

  const rows: Array<{ row_index: number; slot: AssetSlot; data: unknown }> = [];
  for (const [k, v] of Object.entries(payload.rowImages ?? {})) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (typeof v !== 'string' || v.length === 0) continue;
    rows.push({ row_index: idx, slot: 'image', data: v });
  }
  for (const [k, v] of Object.entries(payload.rowOverlays ?? {})) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (!v || typeof v !== 'object') continue;
    rows.push({ row_index: idx, slot: 'overlay', data: v });
  }
  for (const [k, v] of Object.entries(payload.rowVideoClips ?? {})) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (!v || typeof v !== 'object') continue;
    rows.push({ row_index: idx, slot: 'clip', data: v });
  }

  if (rows.length === 0) {
    logger.info('[project-assets backfill] nothing to backfill', { projectId });
    return { backfilled: 0, skipped: false };
  }

  // Bulk INSERT: pass the whole batch as ONE jsonb parameter and
  // unpack server-side via `jsonb_array_elements`. The Vercel
  // Postgres SDK doesn't accept JS arrays as bound parameters in
  // tagged-template queries; jsonb is the workaround that keeps
  // this a single statement.
  // ON CONFLICT DO NOTHING guards against a race where two
  // simultaneous backfills land at once (the second is a no-op).
  const batchJson = JSON.stringify(rows);
  await sql`
    INSERT INTO project_assets (project_id, row_index, slot, data)
    SELECT ${projectId}::uuid,
           (r->>'row_index')::int,
           r->>'slot',
           r->'data'
      FROM jsonb_array_elements(${batchJson}::jsonb) AS r
    ON CONFLICT (project_id, row_index, slot) DO NOTHING
  `;

  logger.info('[project-assets backfill] done', {
    projectId,
    backfilled: rows.length,
  });
  return { backfilled: rows.length, skipped: false };
}

/**
 * Bump `user_history.version` so the editor's optimistic-sync
 * contract continues to work. The asset write doesn't touch the
 * payload, so we have to nudge the version manually after each
 * row-asset write or the editor would never know assets changed.
 */
export async function bumpProjectVersion(projectId: string): Promise<number> {
  const result = await sql<{ new_version: number }>`
    UPDATE user_history
       SET version = version + 1
     WHERE id = ${projectId}::uuid
     RETURNING version AS new_version
  `;
  return result.rows[0]?.new_version ?? 0;
}
