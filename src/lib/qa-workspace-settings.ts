/**
 * Workspace-level QA settings (currently: which model to use for
 * nuclear-mode critic drafts + deliberation, Lever D of the QA hardening
 * plan).
 *
 * Stored in `workspace_model_defaults` under scope `qa_nuclear_model`.
 * Reusing the existing table (added in migration 0034) means no schema
 * migration is needed: the scope column is freeform TEXT precisely so
 * new use cases like this can land without touching the schema.
 *
 * The setting is the SINGLE source of truth — no env var fallback. If
 * the workspace has not picked a model, nuclear-mode passes use the
 * caller's modelId (no upgrade). The UI's first dropdown option is
 * "no upgrade" which corresponds to having no row in the table.
 *
 * Validation: the resolver re-checks the saved id against AI_MODELS at
 * load time. A saved id that has been removed from the catalogue is
 * treated as "no upgrade" and a warning is logged. This way a model
 * removal in code can't silently break QA in production.
 */
import { sql } from '@vercel/postgres';
import { getModelById } from './ai-models';
import { logger } from './logger';

const SCOPE_NUCLEAR_MODEL = 'qa_nuclear_model';
/** Second scope on the same table — repurposed for a non-model setting
 *  by encoding the hours as the "model_id" text. workspace_model_defaults
 *  has a freeform model_id TEXT column, no migration needed to extend. */
const SCOPE_STUCK_HOURS = 'qa_stuck_hours';
const DEFAULT_STUCK_HOURS = 48;

export interface WorkspaceQaSettings {
  /** Model id the workspace has chosen for nuclear-mode critic passes,
   *  or null when the workspace has not chosen one (no upgrade). */
  nuclearModelId: string | null;
  /** Hours after which a video that has not moved stage shows up in
   *  the Command Center's Stuck panel. Defaults to 48 when unset. */
  stuckThresholdHours: number;
}

/**
 * Load the workspace's QA settings. Returns `{ nuclearModelId: null }`
 * when no preference is saved, which the runner treats as "no upgrade."
 *
 * The returned model id is guaranteed to be present in AI_MODELS — a
 * saved id that has since been removed from the catalogue is logged
 * and surfaced as null.
 */
export async function getWorkspaceQaSettings(workspaceId: string): Promise<WorkspaceQaSettings> {
  // One query covers both scopes — workspace_model_defaults is indexed
  // on workspace_id so this stays cheap even if more scopes are added
  // here later.
  const result = await sql<{ scope: string; model_id: string }>`
    SELECT scope, model_id
      FROM workspace_model_defaults
     WHERE workspace_id = ${workspaceId}::uuid
       AND scope = ANY(ARRAY[${SCOPE_NUCLEAR_MODEL}, ${SCOPE_STUCK_HOURS}]::text[])
  `;
  let nuclearModelId: string | null = null;
  let stuckThresholdHours = DEFAULT_STUCK_HOURS;
  for (const row of result.rows) {
    if (row.scope === SCOPE_NUCLEAR_MODEL) {
      if (row.model_id && getModelById(row.model_id)) {
        nuclearModelId = row.model_id;
      } else if (row.model_id) {
        logger.warn('[qa workspace-settings] saved nuclear-model id not in AI_MODELS — ignoring', {
          workspace_id: workspaceId,
          saved_model_id: row.model_id,
        });
      }
    } else if (row.scope === SCOPE_STUCK_HOURS) {
      const parsed = Number(row.model_id);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 720) {
        stuckThresholdHours = Math.round(parsed);
      }
    }
  }
  return { nuclearModelId, stuckThresholdHours };
}

/**
 * Set or clear the workspace's nuclear-mode model preference. Pass
 * `null` to clear (matches the UI's "no upgrade" option).
 *
 * Validation: a non-null modelId must resolve via getModelById. Invalid
 * ids are rejected with an Error so the API route returns 400 instead
 * of silently persisting a junk value.
 */
export async function setWorkspaceNuclearModel(
  workspaceId: string,
  modelId: string | null,
): Promise<WorkspaceQaSettings> {
  if (modelId !== null) {
    if (!getModelById(modelId)) {
      throw new Error(`Unknown model id: "${modelId}". Must be one of the ids in src/lib/ai-models.ts.`);
    }
    await sql`
      INSERT INTO workspace_model_defaults (workspace_id, scope, model_id, updated_at)
      VALUES (${workspaceId}::uuid, ${SCOPE_NUCLEAR_MODEL}, ${modelId}, NOW())
      ON CONFLICT (workspace_id, scope) DO UPDATE
        SET model_id = EXCLUDED.model_id,
            updated_at = NOW()
    `;
    logger.info('[qa workspace-settings] nuclear-model set', {
      workspace_id: workspaceId,
      model_id: modelId,
    });
  } else {
    await sql`
      DELETE FROM workspace_model_defaults
       WHERE workspace_id = ${workspaceId}::uuid
         AND scope = ${SCOPE_NUCLEAR_MODEL}
    `;
    logger.info('[qa workspace-settings] nuclear-model cleared (no upgrade)', {
      workspace_id: workspaceId,
    });
  }
  return getWorkspaceQaSettings(workspaceId);
}

/**
 * Set or clear the workspace's stuck-threshold (Command Center setting).
 * Hours must be between 1 and 720 (a month) — anything outside that range
 * is rejected with an Error so a typo in the UI doesn't persist garbage.
 * Pass `null` to clear and return to the default (48h).
 */
export async function setWorkspaceStuckHours(
  workspaceId: string,
  hours: number | null,
): Promise<WorkspaceQaSettings> {
  if (hours !== null) {
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      throw new Error('Stuck threshold must be between 1 and 720 hours.');
    }
    const rounded = Math.round(hours);
    await sql`
      INSERT INTO workspace_model_defaults (workspace_id, scope, model_id, updated_at)
      VALUES (${workspaceId}::uuid, ${SCOPE_STUCK_HOURS}, ${String(rounded)}, NOW())
      ON CONFLICT (workspace_id, scope) DO UPDATE
        SET model_id = EXCLUDED.model_id,
            updated_at = NOW()
    `;
    logger.info('[qa workspace-settings] stuck-hours set', {
      workspace_id: workspaceId,
      hours: rounded,
    });
  } else {
    await sql`
      DELETE FROM workspace_model_defaults
       WHERE workspace_id = ${workspaceId}::uuid
         AND scope = ${SCOPE_STUCK_HOURS}
    `;
    logger.info('[qa workspace-settings] stuck-hours cleared (back to default)', {
      workspace_id: workspaceId,
    });
  }
  return getWorkspaceQaSettings(workspaceId);
}
