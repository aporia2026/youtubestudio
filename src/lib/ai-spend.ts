/**
 * Spend logger + aggregators.
 *
 * `logAiSpend` is the fire-and-forget writer used by `generateText` (in
 * src/lib/ai.ts) when the caller passes a `spend` context. Failure to
 * log NEVER propagates — losing a row is preferable to failing the
 * model call.
 *
 * `summarizeSpend` powers the /spend dashboard: monthly total, by
 * feature, by model, by project, last-30-day daily series.
 */
import { sql } from '@vercel/postgres';
import { computeCost, type AiProvider } from './ai-pricing';
import { logger } from './logger';
import { getSession } from './session';

/**
 * Convenience builder used by API routes that don't go through
 * `apiRoute.authed` and so don't have `session.ws` in scope. Looks up
 * the session via cookies; returns `undefined` when no session is
 * present (anonymous portal calls, system jobs).
 *
 * Usage:
 *   const raw = await generateText({
 *     ...
 *     spend: await makeSpendContext('seo_optimize', { projectId }),
 *   });
 *
 * `generateText.spend` is optional — passing undefined is the same as
 * skipping it (no log row).
 */
export async function makeSpendContext(
  featureArea: string,
  opts: { projectId?: string | null; channelDbId?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<AiSpendContext | undefined> {
  try {
    const session = await getSession();
    if (!session?.ws) return undefined;
    return {
      workspaceId: session.ws,
      projectId: opts.projectId ?? null,
      channelDbId: opts.channelDbId ?? null,
      featureArea,
      metadata: opts.metadata,
    };
  } catch {
    // Cookie parse failure / Edge runtime quirks — return undefined so
    // the caller logs nothing rather than throwing into the route.
    return undefined;
  }
}

export interface AiSpendContext {
  workspaceId: string;
  projectId?: string | null;
  channelDbId?: string | null;
  /** Free-text label for grouping. Examples: 'critic_panel',
   *  'retention_predictor', 'comment_triage', 'script_generation'. */
  featureArea: string;
  /** Optional small JSON metadata stored on the row — e.g. number of
   *  drafts in a critic panel, intent enum from comment_triage. Avoid
   *  putting prompts or full responses here; this is for audit grouping. */
  metadata?: Record<string, unknown>;
}

export interface LogAiSpendArgs {
  context: AiSpendContext;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  durationMs?: number;
}

export async function logAiSpend(args: LogAiSpendArgs): Promise<void> {
  try {
    const cost = computeCost(
      args.modelId,
      args.inputTokens,
      args.outputTokens,
      args.cachedInputTokens ?? 0,
    );
    await sql`
      INSERT INTO ai_spend_log (
        workspace_id, project_id, channel_db_id,
        feature_area, provider, model_id,
        input_tokens, output_tokens, cached_input_tokens,
        cost_usd_input, cost_usd_output, cost_usd_total,
        duration_ms, request_metadata
      ) VALUES (
        ${args.context.workspaceId}::uuid,
        ${args.context.projectId ?? null}::uuid,
        ${args.context.channelDbId ?? null}::uuid,
        ${args.context.featureArea.slice(0, 80)},
        ${cost.provider},
        ${args.modelId},
        ${args.inputTokens},
        ${args.outputTokens},
        ${args.cachedInputTokens ?? 0},
        ${cost.cost_usd_input},
        ${cost.cost_usd_output},
        ${cost.cost_usd_total},
        ${args.durationMs ?? null},
        ${JSON.stringify(args.context.metadata ?? {})}::jsonb
      )
    `;
  } catch (err) {
    logger.warn('ai-spend: failed to log row (suppressed to protect caller)', {
      detail: err instanceof Error ? err.message : String(err),
      model_id: args.modelId,
      feature_area: args.context.featureArea,
    });
  }
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

export interface SpendTotalsRow {
  workspace_total_usd: number;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  window_days: number;
}

export interface SpendByFeatureRow {
  feature_area: string;
  total_usd: number;
  calls: number;
  share_of_total: number;
}

export interface SpendByModelRow {
  model_id: string;
  provider: string;
  total_usd: number;
  calls: number;
}

export interface SpendByProjectRow {
  project_id: string | null;
  project_title: string | null;
  total_usd: number;
  calls: number;
}

export interface SpendByDayRow {
  day: string;
  total_usd: number;
  calls: number;
}

export interface SpendRecentExpensiveRow {
  id: string;
  feature_area: string;
  model_id: string;
  cost_usd_total: number;
  input_tokens: number;
  output_tokens: number;
  occurred_at: string;
}

export interface SpendSummary {
  totals: SpendTotalsRow;
  by_feature: SpendByFeatureRow[];
  by_model: SpendByModelRow[];
  by_project: SpendByProjectRow[];
  by_day: SpendByDayRow[];
  recent_expensive: SpendRecentExpensiveRow[];
  generated_at: string;
}

interface RawTotalsRow {
  total_usd: string | number | null;
  total_calls: string | number | null;
  total_input: string | number | null;
  total_output: string | number | null;
}

/**
 * Workspace-scoped spend summary across the trailing N days. Five DB
 * round-trips in parallel — small constant, fast even on cold start.
 */
export async function summarizeSpend(
  workspaceId: string,
  opts: { windowDays?: number } = {},
): Promise<SpendSummary> {
  const windowDays = Math.max(1, Math.min(opts.windowDays ?? 30, 365));
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const [totals, byFeature, byModel, byProject, byDay, recent] = await Promise.all([
    sql<RawTotalsRow>`
      SELECT
        COALESCE(SUM(cost_usd_total), 0) AS total_usd,
        COUNT(*)::text AS total_calls,
        COALESCE(SUM(input_tokens), 0)::text AS total_input,
        COALESCE(SUM(output_tokens), 0)::text AS total_output
        FROM ai_spend_log
       WHERE workspace_id = ${workspaceId}::uuid
         AND occurred_at >= ${since}::timestamptz
    `.then((r) => r.rows[0]!),

    sql<{ feature_area: string; total: string; calls: string }>`
      SELECT feature_area, SUM(cost_usd_total)::text AS total, COUNT(*)::text AS calls
        FROM ai_spend_log
       WHERE workspace_id = ${workspaceId}::uuid
         AND occurred_at >= ${since}::timestamptz
       GROUP BY feature_area
       ORDER BY SUM(cost_usd_total) DESC
       LIMIT 25
    `.then((r) => r.rows),

    sql<{ model_id: string; provider: string; total: string; calls: string }>`
      SELECT model_id, provider, SUM(cost_usd_total)::text AS total, COUNT(*)::text AS calls
        FROM ai_spend_log
       WHERE workspace_id = ${workspaceId}::uuid
         AND occurred_at >= ${since}::timestamptz
       GROUP BY model_id, provider
       ORDER BY SUM(cost_usd_total) DESC
       LIMIT 25
    `.then((r) => r.rows),

    sql<{ project_id: string | null; project_title: string | null; total: string; calls: string }>`
      SELECT s.project_id, p.title AS project_title,
             SUM(s.cost_usd_total)::text AS total,
             COUNT(*)::text AS calls
        FROM ai_spend_log s
        LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.workspace_id = ${workspaceId}::uuid
         AND s.occurred_at >= ${since}::timestamptz
       GROUP BY s.project_id, p.title
       ORDER BY SUM(s.cost_usd_total) DESC
       LIMIT 25
    `.then((r) => r.rows),

    sql<{ day: string; total: string; calls: string }>`
      SELECT to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day,
             SUM(cost_usd_total)::text AS total,
             COUNT(*)::text AS calls
        FROM ai_spend_log
       WHERE workspace_id = ${workspaceId}::uuid
         AND occurred_at >= ${since}::timestamptz
       GROUP BY date_trunc('day', occurred_at)
       ORDER BY day ASC
    `.then((r) => r.rows),

    sql<{
      id: string;
      feature_area: string;
      model_id: string;
      cost_usd_total: string;
      input_tokens: string;
      output_tokens: string;
      occurred_at: string;
    }>`
      SELECT id, feature_area, model_id, cost_usd_total,
             input_tokens, output_tokens,
             occurred_at::text AS occurred_at
        FROM ai_spend_log
       WHERE workspace_id = ${workspaceId}::uuid
         AND occurred_at >= ${since}::timestamptz
       ORDER BY cost_usd_total DESC
       LIMIT 10
    `.then((r) => r.rows),
  ]);

  const totalUsd = Number(totals.total_usd) || 0;
  const totalCalls = Number(totals.total_calls) || 0;

  return {
    totals: {
      workspace_total_usd: totalUsd,
      total_calls: totalCalls,
      total_input_tokens: Number(totals.total_input) || 0,
      total_output_tokens: Number(totals.total_output) || 0,
      window_days: windowDays,
    },
    by_feature: byFeature.map((r) => ({
      feature_area: r.feature_area,
      total_usd: Number(r.total) || 0,
      calls: Number(r.calls) || 0,
      share_of_total: totalUsd > 0 ? (Number(r.total) || 0) / totalUsd : 0,
    })),
    by_model: byModel.map((r) => ({
      model_id: r.model_id,
      provider: r.provider as AiProvider,
      total_usd: Number(r.total) || 0,
      calls: Number(r.calls) || 0,
    })),
    by_project: byProject.map((r) => ({
      project_id: r.project_id,
      project_title: r.project_title,
      total_usd: Number(r.total) || 0,
      calls: Number(r.calls) || 0,
    })),
    by_day: byDay.map((r) => ({
      day: r.day,
      total_usd: Number(r.total) || 0,
      calls: Number(r.calls) || 0,
    })),
    recent_expensive: recent.map((r) => ({
      id: r.id,
      feature_area: r.feature_area,
      model_id: r.model_id,
      cost_usd_total: Number(r.cost_usd_total) || 0,
      input_tokens: Number(r.input_tokens) || 0,
      output_tokens: Number(r.output_tokens) || 0,
      occurred_at: r.occurred_at,
    })),
    generated_at: new Date().toISOString(),
  };
}
