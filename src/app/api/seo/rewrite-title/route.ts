import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { sql } from '@vercel/postgres';
import {
  getLatestSearchTerms,
  scoreSeoOpportunities,
  suggestTitleRewrite,
} from '@/lib/search-terms';

/**
 * POST /api/seo/rewrite-title
 * Body: { youtubeVideoId, currentTitle, projectId? }
 *
 * Phase 9.3 — AI rewrites the title to capture missed search demand.
 * Pulls the latest search-term snapshot for the video, scores
 * opportunities, and asks the workspace's configured model for a
 * targeted rewrite. Returns null when there are no opportunities
 * (CTR is at or above baseline across every tracked query).
 *
 * Cost: one Claude/GPT call. Goes through the spend log via the
 * `seo_title_rewrite` feature area.
 */
export const maxDuration = 60;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const youtubeVideoId =
    typeof b.youtubeVideoId === 'string' ? b.youtubeVideoId.trim() : '';
  const currentTitle =
    typeof b.currentTitle === 'string' ? b.currentTitle.trim() : '';
  const projectId =
    typeof b.projectId === 'string' && b.projectId ? b.projectId : null;
  if (!youtubeVideoId) {
    return NextResponse.json({ error: 'youtubeVideoId is required' }, { status: 400 });
  }
  if (!currentTitle) {
    return NextResponse.json({ error: 'currentTitle is required' }, { status: 400 });
  }

  try {
    // Tenant-scope check: the video_analytics row must belong to this
    // workspace. Same as /api/seo/opportunities.
    const ownerCheck = await sql<{ channel_id: string | null }>`
      SELECT channel_id FROM video_analytics
       WHERE workspace_id     = ${session.ws}::uuid
         AND youtube_video_id = ${youtubeVideoId}
       LIMIT 1
    `;
    if (ownerCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Video not found in this workspace' }, { status: 404 });
    }
    const channelDbId = ownerCheck.rows[0]!.channel_id;

    const rows = await getLatestSearchTerms(session.ws, youtubeVideoId);
    const usable = rows
      .filter(
        (r): r is typeof r & {
          impressions: number;
          views: number;
          ctr_percentage: number;
        } =>
          typeof r.impressions === 'number' &&
          typeof r.views === 'number' &&
          typeof r.ctr_percentage === 'number',
      )
      .map((r) => ({
        search_term: r.search_term,
        impressions: r.impressions,
        views: r.views,
        ctr_percentage: r.ctr_percentage,
      }));
    const opportunities = scoreSeoOpportunities(usable);
    if (opportunities.length === 0) {
      return NextResponse.json({
        suggestion: null,
        reason: 'No underperforming queries — CTR is at or above baseline across every tracked query.',
      });
    }

    const suggestion = await suggestTitleRewrite({
      workspaceId: session.ws,
      projectId,
      channelDbId,
      currentTitle,
      opportunities,
    });
    return NextResponse.json({ suggestion, opportunities });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'seo: rewrite-title',
      fallbackMessage: 'Could not generate a title rewrite — please try again.',
    });
  }
});
