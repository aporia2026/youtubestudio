/**
 * Workspace-scoped saved style presets for the N Levels Explained
 * format — CRUD library.
 *
 * Server-only. Sibling to `topic-card-grid-saved-presets-db.ts` —
 * same schema, same preset payload shape (postProcess + titleBar),
 * stored on a separate table per migration 0106. Validation is shared
 * via `thumbnail-saved-presets-validate.ts`.
 *
 * Cross-workspace ids return null (callers map to 404).
 */

import { sql } from '@vercel/postgres';
import {
  validateSavedPresetInput,
  type SavedPresetInput,
  type SavedPresetValidationResult,
} from './thumbnail-saved-presets-validate';

export { validateSavedPresetInput };
export type { SavedPresetInput, SavedPresetValidationResult };

export interface SavedNLevelsPreset {
  id: string;
  workspace_id: string;
  name: string;
  preset: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const ROW_SHAPE = `
  id::text AS id,
  workspace_id::text AS workspace_id,
  name,
  preset_jsonb AS preset,
  created_by::text AS created_by,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

export async function listSavedNLevelsPresets(
  workspaceId: string,
): Promise<SavedNLevelsPreset[]> {
  const { rows } = await sql.query<SavedNLevelsPreset>(
    `
    SELECT ${ROW_SHAPE}
      FROM n_levels_saved_presets
     WHERE workspace_id = $1::uuid
     ORDER BY updated_at DESC
    `,
    [workspaceId],
  );
  return rows;
}

export async function getSavedNLevelsPreset(
  id: string,
  workspaceId: string,
): Promise<SavedNLevelsPreset | null> {
  const { rows } = await sql.query<SavedNLevelsPreset>(
    `
    SELECT ${ROW_SHAPE}
      FROM n_levels_saved_presets
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [id, workspaceId],
  );
  return rows.length === 0 ? null : rows[0];
}

export async function createSavedNLevelsPreset(args: {
  workspaceId: string;
  createdBy: string | null;
  input: SavedPresetInput;
}): Promise<SavedNLevelsPreset> {
  const { workspaceId, createdBy, input } = args;
  const { rows } = await sql.query<SavedNLevelsPreset>(
    `
    INSERT INTO n_levels_saved_presets
      (workspace_id, name, preset_jsonb, created_by)
    VALUES ($1::uuid, $2, $3::jsonb, $4::uuid)
    RETURNING ${ROW_SHAPE}
    `,
    [workspaceId, input.name, JSON.stringify(input.preset), createdBy],
  );
  return rows[0];
}

export async function deleteSavedNLevelsPreset(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const result = await sql.query(
    `DELETE FROM n_levels_saved_presets WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
