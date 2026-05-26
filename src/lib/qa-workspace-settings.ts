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
/** Prefix for per-stage WIP limit scopes. The full scope id is
 *  'qa_wip_limit_<stageId>' (e.g. 'qa_wip_limit_qa'). */
const SCOPE_WIP_PREFIX = 'qa_wip_limit_';
/** Scopes that repurpose the freeform model_id TEXT column to carry
 *  non-model settings. The column is TEXT so we encode booleans as
 *  'on' / 'off' and numbers as their stringified form. */
const SCOPE_STUCK_HOURS = 'qa_stuck_hours';
const SCOPE_PRE_CHECK = 'qa_pre_check_enabled';
const SCOPE_RUBRIC_V2 = 'qa_rubric_v2_enabled';
const SCOPE_GENERATOR_V2 = 'qa_generator_v2_enabled';
const DEFAULT_STUCK_HOURS = 48;

/**
 * Tri-state for each QA toggle:
 *   'on'        — workspace explicitly turned it on (overrides env).
 *   'off'       — workspace explicitly turned it off (overrides env).
 *   'inherit'   — no row stored; the env var (if any) decides.
 *
 * This lets a workspace opt out even when the env flag is set globally.
 */
export type QaToggleState = 'on' | 'off' | 'inherit';

export interface WorkspaceQaSettings {
  /** Model id the workspace has chosen for nuclear-mode critic passes,
   *  or null when the workspace has not chosen one (no upgrade). */
  nuclearModelId: string | null;
  /** Hours after which a video that has not moved stage shows up in
   *  the Command Center's Stuck panel. Defaults to 48 when unset. */
  stuckThresholdHours: number;
  /** Per-workspace overrides for the QA hardening levers. 'inherit'
   *  means "use whatever the env flag says." */
  preCheck: QaToggleState;
  rubricV2: QaToggleState;
  generatorV2: QaToggleState;
  /** Soft WIP limit per stage. A stage with a number set here shows a
   *  warning in the kanban when its column count exceeds the limit.
   *  Stages not in the map are unlimited. */
  wipLimits: Record<string, number>;
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
  // One query covers every scope — workspace_model_defaults is indexed
  // on workspace_id so this stays cheap.
  // Pull every scope this workspace has: fixed scopes + any per-stage
  // WIP limit scopes that share the qa_wip_limit_ prefix. One query.
  const result = await sql.query<{ scope: string; model_id: string }>(
    `
    SELECT scope, model_id
      FROM workspace_model_defaults
     WHERE workspace_id = $1::uuid
       AND (
         scope = ANY($2::text[])
         OR scope LIKE $3
       )
    `,
    [
      workspaceId,
      [SCOPE_NUCLEAR_MODEL, SCOPE_STUCK_HOURS, SCOPE_PRE_CHECK, SCOPE_RUBRIC_V2, SCOPE_GENERATOR_V2],
      `${SCOPE_WIP_PREFIX}%`,
    ],
  );
  let nuclearModelId: string | null = null;
  let stuckThresholdHours = DEFAULT_STUCK_HOURS;
  let preCheck: QaToggleState = 'inherit';
  let rubricV2: QaToggleState = 'inherit';
  let generatorV2: QaToggleState = 'inherit';
  const wipLimits: Record<string, number> = {};
  for (const row of result.rows) {
    if (row.scope.startsWith(SCOPE_WIP_PREFIX)) {
      const stageId = row.scope.slice(SCOPE_WIP_PREFIX.length);
      const limit = Number(row.model_id);
      if (Number.isFinite(limit) && limit >= 1 && limit <= 1000) {
        wipLimits[stageId] = Math.round(limit);
      }
      continue;
    }
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
    } else if (row.scope === SCOPE_PRE_CHECK) {
      preCheck = parseToggle(row.model_id);
    } else if (row.scope === SCOPE_RUBRIC_V2) {
      rubricV2 = parseToggle(row.model_id);
    } else if (row.scope === SCOPE_GENERATOR_V2) {
      generatorV2 = parseToggle(row.model_id);
    }
  }
  return { nuclearModelId, stuckThresholdHours, preCheck, rubricV2, generatorV2, wipLimits };
}

/**
 * Set a per-stage WIP limit. Pass null to clear it. The stage id is
 * a VideoStageId (validated by the caller; this helper trusts the input).
 */
export async function setWorkspaceWipLimit(
  workspaceId: string,
  stageId: string,
  limit: number | null,
): Promise<WorkspaceQaSettings> {
  const scope = `${SCOPE_WIP_PREFIX}${stageId}`;
  if (limit === null) {
    await sql`
      DELETE FROM workspace_model_defaults
       WHERE workspace_id = ${workspaceId}::uuid
         AND scope = ${scope}
    `;
  } else {
    if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
      throw new Error('WIP limit must be between 1 and 1000.');
    }
    const rounded = Math.round(limit);
    await sql`
      INSERT INTO workspace_model_defaults (workspace_id, scope, model_id, updated_at)
      VALUES (${workspaceId}::uuid, ${scope}, ${String(rounded)}, NOW())
      ON CONFLICT (workspace_id, scope) DO UPDATE
        SET model_id = EXCLUDED.model_id,
            updated_at = NOW()
    `;
  }
  return getWorkspaceQaSettings(workspaceId);
}

function parseToggle(s: string | null | undefined): QaToggleState {
  if (s === 'on' || s === 'off') return s;
  return 'inherit';
}

/**
 * Resolve a tri-state toggle against the env-var default. The
 * workspace-level setting takes precedence; 'inherit' falls back to
 * the env flag. Use this in code paths that check whether a lever is
 * active for a given workspace.
 */
export function resolveToggle(state: QaToggleState, envEnabled: boolean): boolean {
  if (state === 'on') return true;
  if (state === 'off') return false;
  return envEnabled;
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
 * Set a tri-state toggle (preCheck / rubricV2 / generatorV2). Pass
 * 'inherit' to delete the row (back to env-var default).
 */
export async function setWorkspaceToggle(
  workspaceId: string,
  flag: 'preCheck' | 'rubricV2' | 'generatorV2',
  state: QaToggleState,
): Promise<WorkspaceQaSettings> {
  const scope =
    flag === 'preCheck'
      ? SCOPE_PRE_CHECK
      : flag === 'rubricV2'
        ? SCOPE_RUBRIC_V2
        : SCOPE_GENERATOR_V2;

  if (state === 'inherit') {
    await sql`
      DELETE FROM workspace_model_defaults
       WHERE workspace_id = ${workspaceId}::uuid
         AND scope = ${scope}
    `;
    logger.info('[qa workspace-settings] toggle cleared (inherit env)', {
      workspace_id: workspaceId,
      flag,
    });
  } else {
    await sql`
      INSERT INTO workspace_model_defaults (workspace_id, scope, model_id, updated_at)
      VALUES (${workspaceId}::uuid, ${scope}, ${state}, NOW())
      ON CONFLICT (workspace_id, scope) DO UPDATE
        SET model_id = EXCLUDED.model_id,
            updated_at = NOW()
    `;
    logger.info('[qa workspace-settings] toggle set', {
      workspace_id: workspaceId,
      flag,
      state,
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
