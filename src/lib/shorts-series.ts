/**
 * Shorts Series engine — Phase 15.6.
 *
 * A series is a recurring Shorts identity: a name + a locked style +
 * an optional cadence + an optional channel link. When a Short is
 * generated under a series, the series's `locked_style_id` overrides
 * the user's style picker so an episode never accidentally ships in
 * the wrong style.
 *
 * This module exports:
 *   - Pure validators (`validateSeriesName`, `validateLockedStyleId`)
 *     so the route + the UI agree on what's accepted.
 *   - DB-facing CRUD (`listSeries`, `getSeries`, `createSeries`,
 *     `updateSeries`, `deleteSeries`) — workspace-scoped, 404-not-403
 *     on cross-tenant reads.
 */

import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { SHORT_STYLE_IDS, type ShortStyleId } from './short-styles';

export interface ShortsSeriesRow {
  id: string;
  workspace_id: string;
  name: string;
  locked_style_id: ShortStyleId;
  cadence: string | null;
  channel_db_id: string | null;
  intro_text: string | null;
  outro_text: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_NAME_CHARS = 80;
const MAX_CADENCE_CHARS = 80;
const MAX_INTRO_OUTRO_CHARS = 280;
const MAX_NOTES_CHARS = 1000;

/** Returns the trimmed valid name, or null when the input is invalid. */
export function validateSeriesName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_CHARS) return null;
  return trimmed;
}

/** Returns the validated style id, or null when the input isn't a
 *  registered style. The DB column has no CHECK enum — this is the
 *  source-of-truth gate. */
export function validateLockedStyleId(raw: unknown): ShortStyleId | null {
  if (typeof raw !== 'string') return null;
  if ((SHORT_STYLE_IDS as readonly string[]).includes(raw)) return raw as ShortStyleId;
  return null;
}

/** Generic text-field validator with a per-call cap. Returns null when
 *  the input is missing/empty (treated as "leave column NULL") and the
 *  trimmed string otherwise — does NOT throw on too-long input; slices. */
export function normalizeOptionalText(raw: unknown, capChars: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, capChars);
}

export interface CreateSeriesInput {
  workspaceId: string;
  name: string;
  lockedStyleId: ShortStyleId;
  cadence?: string | null;
  channelDbId?: string | null;
  introText?: string | null;
  outroText?: string | null;
  notes?: string | null;
}

export async function listSeries(workspaceId: string): Promise<ShortsSeriesRow[]> {
  const { rows } = await sql<ShortsSeriesRow>`
    SELECT
      id, workspace_id, name, locked_style_id,
      cadence, channel_db_id, intro_text, outro_text, notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM shorts_series
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return rows;
}

export async function getSeries(id: string, workspaceId: string): Promise<ShortsSeriesRow | null> {
  const { rows } = await sql<ShortsSeriesRow>`
    SELECT
      id, workspace_id, name, locked_style_id,
      cadence, channel_db_id, intro_text, outro_text, notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM shorts_series
    WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createSeries(input: CreateSeriesInput): Promise<ShortsSeriesRow> {
  try {
    const { rows } = await sql<ShortsSeriesRow>`
      INSERT INTO shorts_series (
        workspace_id, name, locked_style_id,
        cadence, channel_db_id, intro_text, outro_text, notes
      ) VALUES (
        ${input.workspaceId}::uuid,
        ${input.name},
        ${input.lockedStyleId},
        ${input.cadence ?? null},
        ${input.channelDbId ?? null}::uuid,
        ${input.introText ?? null},
        ${input.outroText ?? null},
        ${input.notes ?? null}
      )
      RETURNING
        id, workspace_id, name, locked_style_id,
        cadence, channel_db_id, intro_text, outro_text, notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at
    `;
    const row = rows[0]!;
    logger.info('[shorts series] create', {
      workspaceId: input.workspaceId,
      seriesId: row.id,
      lockedStyleId: input.lockedStyleId,
    });
    return row;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Surface the UNIQUE collision as a friendlier message — the route
    // turns this into a 409.
    if (/shorts_series_workspace_name_unique/i.test(detail)) {
      throw new Error('A series with that name already exists in this workspace.');
    }
    throw err;
  }
}

export async function deleteSeries(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM shorts_series
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}

/** Caps for the validator + UI to share. */
export const SHORTS_SERIES_LIMITS = Object.freeze({
  MAX_NAME_CHARS,
  MAX_CADENCE_CHARS,
  MAX_INTRO_OUTRO_CHARS,
  MAX_NOTES_CHARS,
});
