/**
 * Workspace-scoped saved starting templates — CRUD library.
 *
 * Server-only. Backs the Phase 4.7c "Save / load template" feature on
 * the Flex Icon Grid panel. Mirrors the shape of the sibling
 * `flex-icon-grid-saved-palettes-db.ts` so the route handlers follow
 * the same workspace-tenancy contract.
 *
 * Stored on `flex_icon_grid_saved_templates` (migration 0101):
 *   - name (workspace-unique)
 *   - config_jsonb (trimmed FlexIconGridConfig without per-cell content)
 *
 * Validation lives in the route handlers via the pure
 * `flex-icon-grid-saved-templates-validate.ts` module — re-exported
 * here so existing callers don't change imports.
 * Cross-workspace ids return null (callers map to 404).
 */

import { sql } from '@vercel/postgres';
import {
  validateSavedTemplateInput,
  type SavedTemplateInput,
  type ValidationResult,
} from './flex-icon-grid-saved-templates-validate';

export { validateSavedTemplateInput };
export type { SavedTemplateInput, ValidationResult };

export interface SavedTemplate {
  id: string;
  workspace_id: string;
  name: string;
  config: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const ROW_SHAPE = `
  id::text AS id,
  workspace_id::text AS workspace_id,
  name,
  config_jsonb AS config,
  created_by::text AS created_by,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

export async function listSavedTemplates(workspaceId: string): Promise<SavedTemplate[]> {
  const { rows } = await sql.query<SavedTemplate>(
    `
    SELECT ${ROW_SHAPE}
      FROM flex_icon_grid_saved_templates
     WHERE workspace_id = $1::uuid
     ORDER BY updated_at DESC
    `,
    [workspaceId],
  );
  return rows;
}

export async function getSavedTemplate(id: string, workspaceId: string): Promise<SavedTemplate | null> {
  const { rows } = await sql.query<SavedTemplate>(
    `
    SELECT ${ROW_SHAPE}
      FROM flex_icon_grid_saved_templates
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [id, workspaceId],
  );
  return rows.length === 0 ? null : rows[0];
}

export async function createSavedTemplate(args: {
  workspaceId: string;
  createdBy: string | null;
  input: SavedTemplateInput;
}): Promise<SavedTemplate> {
  const { workspaceId, createdBy, input } = args;
  const { rows } = await sql.query<SavedTemplate>(
    `
    INSERT INTO flex_icon_grid_saved_templates
      (workspace_id, name, config_jsonb, created_by)
    VALUES ($1::uuid, $2, $3::jsonb, $4::uuid)
    RETURNING ${ROW_SHAPE}
    `,
    [workspaceId, input.name, JSON.stringify(input.config), createdBy],
  );
  return rows[0];
}

export async function deleteSavedTemplate(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql.query(
    `DELETE FROM flex_icon_grid_saved_templates WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
