import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';

/**
 * GET /api/admin/spend-orphans
 *
 * Read-only view of the `provider_generations` ledger filtered to
 * rows that represent wasted spend — the user was charged at the
 * provider (Replicate / Kie / Atlas / OpenAI) but the result never
 * landed in a user-visible `project_assets` row OR couldn't be
 * recovered by the hourly reconciliation cron.
 *
 * Phase 5 of the 2026-05-29 persistence-rebuild plan, follow-up
 * (corrected from the original "refund issuance" framing — this is
 * a single-user app, so the right surface is a spend-leak dashboard,
 * not a customer-refund queue).
 *
 * Query params:
 *   limit       int, default 100, max 500
 *   offset      int, default 0
 *   status      'refund_pending' | 'delivered' | 'failed' | 'all'
 *               default 'refund_pending,failed' (the actually-leaky
 *               statuses; 'delivered' rows are still in their grace
 *               window or attached and not interesting here)
 *   since_days  int, default 30 (window for the spend rollup)
 *
 * Response shape:
 *   {
 *     summary: {
 *       since_days, total_orphans, total_cost_usd,
 *       by_provider: [{ provider, count, cost_usd }],
 *       by_route:    [{ route, count, cost_usd }],
 *     },
 *     rows: [{ id, created_at, route, provider, provider_model,
 *              provider_request_id, status, failure_reason, cost_usd,
 *              project_id, row_index, slot, response_url, user_id,
 *              workspace_id }]
 *   }
 *
 * Auth: admin-only (apiRoute.admin). Same gate as the other admin
 * surfaces; the rows expose user_id / workspace_id so a non-admin
 * GET would be a cross-tenant leak.
 */
interface SpendRow {
  id: string;
  created_at: Date;
  updated_at: Date;
  route: string;
  provider: string;
  provider_model: string | null;
  provider_request_id: string | null;
  status: string;
  failure_reason: string | null;
  cost_usd: string | number | null;
  project_id: string | null;
  row_index: number | null;
  slot: string | null;
  response_url: string | null;
  user_id: string | null;
  workspace_id: string | null;
}

interface ProviderRollup { provider: string; count: string; cost_usd: string | number | null; }
interface RouteRollup    { route: string;    count: string; cost_usd: string | number | null; }

const DEFAULT_STATUSES = ['refund_pending', 'failed'];

export const GET = apiRoute.admin(async (_session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const limit  = Math.min(500, Math.max(1, Number.parseInt(searchParams.get('limit')  ?? '100', 10) || 100));
  const offset = Math.max(0, Number.parseInt(searchParams.get('offset') ?? '0',   10) || 0);
  const sinceDays = Math.min(365, Math.max(1, Number.parseInt(searchParams.get('since_days') ?? '30', 10) || 30));
  const sinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const statusParam = searchParams.get('status') ?? '';
  const statuses = statusParam === 'all'
    ? null
    : statusParam
      ? statusParam.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_STATUSES;

  // @vercel/postgres's tagged-template form doesn't bind array
  // parameters (Primitive only) — use sql.query() positional binds
  // for the ANY(...) filter when a status set is supplied.
  const statusFilterSql = statuses ? 'AND status = ANY($2::text[])' : '';
  const rowsParams: unknown[] = statuses
    ? [sinceIso, statuses, limit, offset]
    : [sinceIso, limit, offset];
  const limitPlaceholder = statuses ? '$3' : '$2';
  const offsetPlaceholder = statuses ? '$4' : '$3';

  const [rows, byProvider, byRoute] = await Promise.all([
    sql.query<SpendRow>(
      `SELECT id, created_at, updated_at, route, provider, provider_model,
              provider_request_id, status, failure_reason, cost_usd,
              project_id, row_index, slot, response_url, user_id, workspace_id
         FROM provider_generations
        WHERE created_at >= $1::timestamptz ${statusFilterSql}
        ORDER BY created_at DESC
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      rowsParams,
    ),
    sql.query<ProviderRollup>(
      `SELECT provider, COUNT(*)::text AS count, COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM provider_generations
        WHERE created_at >= $1::timestamptz ${statusFilterSql}
        GROUP BY provider
        ORDER BY SUM(COALESCE(cost_usd, 0)) DESC`,
      statuses ? [sinceIso, statuses] : [sinceIso],
    ),
    sql.query<RouteRollup>(
      `SELECT route, COUNT(*)::text AS count, COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM provider_generations
        WHERE created_at >= $1::timestamptz ${statusFilterSql}
        GROUP BY route
        ORDER BY SUM(COALESCE(cost_usd, 0)) DESC`,
      statuses ? [sinceIso, statuses] : [sinceIso],
    ),
  ]);

  const totalOrphans = rows.rows.length;
  const totalCostUsd = rows.rows.reduce(
    (sum, r) => sum + (typeof r.cost_usd === 'string' ? parseFloat(r.cost_usd) : (r.cost_usd ?? 0)),
    0,
  );

  return NextResponse.json({
    summary: {
      since_days: sinceDays,
      statuses: statuses ?? 'all',
      total_orphans: totalOrphans,
      total_cost_usd: totalCostUsd,
      by_provider: byProvider.rows.map((r) => ({
        provider: r.provider,
        count: Number(r.count) || 0,
        cost_usd: Number(r.cost_usd) || 0,
      })),
      by_route: byRoute.rows.map((r) => ({
        route: r.route,
        count: Number(r.count) || 0,
        cost_usd: Number(r.cost_usd) || 0,
      })),
    },
    rows: rows.rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      route: r.route,
      provider: r.provider,
      provider_model: r.provider_model,
      provider_request_id: r.provider_request_id,
      status: r.status,
      failure_reason: r.failure_reason,
      cost_usd: r.cost_usd === null ? null : Number(r.cost_usd),
      project_id: r.project_id,
      row_index: r.row_index,
      slot: r.slot,
      response_url: r.response_url,
      user_id: r.user_id,
      workspace_id: r.workspace_id,
    })),
  });
});
