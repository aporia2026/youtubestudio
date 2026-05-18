import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getAnalysisById } from '@/lib/analyzer/db';
import { ANALYZER_VERSION, PROMPT_VERSION } from '@/lib/analyzer/types';

/**
 * Deep YouTube video analyzer — GET by analysis id.
 *
 * Two consumers:
 *   1. The /analyze/[id] page polls this while a POST is in flight,
 *      so the result view can switch from "Analyzing..." to "Done"
 *      without the client holding the original POST connection
 *      open. Polling cadence is ~5s; the page stops polling once
 *      `stage` is terminal.
 *   2. The recent-analyses list links to here for read-back.
 *
 * Returns 404 on cross-workspace access (the existence of resources
 * in other workspaces must not be disclosed — matches the
 * 404-not-403 pattern in src/app/api/competitors/[id]/...).
 */
export const GET = apiRoute.authed(
  async (
    session,
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id } = await params;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'analysis id required' }, { status: 400 });
    }

    const row = await getAnalysisById({ workspaceId: session.ws, analysisId: id });
    if (!row) {
      return NextResponse.json({ error: 'Analysis not found' }, { status: 404 });
    }

    // Flag the row as stale when it was produced under an older
    // (analyzer_version, prompt_version) pair than the current one.
    // The UI can show a "Re-analyze with newer model" hint without
    // forcing a refresh.
    const stale =
      row.analyzer_version !== ANALYZER_VERSION ||
      row.prompt_version !== PROMPT_VERSION;

    return NextResponse.json({
      id: row.id,
      videoId: row.video_id,
      videoUrl: row.video_url,
      videoTitle: row.video_title,
      channelTitle: row.channel_title,
      modelId: row.model_id,
      analyzerVersion: row.analyzer_version,
      promptVersion: row.prompt_version,
      stage: row.stage,
      failureReason: row.failure_reason,
      result: row.result_jsonb,
      stale,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    });
  },
);
