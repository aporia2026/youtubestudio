import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  getLatestSearchTerms,
  scoreSeoOpportunities,
} from '@/lib/search-terms';
import { sql } from '@vercel/postgres';

/**
 * GET /api/seo/opportunities?youtubeVideoId=xyz
 *
 * Phase 9.3 — returns scored SEO opportunities for one of the
 * workspace's videos. The youtube_video_id must belong to a
 * video_analytics row in this workspace (tenant-scoped via that
 * row's workspace_id).
 *
 * Optionally ?baselineCtr=N to override the default 5%. Useful when
 * the channel runs above-baseline overall and we want to surface only
 * the relative laggers.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const youtubeVideoId = searchParams.get('youtubeVideoId')?.trim();
  if (!youtubeVideoId) {
    return NextResponse.json({ error: 'youtubeVideoId is required' }, { status: 400 });
  }

  try {
    // Tenant-scope check: the video_analytics row must exist for this
    // workspace. assertOwnsResource doesn't fit (the table's PK is
    // composite), so a small explicit check.
    const ownerCheck = await sql`
      SELECT 1 FROM video_analytics
       WHERE workspace_id     = ${session.ws}::uuid
         AND youtube_video_id = ${youtubeVideoId}
       LIMIT 1
    `;
    if (ownerCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Video not found in this workspace' }, { status: 404 });
    }

    const baselineCtrRaw = searchParams.get('baselineCtr');
    const baselineCtr = baselineCtrRaw ? Number(baselineCtrRaw) : undefined;

    const rows = await getLatestSearchTerms(session.ws, youtubeVideoId);
    // SearchTermRow allows null on every metric (DB nullable); the
    // scorer wants non-null. Filter the few rows with missing data.
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
    const opportunities = scoreSeoOpportunities(usable, {
      baselineCtr: Number.isFinite(baselineCtr) ? baselineCtr : undefined,
    });
    return NextResponse.json({ opportunities, term_count: rows.length });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'seo: opportunities',
      fallbackMessage: 'Could not load SEO opportunities — please try again.',
    });
  }
});

