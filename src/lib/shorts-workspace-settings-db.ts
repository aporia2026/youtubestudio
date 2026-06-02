/**
 * DB read/write for per-workspace Shorts settings.
 *
 * Split from `shorts-workspace-settings.ts` 2026-06-02 because the
 * types + defaults are imported by client code (ShortsSettingsPanel)
 * and Turbopack refuses to bundle a client chunk that transitively
 * pulls `@vercel/postgres` (which loads `node:async_hooks`).
 *
 * Client code imports types + normalize from `shorts-workspace-settings.ts`.
 * Server code (routes, fan-out worker, etc.) imports the SQL functions
 * from THIS file.
 */

import { sql } from '@vercel/postgres';
import { logger } from './logger';
import {
  SHORTS_SETTINGS_DEFAULTS,
  normalizeShortsSettings,
  type ShortsWorkspaceSettings,
} from './shorts-workspace-settings';

/** Read the per-workspace Shorts settings. Always returns a
 *  fully-populated object; missing rows return defaults silently. */
export async function getShortsSettings(workspaceId: string): Promise<ShortsWorkspaceSettings> {
  try {
    const { rows } = await sql<{ shorts_settings: unknown }>`
      SELECT shorts_settings FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
    `;
    if (rows.length === 0) {
      logger.warn('[shorts settings read] workspace row missing — returning defaults', { workspaceId });
      return { ...SHORTS_SETTINGS_DEFAULTS };
    }
    return normalizeShortsSettings(rows[0]!.shorts_settings);
  } catch (err) {
    logger.error('[shorts settings read] failed', {
      workspaceId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ...SHORTS_SETTINGS_DEFAULTS };
  }
}

/** Patch the per-workspace Shorts settings. Reads-current, merges, writes-back
 *  in a single statement so two concurrent writers don't clobber each other
 *  for orthogonal keys. */
export async function updateShortsSettings(
  workspaceId: string,
  patch: Partial<ShortsWorkspaceSettings>,
): Promise<ShortsWorkspaceSettings> {
  const current = await getShortsSettings(workspaceId);
  const merged = normalizeShortsSettings({ ...current, ...patch });
  const json = JSON.stringify(merged);
  try {
    await sql`
      UPDATE workspaces
         SET shorts_settings = ${json}::jsonb
       WHERE id = ${workspaceId}::uuid
    `;
    logger.info('[shorts settings write] ok', { workspaceId, keysChanged: Object.keys(patch) });
    return merged;
  } catch (err) {
    logger.error('[shorts settings write] failed', {
      workspaceId,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
