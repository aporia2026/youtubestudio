import { getSession } from '@/lib/session';
import { redirect, notFound } from 'next/navigation';
import { getAnalysisById } from '@/lib/analyzer/db';
import { ANALYZER_VERSION, PROMPT_VERSION } from '@/lib/analyzer/types';
import { AnalyzeResultClient, type AnalysisSnapshot } from './AnalyzeResultClient';

/**
 * /analyze/[id] — result view for a single analysis.
 *
 * Server-fetches the row so the page renders the right state on
 * first paint (no flash of "analyzing" when the analysis already
 * finished). The client component handles the polling loop while
 * stage is non-terminal and the tabbed UI once it's done.
 */
export default async function AnalysisResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect('/login');

  const row = await getAnalysisById({ workspaceId: session.ws, analysisId: id });
  if (!row) notFound();

  const snapshot: AnalysisSnapshot = {
    id: row.id,
    videoId: row.video_id,
    videoUrl: row.video_url,
    videoTitle: row.video_title,
    channelTitle: row.channel_title,
    modelId: row.model_id,
    stage: row.stage,
    failureReason: row.failure_reason,
    result: row.result_jsonb,
    stale: row.analyzer_version !== ANALYZER_VERSION || row.prompt_version !== PROMPT_VERSION,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };

  return <AnalyzeResultClient initial={snapshot} />;
}
