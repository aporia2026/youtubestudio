/**
 * Workflow trigger orchestrator.
 *
 * Two halves:
 *   - `dispatchWorkflowEvent` — called by producers (concludeAbTest,
 *     runCannibalizationScan, syncVideoAnalytics, …). Loads matching
 *     rules, evaluates each rule's condition against the event payload,
 *     and creates a `workflow_action_runs` row scheduled for
 *     NOW() + delay_seconds.
 *   - `runDueActions` — called by the daily Vercel cron + by the
 *     /workflows page's "Run now" button. Picks pending action runs
 *     whose scheduled_for has passed, executes them, stamps result.
 *
 * The pure parts (condition evaluator, payload field resolver) are
 * exported for unit tests so the rule semantics can be verified
 * without booting up the executor.
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import {
  WORKFLOW_MAX_DELAY_SECONDS,
  isWorkflowActionType,
  isWorkflowTriggerEvent,
  type WorkflowActionRunRow,
  type WorkflowActionType,
  type WorkflowCondition,
  type WorkflowRuleRow,
  type WorkflowTriggerEventType,
} from './workflows-types';

export type {
  ConditionOp,
  WorkflowActionRunRow,
  WorkflowActionType,
  WorkflowCondition,
  WorkflowRuleRow,
  WorkflowTriggerEventType,
} from './workflows-types';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Resolve a dotted-path field reference against the event payload.
 *  Returns undefined when any segment is missing. */
export function resolveField(payload: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur: unknown = payload;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Recursively evaluate a condition tree against the event payload.
 *  Empty/no-op conditions ({}) always match. */
export function evaluateCondition(
  condition: WorkflowCondition,
  payload: Record<string, unknown>,
): boolean {
  if (!condition || typeof condition !== 'object') return true;

  // Combinators take priority.
  if (Array.isArray(condition.all)) {
    return condition.all.every((c) => evaluateCondition(c, payload));
  }
  if (Array.isArray(condition.any)) {
    return condition.any.length === 0 ? true : condition.any.some((c) => evaluateCondition(c, payload));
  }

  // No leaf op? Treat as "always match" — useful for rules with no condition.
  if (!condition.op || !condition.field) return true;

  const actual = resolveField(payload, condition.field);
  const expected = condition.value;

  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'in':
      return Array.isArray(expected) && (expected as Array<unknown>).some((v) => v === actual);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Dispatch (called by producers)
// ---------------------------------------------------------------------------

export interface WorkflowEvent {
  type: WorkflowTriggerEventType;
  payload: Record<string, unknown>;
}

/**
 * Match every enabled rule for the workspace + event type, evaluate
 * conditions, and create `workflow_action_runs` rows scheduled for
 * NOW() + rule.delay_seconds. Fire-and-forget — never throws into
 * the caller (producers don't want to fail on workflow plumbing).
 */
export async function dispatchWorkflowEvent(
  workspaceId: string,
  event: WorkflowEvent,
): Promise<void> {
  if (!isWorkflowTriggerEvent(event.type)) {
    logger.warn('workflows: dispatch with unknown trigger event', { type: event.type });
    return;
  }

  let rules: WorkflowRuleRow[];
  try {
    const { rows } = await sql<WorkflowRuleRow>`
      SELECT id, workspace_id, name, enabled,
             trigger_event_type, condition,
             action_type, action_config, delay_seconds,
             created_by_collaborator_id,
             created_at::text AS created_at,
             updated_at::text AS updated_at,
             last_fired_at::text AS last_fired_at,
             fire_count
        FROM workflow_rules
       WHERE workspace_id = ${workspaceId}::uuid
         AND enabled = TRUE
         AND trigger_event_type = ${event.type}
    `;
    rules = rows;
  } catch (err) {
    logger.error('workflows: failed to load rules', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (rules.length === 0) return;

  const matched = rules.filter((r) => {
    try {
      return evaluateCondition(r.condition ?? {}, event.payload);
    } catch (err) {
      logger.warn('workflows: condition eval threw, skipping rule', {
        rule_id: r.id,
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  });

  if (matched.length === 0) return;

  const payloadJson = JSON.stringify(event.payload);
  await Promise.allSettled(
    matched.map(async (rule) => {
      const delaySec = Math.max(0, Math.min(WORKFLOW_MAX_DELAY_SECONDS, rule.delay_seconds || 0));
      const scheduledAt = new Date(Date.now() + delaySec * 1000).toISOString();
      try {
        await sql`
          INSERT INTO workflow_action_runs (
            workspace_id, rule_id,
            trigger_event_type, trigger_event_payload,
            scheduled_for, status,
            action_type, action_config
          ) VALUES (
            ${workspaceId}::uuid,
            ${rule.id}::uuid,
            ${event.type},
            ${payloadJson}::jsonb,
            ${scheduledAt}::timestamptz,
            'pending',
            ${rule.action_type},
            ${JSON.stringify(rule.action_config ?? {})}::jsonb
          )
        `;
        await sql`
          UPDATE workflow_rules
             SET fire_count = fire_count + 1,
                 last_fired_at = NOW(),
                 updated_at = NOW()
           WHERE id = ${rule.id}::uuid
        `;
      } catch (err) {
        logger.warn('workflows: failed to enqueue action run', {
          rule_id: rule.id,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Action executors
// ---------------------------------------------------------------------------

interface ActionExecuteCtx {
  workspaceId: string;
  triggerPayload: Record<string, unknown>;
}

interface ActionResult {
  ok: boolean;
  detail: Record<string, unknown>;
  error?: string;
}

async function executeAction(
  actionType: string,
  actionConfig: Record<string, unknown>,
  ctx: ActionExecuteCtx,
): Promise<ActionResult> {
  if (!isWorkflowActionType(actionType)) {
    return { ok: false, detail: {}, error: `Unknown action type: ${actionType}` };
  }

  try {
    switch (actionType as WorkflowActionType) {
      case 'sync_video_analytics': {
        const videoId = (ctx.triggerPayload.video_id ?? actionConfig.video_id) as unknown;
        const channelDbId = (ctx.triggerPayload.channel_db_id ?? actionConfig.channel_db_id) as unknown;
        if (typeof videoId !== 'string' || !videoId) {
          return { ok: false, detail: {}, error: 'video_id missing from trigger payload + action config' };
        }
        if (typeof channelDbId !== 'string' || !channelDbId) {
          return { ok: false, detail: {}, error: 'channel_db_id missing from trigger payload + action config' };
        }
        // Lazy import: keeps the workflow module's surface lean and avoids
        // circular-import headaches with the analytics module.
        const { syncVideoAnalytics } = await import('./youtube-analytics');
        const channelLookup = await sql<{ channel_id: string }>`
          SELECT channel_id FROM channels
           WHERE id = ${channelDbId}::uuid AND workspace_id = ${ctx.workspaceId}::uuid
           LIMIT 1
        `;
        const youtubeChannelId = channelLookup.rows[0]?.channel_id ?? null;
        const row = await syncVideoAnalytics({
          workspaceId: ctx.workspaceId,
          channelDbId,
          scheduleItemId: null,
          youtubeChannelId,
          youtubeVideoId: videoId,
        });
        return {
          ok: true,
          detail: {
            youtube_video_id: row.youtube_video_id,
            views: row.views,
            ctr_percentage: row.ctr_percentage,
            average_view_percentage: row.average_view_percentage,
          },
        };
      }

      case 'run_dip_analysis': {
        const videoId = (ctx.triggerPayload.video_id ?? actionConfig.video_id) as unknown;
        const scriptText = actionConfig.scriptText as unknown;
        if (typeof videoId !== 'string' || !videoId) {
          return { ok: false, detail: {}, error: 'video_id missing' };
        }
        if (typeof scriptText !== 'string' || scriptText.trim().length < 200) {
          return { ok: false, detail: {}, error: 'action_config.scriptText required (min 200 chars)' };
        }
        const { analyzeRetentionDips } = await import('./fix-the-dip');
        const result = await analyzeRetentionDips({
          workspaceId: ctx.workspaceId,
          youtubeVideoId: videoId,
          scriptText,
        });
        return {
          ok: true,
          detail: { dip_analysis_id: result.id, dip_count: result.analysis.detected_dips.length },
        };
      }

      case 'run_cannibalization_scan': {
        const windowDays =
          typeof actionConfig.windowDays === 'number' && Number.isFinite(actionConfig.windowDays)
            ? Math.max(1, Math.min(30, Math.round(actionConfig.windowDays)))
            : undefined;
        const { runCannibalizationScan } = await import('./cannibalization');
        const scan = await runCannibalizationScan({ workspaceId: ctx.workspaceId, windowDays });
        return {
          ok: true,
          detail: {
            candidates: scan.candidates_considered,
            pairs_evaluated: scan.pairs_evaluated,
            alerts_created: scan.alerts_created.length,
          },
        };
      }

      case 'send_webhook_event': {
        const title = typeof actionConfig.title === 'string' ? actionConfig.title : '';
        const detail = typeof actionConfig.detail === 'string' ? actionConfig.detail : undefined;
        if (!title) return { ok: false, detail: {}, error: 'action_config.title required' };
        const { dispatchWebhookEvent } = await import('./webhooks');
        await dispatchWebhookEvent(ctx.workspaceId, {
          type: 'test',
          title,
          detail,
          fields: ctx.triggerPayload as Record<string, string | number | boolean | null>,
        });
        return { ok: true, detail: { sent: true } };
      }

      default:
        return { ok: false, detail: {}, error: `Action type ${actionType} not implemented` };
    }
  } catch (err) {
    return { ok: false, detail: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Cron picker
// ---------------------------------------------------------------------------

export interface RunDueActionsResult {
  picked: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Pick up to N pending action runs whose scheduled_for has passed,
 * execute each, stamp result. Used by the Vercel cron + by manual
 * "Run now" from the /workflows page.
 *
 * Locking: SELECT ... FOR UPDATE SKIP LOCKED would be ideal but the
 * @vercel/postgres tag template doesn't expose explicit transaction
 * control easily. We compensate with the "claim by setting status=running"
 * step: any concurrent worker that loses the race will see status='running'
 * on its next SELECT and skip.
 */
export async function runDueActions(opts: { workspaceId?: string; limit?: number } = {}): Promise<RunDueActionsResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));

  // 1. Pick candidates.
  const candidates = opts.workspaceId
    ? (await sql<WorkflowActionRunRow>`
        SELECT id, workspace_id, rule_id,
               trigger_event_type, trigger_event_payload,
               scheduled_for::text AS scheduled_for, status,
               action_type, action_config, result, error_message, attempts,
               duration_ms,
               created_at::text AS created_at,
               started_at::text AS started_at,
               completed_at::text AS completed_at
          FROM workflow_action_runs
         WHERE status = 'pending'
           AND workspace_id = ${opts.workspaceId}::uuid
           AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC
         LIMIT ${limit}
      `).rows
    : (await sql<WorkflowActionRunRow>`
        SELECT id, workspace_id, rule_id,
               trigger_event_type, trigger_event_payload,
               scheduled_for::text AS scheduled_for, status,
               action_type, action_config, result, error_message, attempts,
               duration_ms,
               created_at::text AS created_at,
               started_at::text AS started_at,
               completed_at::text AS completed_at
          FROM workflow_action_runs
         WHERE status = 'pending'
           AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC
         LIMIT ${limit}
      `).rows;

  let picked = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const run of candidates) {
    // 2. Claim — only one worker can flip pending → running.
    const claim = await sql`
      UPDATE workflow_action_runs
         SET status = 'running',
             started_at = NOW(),
             attempts = attempts + 1
       WHERE id = ${run.id}::uuid AND status = 'pending'
    `;
    if ((claim.rowCount ?? 0) === 0) continue; // someone else got it
    picked += 1;

    // 3. Execute.
    const startedAt = Date.now();
    const result = await executeAction(run.action_type, run.action_config ?? {}, {
      workspaceId: run.workspace_id,
      triggerPayload: run.trigger_event_payload ?? {},
    });
    const duration = Date.now() - startedAt;

    if (result.ok) {
      succeeded += 1;
      await sql`
        UPDATE workflow_action_runs
           SET status = 'succeeded',
               result = ${JSON.stringify(result.detail)}::jsonb,
               duration_ms = ${duration},
               completed_at = NOW()
         WHERE id = ${run.id}::uuid
      `;
    } else if (result.error?.startsWith('Unknown action type') || result.error?.startsWith('Action type ')) {
      // Unknown action types are skipped, not failed — they likely mean
      // the action was renamed/removed. Don't infinite-retry.
      skipped += 1;
      await sql`
        UPDATE workflow_action_runs
           SET status = 'skipped',
               error_message = ${result.error},
               duration_ms = ${duration},
               completed_at = NOW()
         WHERE id = ${run.id}::uuid
      `;
    } else {
      failed += 1;
      await sql`
        UPDATE workflow_action_runs
           SET status = 'failed',
               error_message = ${result.error?.slice(0, 1000) ?? 'unknown error'},
               result = ${JSON.stringify(result.detail)}::jsonb,
               duration_ms = ${duration},
               completed_at = NOW()
         WHERE id = ${run.id}::uuid
      `;
    }
  }

  return { picked, succeeded, failed, skipped };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateWorkflowRuleArgs {
  workspaceId: string;
  collaboratorId: string | null;
  name: string;
  triggerEventType: string;
  condition?: WorkflowCondition;
  actionType: string;
  actionConfig?: Record<string, unknown>;
  delaySeconds?: number;
}

export async function createWorkflowRule(args: CreateWorkflowRuleArgs): Promise<{ id: string }> {
  if (!isWorkflowTriggerEvent(args.triggerEventType)) {
    throw new Error(`Unknown trigger event: ${args.triggerEventType}`);
  }
  if (!isWorkflowActionType(args.actionType)) {
    throw new Error(`Unknown action type: ${args.actionType}`);
  }
  const name = args.name.trim().slice(0, 120) || 'Untitled rule';
  const delaySec = Math.max(0, Math.min(WORKFLOW_MAX_DELAY_SECONDS, args.delaySeconds ?? 0));
  const { rows } = await sql<{ id: string }>`
    INSERT INTO workflow_rules (
      workspace_id, name, enabled,
      trigger_event_type, condition,
      action_type, action_config, delay_seconds,
      created_by_collaborator_id
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${name},
      TRUE,
      ${args.triggerEventType},
      ${JSON.stringify(args.condition ?? {})}::jsonb,
      ${args.actionType},
      ${JSON.stringify(args.actionConfig ?? {})}::jsonb,
      ${delaySec},
      ${args.collaboratorId}::uuid
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export interface UpdateWorkflowRuleArgs {
  id: string;
  workspaceId: string;
  name?: string;
  enabled?: boolean;
  condition?: WorkflowCondition;
  actionConfig?: Record<string, unknown>;
  delaySeconds?: number;
}

export async function updateWorkflowRule(args: UpdateWorkflowRuleArgs): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (args.name !== undefined) {
    sets.push(`name = $${i++}`);
    vals.push(args.name.trim().slice(0, 120) || 'Untitled rule');
  }
  if (args.enabled !== undefined) {
    sets.push(`enabled = $${i++}`);
    vals.push(args.enabled);
  }
  if (args.condition !== undefined) {
    sets.push(`condition = $${i++}::jsonb`);
    vals.push(JSON.stringify(args.condition));
  }
  if (args.actionConfig !== undefined) {
    sets.push(`action_config = $${i++}::jsonb`);
    vals.push(JSON.stringify(args.actionConfig));
  }
  if (args.delaySeconds !== undefined) {
    sets.push(`delay_seconds = $${i++}`);
    vals.push(Math.max(0, Math.min(WORKFLOW_MAX_DELAY_SECONDS, args.delaySeconds)));
  }
  if (sets.length === 0) return true;
  sets.push(`updated_at = NOW()`);
  vals.push(args.id, args.workspaceId);
  const result = await sql.query(
    `UPDATE workflow_rules SET ${sets.join(', ')} WHERE id = $${i++}::uuid AND workspace_id = $${i}::uuid`,
    vals,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteWorkflowRule(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM workflow_rules
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}

export async function listWorkflowRules(workspaceId: string): Promise<WorkflowRuleRow[]> {
  const { rows } = await sql<WorkflowRuleRow>`
    SELECT id, workspace_id, name, enabled,
           trigger_event_type, condition,
           action_type, action_config, delay_seconds,
           created_by_collaborator_id,
           created_at::text AS created_at,
           updated_at::text AS updated_at,
           last_fired_at::text AS last_fired_at,
           fire_count
      FROM workflow_rules
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY created_at DESC
  `;
  return rows;
}

export async function listActionRuns(
  workspaceId: string,
  opts: { ruleId?: string; status?: WorkflowActionRunRow['status']; limit?: number } = {},
): Promise<WorkflowActionRunRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.ruleId && opts.status) {
    const { rows } = await sql<WorkflowActionRunRow>`
      SELECT id, workspace_id, rule_id, trigger_event_type, trigger_event_payload,
             scheduled_for::text AS scheduled_for, status,
             action_type, action_config, result, error_message, attempts,
             duration_ms,
             created_at::text AS created_at,
             started_at::text AS started_at,
             completed_at::text AS completed_at
        FROM workflow_action_runs
       WHERE workspace_id = ${workspaceId}::uuid
         AND rule_id = ${opts.ruleId}::uuid
         AND status = ${opts.status}
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.ruleId) {
    const { rows } = await sql<WorkflowActionRunRow>`
      SELECT id, workspace_id, rule_id, trigger_event_type, trigger_event_payload,
             scheduled_for::text AS scheduled_for, status,
             action_type, action_config, result, error_message, attempts,
             duration_ms,
             created_at::text AS created_at,
             started_at::text AS started_at,
             completed_at::text AS completed_at
        FROM workflow_action_runs
       WHERE workspace_id = ${workspaceId}::uuid
         AND rule_id = ${opts.ruleId}::uuid
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.status) {
    const { rows } = await sql<WorkflowActionRunRow>`
      SELECT id, workspace_id, rule_id, trigger_event_type, trigger_event_payload,
             scheduled_for::text AS scheduled_for, status,
             action_type, action_config, result, error_message, attempts,
             duration_ms,
             created_at::text AS created_at,
             started_at::text AS started_at,
             completed_at::text AS completed_at
        FROM workflow_action_runs
       WHERE workspace_id = ${workspaceId}::uuid
         AND status = ${opts.status}
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<WorkflowActionRunRow>`
    SELECT id, workspace_id, rule_id, trigger_event_type, trigger_event_payload,
           scheduled_for::text AS scheduled_for, status,
           action_type, action_config, result, error_message, attempts,
           duration_ms,
           created_at::text AS created_at,
           started_at::text AS started_at,
           completed_at::text AS completed_at
      FROM workflow_action_runs
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows;
}
