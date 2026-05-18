import { getSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { findCachedAnalysis, listRecentAnalyses } from '@/lib/analyzer/db';
import { AnalyzeEntryClient, type RecentAnalysisItem } from './AnalyzeEntryClient';

/**
 * /analyze — entry page for the deep YouTube video analyzer.
 *
 * Server-rendered shell with the recent-analyses list pre-fetched so
 * the page is useful at TTFB. Interactive bits (URL input, analyze
 * button, in-flight progress) live in the client component below.
 *
 * Deep-link from the niche-finder uses `?videoId=...&title=...` —
 * read on the client to prefill the URL field and (when
 * `autostart=1`) kick off the analyze POST immediately. The plan
 * keeps autostart behind that explicit flag so a stray paste of an
 * /analyze URL doesn't silently burn a daily-cap slot.
 *
 * Server-side cache short-circuit: when `?videoId=...` is supplied
 * AND a `done`-stage row exists in this workspace at the current
 * analyzer/prompt version, redirect to /analyze/[id] before the
 * entry page hydrates. This avoids the flash of the entry shell that
 * would otherwise happen between the niche-finder click and the
 * client-side autostart POST returning its cached result. We do NOT
 * redirect when the cached row is `failed` or `analyzing` — those
 * cases benefit from the entry UI's retry / progress affordances.
 */
export default async function AnalyzePage({
  searchParams,
}: {
  searchParams: Promise<{ videoId?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const sp = await searchParams;
  if (sp.videoId && /^[A-Za-z0-9_-]{11}$/.test(sp.videoId)) {
    const cached = await findCachedAnalysis({
      workspaceId: session.ws,
      videoId: sp.videoId,
    });
    if (cached?.stage === 'done') {
      redirect(`/analyze/${cached.id}`);
    }
  }

  const rows = await listRecentAnalyses({ workspaceId: session.ws, limit: 25 });
  const initialRecent: RecentAnalysisItem[] = rows.map((r) => ({
    id: r.id,
    videoId: r.video_id,
    videoUrl: r.video_url,
    videoTitle: r.video_title,
    channelTitle: r.channel_title,
    stage: r.stage,
    failureReason: r.failure_reason,
    modelId: r.model_id,
    stylePackCount: r.result_jsonb?.style_packs?.length ?? null,
    createdAt: r.created_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
  }));

  return <AnalyzeEntryClient initialRecent={initialRecent} />;
}
