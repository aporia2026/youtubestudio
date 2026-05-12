/**
 * Persistence layer for user-saved outlier search presets.
 *
 * Mirrors the shape of OutlierFilters in `outlier-filters.ts` —
 * filters round-trip through `JSON.stringify` so adding a new
 * filter dimension on the client doesn't require a migration.
 *
 * Workspace-scoped: every helper takes `workspaceId` and every
 * query is filtered by it. Cross-workspace reads return null (PK
 * + UNIQUE are workspace-aware).
 */
import { sql } from '@vercel/postgres';
import type { OutlierFilters } from './outlier-filters';

/** Hard cap on saved presets per workspace. Beyond this the POST
 *  route returns 409 ("too many saved searches; delete one first")
 *  rather than letting the table grow unbounded. */
export const MAX_PRESETS_PER_WORKSPACE = 100;

/** Max name length stored in the DB. Display layer should hint
 *  visually before the user hits this; the server-side guard is the
 *  contract. */
export const PRESET_NAME_MAX_LENGTH = 80;

export interface SavedPresetRow {
  id: string;
  workspace_id: string;
  name: string;
  niche_query: string;
  filters: OutlierFilters;
  created_at: string;
  updated_at: string | null;
}

export async function listPresets(workspaceId: string): Promise<SavedPresetRow[]> {
  const { rows } = await sql<SavedPresetRow>`
    SELECT id::text, workspace_id::text, name, niche_query, filters,
      created_at, updated_at
    FROM niche_search_presets
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT ${MAX_PRESETS_PER_WORKSPACE}
  `;
  return rows;
}

export async function countPresets(workspaceId: string): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM niche_search_presets
    WHERE workspace_id = ${workspaceId}::uuid
  `;
  return Number(rows[0]?.n ?? 0);
}

export interface CreatePresetArgs {
  workspaceId: string;
  name: string;
  nicheQuery: string;
  filters: OutlierFilters;
}

export async function createPreset(args: CreatePresetArgs): Promise<SavedPresetRow> {
  const { rows } = await sql<SavedPresetRow>`
    INSERT INTO niche_search_presets (workspace_id, name, niche_query, filters)
    VALUES (
      ${args.workspaceId}::uuid,
      ${args.name},
      ${args.nicheQuery},
      ${JSON.stringify(args.filters)}::jsonb
    )
    RETURNING id::text, workspace_id::text, name, niche_query, filters,
      created_at, updated_at
  `;
  return rows[0];
}

/** Returns true when a row was deleted. Cross-workspace ids return
 *  false (not 403) to avoid existence leaks. */
export async function deletePreset(workspaceId: string, id: string): Promise<boolean> {
  const { rowCount } = await sql`
    DELETE FROM niche_search_presets
    WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid
  `;
  return (rowCount ?? 0) > 0;
}

/** Normalise a free-text preset name. Trims, collapses whitespace,
 *  caps length, and returns null when the input collapses to empty. */
export function normalizePresetName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return null;
  return trimmed.length > PRESET_NAME_MAX_LENGTH ? trimmed.slice(0, PRESET_NAME_MAX_LENGTH) : trimmed;
}
