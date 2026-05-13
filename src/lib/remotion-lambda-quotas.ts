/**
 * Spend + concurrency caps for the Lambda render backend.
 *
 * Phase 5 of `_plans/2026-05-13-lambda-render-migration.md`. CLAUDE.md
 * rule 8: any feature with cost implications gets explicit guardrails.
 *
 * Three caps, all driven by env so they're tunable without a deploy:
 *
 *   LAMBDA_MAX_SPEND_USD_PER_DAY     — pre-flight. Refuse a new render
 *                                      if the rolling-24h total spend
 *                                      already meets the cap.
 *   LAMBDA_MAX_SPEND_USD_PER_RENDER  — runtime. Abort an in-flight
 *                                      render when its accrued cost
 *                                      exceeds this. Catches misbehaving
 *                                      configs (e.g. accidental 4-hour
 *                                      composition) before they drain
 *                                      the daily cap solo.
 *   LAMBDA_MAX_CONCURRENT_RENDERS    — pre-flight. Refuse if there are
 *                                      already N renders in flight.
 *
 * All caps fail-open in the loose sense: if the env var is missing or
 * unparseable, the default applies (we don't refuse to start because of
 * a typo). But they fail-closed if the DB query fails — losing the
 * ability to count current spend is treated as "treat as at-cap" so a
 * DB outage doesn't accidentally bypass the budget.
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { deleteLambdaRender } from './remotion-lambda';

// ─── Env-driven caps ──────────────────────────────────────────────────────────

const DEFAULTS = {
  maxSpendUsdPerDay: 5,
  maxSpendUsdPerRender: 1,
  maxConcurrentRenders: 5,
} as const;

export interface LambdaQuotas {
  maxSpendUsdPerDay: number;
  maxSpendUsdPerRender: number;
  maxConcurrentRenders: number;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getLambdaQuotas(): LambdaQuotas {
  return {
    maxSpendUsdPerDay: parsePositiveNumber(
      process.env.LAMBDA_MAX_SPEND_USD_PER_DAY,
      DEFAULTS.maxSpendUsdPerDay,
    ),
    maxSpendUsdPerRender: parsePositiveNumber(
      process.env.LAMBDA_MAX_SPEND_USD_PER_RENDER,
      DEFAULTS.maxSpendUsdPerRender,
    ),
    maxConcurrentRenders: parsePositiveInt(
      process.env.LAMBDA_MAX_CONCURRENT_RENDERS,
      DEFAULTS.maxConcurrentRenders,
    ),
  };
}

// ─── Pre-flight check (before POST kicks off a render) ────────────────────────

export type PreflightDecision =
  | { ok: true }
  | { ok: false; reason: string; retryAfterSeconds: number };

/**
 * Look at the current state of `render_jobs` and decide whether a new
 * Lambda render is allowed. Two caps consulted:
 *  - rolling 24h spend across all Lambda renders
 *  - count of in-flight Lambda renders
 *
 * Per the module-level note: a DB error returns `{ ok: false }`. We
 * would rather a creator sees "try again in a moment" than risk an
 * uncapped runaway when the budget table can't be read.
 */
export async function preflightLambdaQuota(): Promise<PreflightDecision> {
  const quotas = getLambdaQuotas();
  const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;

  let spendRows: { sum: number | null }[];
  let concurrentRows: { count: string }[];
  try {
    const [spendResult, concurrentResult] = await Promise.all([
      sql<{ sum: number | null }>`
        SELECT COALESCE(SUM(estimated_cost), 0)::float8 AS sum
        FROM render_jobs
        WHERE lambda_render_id IS NOT NULL
          AND started_at >= ${dayAgoMs}
      `,
      sql<{ count: string }>`
        SELECT COUNT(*)::text AS count
        FROM render_jobs
        WHERE lambda_render_id IS NOT NULL
          AND status = 'rendering'
      `,
    ]);
    spendRows = spendResult.rows;
    concurrentRows = concurrentResult.rows;
  } catch (err) {
    logger.error('[render] Lambda quota preflight DB read failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: 'Render budget check temporarily unavailable. Try again in a minute.',
      retryAfterSeconds: 60,
    };
  }

  const dailySpend = spendRows[0]?.sum ?? 0;
  const concurrent = Number(concurrentRows[0]?.count ?? '0');

  if (dailySpend >= quotas.maxSpendUsdPerDay) {
    return {
      ok: false,
      reason:
        `Daily render budget reached ($${dailySpend.toFixed(2)} of $${quotas.maxSpendUsdPerDay.toFixed(2)}). ` +
        `Renders resume automatically once the 24-hour rolling window drops below cap.`,
      retryAfterSeconds: 60 * 30,
    };
  }
  if (concurrent >= quotas.maxConcurrentRenders) {
    return {
      ok: false,
      reason:
        `Already ${concurrent} renders in flight (cap ${quotas.maxConcurrentRenders}). ` +
        `Wait for one to finish.`,
      retryAfterSeconds: 60,
    };
  }

  return { ok: true };
}

// ─── Runtime check (called by the GET poll on every refresh) ──────────────────

export interface PerRenderKillDecision {
  shouldKill: boolean;
  reason: string | null;
}

/**
 * Pure helper. Given the current accrued cost of a render and the
 * per-render cap, decide whether to abort. Exposed separately from the
 * killer so the route can early-out without touching Lambda when the
 * answer is "no".
 */
export function shouldKillForOverspend(
  costAccrued: number,
  quotas: LambdaQuotas = getLambdaQuotas(),
): PerRenderKillDecision {
  if (costAccrued >= quotas.maxSpendUsdPerRender) {
    return {
      shouldKill: true,
      reason:
        `Render exceeded per-render cap ($${costAccrued.toFixed(3)} ≥ ` +
        `$${quotas.maxSpendUsdPerRender.toFixed(2)}). Aborted to protect the daily budget.`,
    };
  }
  return { shouldKill: false, reason: null };
}

/**
 * Abort an in-flight Lambda render that exceeded the per-render cap.
 * Best-effort: a `deleteRender` failure is logged but never thrown,
 * because the cap is already enforced at the DB level (the row will be
 * marked 'error' by the caller) — leaving an orphan render in S3 is
 * preferable to a thrown error breaking the GET response path.
 */
export async function killOverspendingRender(params: {
  lambdaRenderId: string;
  bucketName: string;
}): Promise<void> {
  try {
    await deleteLambdaRender(params);
  } catch (err) {
    logger.warn('[render] Failed to delete over-budget Lambda render', {
      renderId: params.lambdaRenderId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
