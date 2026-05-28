/**
 * Workspace-scoped saved palettes — CRUD library.
 *
 * Server-only. Backs the Phase 4 "Save / load palette" feature on the
 * Flex Icon Grid panel. Mirrors the shape of the sibling
 * `thumbnail-templates.ts` lib (migration 0053) so the route handlers
 * follow the same workspace-tenancy contract.
 *
 * Stored on `flex_icon_grid_saved_palettes` (migration 0099):
 *   - name (workspace-unique)
 *   - colors_jsonb (ordered array of hex colour strings)
 *
 * Validation lives in the route handlers — this lib is pure CRUD.
 * Cross-workspace ids return null (callers map to 404).
 */

import { sql } from '@vercel/postgres';

export interface SavedPalette {
  id: string;
  workspace_id: string;
  name: string;
  colors: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedPaletteInput {
  name: string;
  colors: string[];
}

const ROW_SHAPE = `
  id::text AS id,
  workspace_id::text AS workspace_id,
  name,
  COALESCE(colors_jsonb, '[]'::jsonb) AS colors,
  created_by::text AS created_by,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

export async function listSavedPalettes(workspaceId: string): Promise<SavedPalette[]> {
  const { rows } = await sql.query<SavedPalette>(
    `
    SELECT ${ROW_SHAPE}
      FROM flex_icon_grid_saved_palettes
     WHERE workspace_id = $1::uuid
     ORDER BY updated_at DESC
    `,
    [workspaceId],
  );
  return rows.map(normaliseColors);
}

export async function getSavedPalette(id: string, workspaceId: string): Promise<SavedPalette | null> {
  const { rows } = await sql.query<SavedPalette>(
    `
    SELECT ${ROW_SHAPE}
      FROM flex_icon_grid_saved_palettes
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [id, workspaceId],
  );
  if (rows.length === 0) return null;
  return normaliseColors(rows[0]);
}

export async function createSavedPalette(args: {
  workspaceId: string;
  createdBy: string | null;
  input: SavedPaletteInput;
}): Promise<SavedPalette> {
  const { workspaceId, createdBy, input } = args;
  const { rows } = await sql.query<SavedPalette>(
    `
    INSERT INTO flex_icon_grid_saved_palettes
      (workspace_id, name, colors_jsonb, created_by)
    VALUES ($1::uuid, $2, $3::jsonb, $4::uuid)
    RETURNING ${ROW_SHAPE}
    `,
    [workspaceId, input.name, JSON.stringify(input.colors), createdBy],
  );
  return normaliseColors(rows[0]);
}

export async function deleteSavedPalette(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql.query(
    `DELETE FROM flex_icon_grid_saved_palettes WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true; value: SavedPaletteInput }
  | { ok: false; reason: string };

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function validateSavedPaletteInput(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'request body must be an object' };
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return { ok: false, reason: 'name is required' };
  if (name.length > 60) return { ok: false, reason: 'name must be at most 60 characters' };
  if (!Array.isArray(o.colors)) return { ok: false, reason: 'colors must be an array' };
  if (o.colors.length === 0) return { ok: false, reason: 'colors must have at least one entry' };
  if (o.colors.length > 30) return { ok: false, reason: 'colors must have at most 30 entries' };
  const colors: string[] = [];
  for (let i = 0; i < o.colors.length; i++) {
    const c = o.colors[i];
    if (typeof c !== 'string' || !HEX_COLOR_RE.test(c)) {
      return { ok: false, reason: `colors[${i}] is not a valid hex colour` };
    }
    colors.push(c);
  }
  return { ok: true, value: { name, colors } };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Postgres returns `colors_jsonb` as a JS object; we re-shape it to
 * the declared `string[]` type. Defensive: rows whose stored value is
 * malformed (somehow ended up non-array) get an empty array rather
 * than a throw, mirroring the same pattern in `thumbnail-templates`
 * for `image_references`.
 */
function normaliseColors(row: SavedPalette): SavedPalette {
  const raw = row.colors as unknown;
  if (Array.isArray(raw)) {
    return { ...row, colors: raw.filter((c): c is string => typeof c === 'string') };
  }
  return { ...row, colors: [] };
}
