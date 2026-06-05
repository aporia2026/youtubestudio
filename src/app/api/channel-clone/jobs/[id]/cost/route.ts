/**
 * GET /api/channel-clone/jobs/[id]/cost
 *
 * Aggregated LLM spend for a single channel-clone job. Filters
 * `ai_spend_log` by workspace + feature_area LIKE 'channel_clone%'
 * + the JSONB metadata's jobId, summing across all stages.
 *
 * Used by the panel's cost summary so the user knows what each
 * full run actually cost on Opus 4.8 — useful before deciding to
 * iterate further on a job or scrap it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, type RouteContext } from '@/lib/route-helpers';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';

export const maxDuration = 10;

type Params = { id: string };

export const GET = apiRoute.authed(async (session, _req: NextRequest, ctx: RouteContext<Params>) => {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: 'job id is required' }, { status: 400 });
  }
  // Confirm the job exists in this workspace — otherwise a stranger
  // could probe for any UUID and learn its spend via timing.
  const job = await getChannelCloneJob(id, session.ws);
  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }

  // Aggregate by feature_area so the UI can show per-stage breakdown.
  // The runners all stamp `jobId` into request_metadata, so the JSONB
  // path filter is the load-bearing predicate. feature_area LIKE
  // narrows to channel_clone_* rows for index-friendliness.
  const { rows: perStage } = await sql.query<{
    feature_area: string;
    total: string;
    calls: string;
    input_tokens: string;
    output_tokens: string;
  }>(
    `
    SELECT feature_area,
           SUM(cost_usd_total)::text AS total,
           COUNT(*)::text AS calls,
           SUM(input_tokens)::text  AS input_tokens,
           SUM(output_tokens)::text AS output_tokens
      FROM ai_spend_log
     WHERE workspace_id = $1::uuid
       AND feature_area LIKE 'channel_clone%'
       AND request_metadata->>'jobId' = $2
     GROUP BY feature_area
     ORDER BY SUM(cost_usd_total) DESC
    `,
    [session.ws, id],
  );

  const totals = perStage.reduce(
    (acc, r) => {
      acc.totalUsd += Number(r.total);
      acc.calls += Number(r.calls);
      acc.inputTokens += Number(r.input_tokens);
      acc.outputTokens += Number(r.output_tokens);
      return acc;
    },
    { totalUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0 },
  );

  return NextResponse.json({
    jobId: id,
    perStage: perStage.map((r) => ({
      featureArea: r.feature_area,
      totalUsd: Number(r.total),
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
    })),
    totals,
  });
});
