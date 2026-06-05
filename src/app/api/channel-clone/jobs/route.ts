/**
 * GET /api/channel-clone/jobs
 *
 * List the workspace's recent channel-clone jobs, newest-first.
 * Used by the standalone /channel-clone landing page to show a
 * "resume an existing run" gallery alongside the new-job form.
 *
 * Response shape mirrors the other list-endpoints in the repo
 * (/api/ab-tests returns `{ tests: [...] }`, /api/auto-pipeline/runs
 * returns `{ runs: [...] }`, etc.).
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { listChannelCloneJobs } from '@/lib/channel-clone/job-store';

export const maxDuration = 10;

export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50));
  const rows = await listChannelCloneJobs(session.ws, limit);
  // Trim the heavy state payload — the list view only needs a
  // summary. The per-job detail endpoint returns the full state.
  const jobs = rows.map((r) => ({
    id: r.id,
    sourceChannelUrl: r.source_channel_url,
    sourceCanonicalUrl: r.source_canonical_url,
    status: r.status,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    summary: {
      hasIntake: !!r.state_jsonb.intake,
      hasAnalysis: !!r.state_jsonb.analysis,
      topicCount: r.state_jsonb.topics?.length ?? 0,
      hookCount: r.state_jsonb.hooks?.length ?? 0,
      approvedScriptWords: r.state_jsonb.approvedScript?.wordCount ?? null,
      auditFinalScore: r.state_jsonb.approvedScript?.finalScore ?? null,
      rowCount: r.state_jsonb.productionRows?.length ?? 0,
      hasPublishPack: !!r.state_jsonb.publishPack,
      handoffPipelineRunVideoId: r.state_jsonb.handoff?.pipelineRunVideoId ?? null,
      sourceChannelName: r.state_jsonb.intake?.sourceChannelName ?? null,
    },
  }));
  return NextResponse.json({ jobs });
});
