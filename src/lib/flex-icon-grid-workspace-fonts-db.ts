/**
 * Workspace-scoped custom font registry — CRUD library (Phase 4.8b).
 *
 * Server-only. Backs the panel's "Registered fonts" picker that lets a
 * user reuse uploaded fonts across thumbnails. Mirrors the contract of
 * sibling Flex Icon Grid lib modules so the route handlers follow the
 * same workspace-tenancy pattern.
 *
 * Stored on `flex_icon_grid_workspace_fonts` (migration 0104):
 *   - name (workspace-unique)
 *   - r2_key (the R2 object key — presigned URLs are minted per read)
 *   - mime_type + size_bytes (for the picker's display chips)
 */

import { sql } from '@vercel/postgres';
import {
  validateWorkspaceFontInput,
  type WorkspaceFontInput,
  type ValidationResult,
} from './flex-icon-grid-workspace-fonts-validate';

export { validateWorkspaceFontInput };
export type { WorkspaceFontInput, ValidationResult };

export interface WorkspaceFontRow {
  id: string;
  workspace_id: string;
  name: string;
  r2_key: string;
  mime_type: string;
  size_bytes: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const ROW_SHAPE = `
  id::text AS id,
  workspace_id::text AS workspace_id,
  name,
  r2_key,
  mime_type,
  size_bytes::int AS size_bytes,
  created_by::text AS created_by,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

export async function listWorkspaceFonts(workspaceId: string): Promise<WorkspaceFontRow[]> {
  const { rows } = await sql.query<WorkspaceFontRow>(
    `
    SELECT ${ROW_SHAPE}
      FROM flex_icon_grid_workspace_fonts
     WHERE workspace_id = $1::uuid
     ORDER BY updated_at DESC
    `,
    [workspaceId],
  );
  return rows;
}

export async function getWorkspaceFont(id: string, workspaceId: string): Promise<WorkspaceFontRow | null> {
  const { rows } = await sql.query<WorkspaceFontRow>(
    `
    SELECT ${ROW_SHAPE}
      FROM flex_icon_grid_workspace_fonts
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [id, workspaceId],
  );
  return rows.length === 0 ? null : rows[0];
}

export async function createWorkspaceFont(args: {
  workspaceId: string;
  createdBy: string | null;
  input: WorkspaceFontInput;
}): Promise<WorkspaceFontRow> {
  const { workspaceId, createdBy, input } = args;
  const { rows } = await sql.query<WorkspaceFontRow>(
    `
    INSERT INTO flex_icon_grid_workspace_fonts
      (workspace_id, name, r2_key, mime_type, size_bytes, created_by)
    VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)
    RETURNING ${ROW_SHAPE}
    `,
    [workspaceId, input.name, input.r2_key, input.mime_type, input.size_bytes, createdBy],
  );
  return rows[0];
}

export async function deleteWorkspaceFont(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql.query(
    `DELETE FROM flex_icon_grid_workspace_fonts WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

// Validation now lives in the pure `flex-icon-grid-workspace-fonts-
// validate.ts` module so vitest can import it without dragging in
// `@vercel/postgres`. Re-exported at the top of this file.
