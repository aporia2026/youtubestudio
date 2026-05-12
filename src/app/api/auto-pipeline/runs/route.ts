import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  createPipelineRun,
  CreatePipelineRunError,
} from '@/lib/auto-pipeline/create-run';

/**
 * POST /api/auto-pipeline/runs
 *
 * Creates a new pipeline batch. Two mutually-exclusive modes in v1
 * (mixed mode is a deliberate v1.1 ticket):
 *
 *   - Fresh:    { presetId, countToGenerate, channelId? }
 *   - Existing: { presetId, existingIdeaIds: string[], channelId? }
 *
 * Returns `{ runId, videoIds }` on success. `videoIds` is in
 * priority order (1-indexed within the run) so the caller can
 * deep-link to "rank these ideas."
 *
 * Workspace tenancy is enforced inside `createPipelineRun` —
 * cross-workspace `presetId` or `existingIdeaIds` produce a clean
 * "not found" without leaking existence (Phase 8.1 pattern).
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const presetId = typeof b.presetId === 'string' ? b.presetId : '';
  if (!presetId) {
    return NextResponse.json({ error: 'presetId is required' }, { status: 400 });
  }

  const channelId =
    typeof b.channelId === 'string' && b.channelId.length > 0 ? b.channelId : null;
  const countToGenerate =
    typeof b.countToGenerate === 'number' && Number.isFinite(b.countToGenerate)
      ? Math.floor(b.countToGenerate)
      : undefined;
  const existingIdeaIds = Array.isArray(b.existingIdeaIds)
    ? b.existingIdeaIds.filter((x): x is string => typeof x === 'string')
    : undefined;
  const estimatedCostUsd =
    typeof b.estimatedCostUsd === 'number' && Number.isFinite(b.estimatedCostUsd)
      ? b.estimatedCostUsd
      : null;

  try {
    const result = await createPipelineRun({
      workspaceId: session.ws,
      presetId,
      channelId,
      countToGenerate,
      existingIdeaIds,
      estimatedCostUsd,
      createdBy: session.uid,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof CreatePipelineRunError) {
      // User-facing validation / not-found errors — 4xx, not 5xx.
      // The 'preset_not_found' / 'idea_not_found' codes already
      // mask cross-workspace existence per Phase 8.1.
      const status =
        err.code === 'preset_not_found' || err.code === 'idea_not_found' ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return domainErrorResponse(err, {
      op: 'auto-pipeline: create run',
      fallbackMessage: 'Failed to create pipeline run.',
    });
  }
});
