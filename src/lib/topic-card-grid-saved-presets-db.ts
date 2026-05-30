/**
 * Workspace-scoped saved style presets for the Topic Card Grid format
 * — CRUD library.
 *
 * Server-only. Backs the Phase 4d "Saved presets" feature on the Topic
 * Card Grid panel. Mirrors the shape of the sibling
 * `flex-icon-grid-saved-templates-db.ts` so the route handlers follow
 * the same workspace-tenancy contract. Validation is shared with the
 * N Levels sibling via `thumbnail-saved-presets-validate.ts`.
 *
 * Stored on `topic_card_grid_saved_presets` (migration 0105):
 *   - name (workspace-unique)
 *   - preset_jsonb (postProcess + titleBar style envelope)
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

export interface SavedTopicCardGridPreset {
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

export async function listSavedTopicCardGridPresets(
  workspaceId: string,
): Promise<SavedTopicCardGridPreset[]> {
  const { rows } = await sql.query<SavedTopicCardGridPreset>(
    `
    SELECT ${ROW_SHAPE}
      FROM topic_card_grid_saved_presets
     WHERE workspace_id = $1::uuid
     ORDER BY updated_at DESC
    `,
    [workspaceId],
  );
  return rows;
}

export async function getSavedTopicCardGridPreset(
  id: string,
  workspaceId: string,
): Promise<SavedTopicCardGridPreset | null> {
  const { rows } = await sql.query<SavedTopicCardGridPreset>(
    `
    SELECT ${ROW_SHAPE}
      FROM topic_card_grid_saved_presets
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [id, workspaceId],
  );
  return rows.length === 0 ? null : rows[0];
}

export async function createSavedTopicCardGridPreset(args: {
  workspaceId: string;
  createdBy: string | null;
  input: SavedPresetInput;
}): Promise<SavedTopicCardGridPreset> {
  const { workspaceId, createdBy, input } = args;
  const { rows } = await sql.query<SavedTopicCardGridPreset>(
    `
    INSERT INTO topic_card_grid_saved_presets
      (workspace_id, name, preset_jsonb, created_by)
    VALUES ($1::uuid, $2, $3::jsonb, $4::uuid)
    RETURNING ${ROW_SHAPE}
    `,
    [workspaceId, input.name, JSON.stringify(input.preset), createdBy],
  );
  return rows[0];
}

export async function deleteSavedTopicCardGridPreset(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const result = await sql.query(
    `DELETE FROM topic_card_grid_saved_presets WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
