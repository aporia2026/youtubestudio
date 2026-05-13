/**
 * Brief runner — shared between the POST kickoff endpoint and the
 * retry cron.
 *
 * Takes a (workspaceId, briefId) pair already persisted as 'pending'
 * (or 'failed' and ready for retry). Marks the row 'running' to claim
 * it; calls Perplexity; writes the result back. Never throws — every
 * error path writes to the row + logs.
 *
 * The data inputs (favorite, proof videos, operator context) are
 * re-fetched here even when the kickoff endpoint just had them in
 * scope. The redundant DB round-trips are cheap (3 small queries) and
 * keep both call paths uniform: the cron has nothing in scope when it
 * fires, so the runner has to load everything from the briefId
 * regardless.
 */
import { logger } from '@/lib/logger';
import {
  completeBrief,
  createPendingBrief,
  failBrief,
  getBriefById,
  getLatestBrief,
  markBriefRunning,
} from './brief-db';
import { generateBrief } from './brief';
import { fetchOperatorContext } from './operator-context';
import { getFavorite, isPlaceholderScores, listFavoriteVideos } from './favorites';
import { getEffectiveModelId } from '@/lib/model-defaults';

export interface BriefRunResult {
  status: 'ready' | 'failed' | 'skipped';
  briefId: string;
  errorMessage?: string;
  durationMs?: number;
  costUsd?: number;
}

/** Kick off a brief generation for a favorite. Creates a 'pending'
 *  row and fires the runner in the background. Returns the new brief
 *  id, or null when the favorite is in a state where briefs shouldn't
 *  auto-generate yet:
 *    - the favorite doesn't exist / is soft-deleted
 *    - scores are placeholder (no deep-dive has run; a brief now
 *      would be pure speculation)
 *    - there's already a 'ready' brief for this favorite that hasn't
 *      been explicitly invalidated
 *
 *  Used by the POST /favorites endpoint to auto-trigger on first save
 *  and by any other code path that wants a "make sure a brief exists"
 *  guarantee. The manual "Regenerate" button in the UI uses the
 *  dedicated POST /brief endpoint instead so the operator can pick a
 *  model override. */
export async function kickoffBrief(args: {
  workspaceId: string;
  nicheSlug: string;
  /** Optional explicit override; otherwise the workspace's resolved
   *  default for `niche-favorite-brief` is used. */
  modelId?: string;
  /** When true, kick off even if a 'ready' brief already exists.
   *  Defaults to false — the auto-trigger path should never overwrite
   *  a brief the operator may have already read. */
  force?: boolean;
}): Promise<string | null> {
  const favorite = await getFavorite(args.workspaceId, args.nicheSlug);
  if (!favorite) return null;

  // Don't auto-generate when scores are placeholders — the brief
  // would have no demand/competition/monetization signal to ground
  // its prose. Wait for the operator to run a deep-dive or click
  // "Generate brief" explicitly.
  if (isPlaceholderScores(favorite.scores)) return null;

  if (!args.force) {
    const latest = await getLatestBrief(args.workspaceId, args.nicheSlug);
    if (latest && latest.status === 'ready') return null;
    // Pending / running briefs also block re-kickoff — let them complete first.
    if (latest && (latest.status === 'pending' || latest.status === 'running')) return null;
  }

  const modelId =
    args.modelId ?? (await getEffectiveModelId(args.workspaceId, 'niche-favorite-brief'));
  const operatorContext = await fetchOperatorContext(args.workspaceId);

  const briefId = await createPendingBrief({
    workspaceId: args.workspaceId,
    nicheSlug: args.nicheSlug,
    modelId,
    operatorContext,
    scoresSnapshot: favorite.scores,
  });

  // Fire and forget. The runner re-loads inputs from the briefId.
  runAndPersistBrief({
    workspaceId: args.workspaceId,
    briefId,
  }).catch((err) => {
    logger.error('kickoffBrief: runAndPersistBrief escaped', {
      detail: err instanceof Error ? err.message : String(err),
      brief_id: briefId,
      workspace_id: args.workspaceId,
      niche_slug: args.nicheSlug,
    });
  });

  return briefId;
}

/** Run a pending brief end-to-end. Safe to call concurrently — the
 *  `markBriefRunning` claim is the serialization point. Returns
 *  status='skipped' when another worker has already taken the row. */
export async function runAndPersistBrief(args: {
  workspaceId: string;
  briefId: string;
}): Promise<BriefRunResult> {
  const startedAt = Date.now();

  // Claim. If someone else has it (or it's out of retries), bail.
  const claimed = await markBriefRunning({
    workspaceId: args.workspaceId,
    briefId: args.briefId,
  });
  if (!claimed) {
    return { status: 'skipped', briefId: args.briefId };
  }

  // Load the row so we know the niche_slug and the model_id chosen at
  // kickoff. Picking model_id off the row (not re-resolving from the
  // workspace default) honours the operator's choice if they regen'd
  // with a specific model.
  const briefRow = await getBriefById(args.workspaceId, args.briefId);
  if (!briefRow) {
    // Row vanished between markBriefRunning and the read — shouldn't
    // happen but defensive.
    return { status: 'skipped', briefId: args.briefId };
  }
  const parentSlug = briefRow.niche_slug;
  const modelId = briefRow.model_id;

  const favorite = await getFavorite(args.workspaceId, parentSlug);
  if (!favorite) {
    await failBrief({
      workspaceId: args.workspaceId,
      briefId: args.briefId,
      errorMessage: `Parent favorite '${parentSlug}' no longer exists (soft-deleted or purged).`,
    });
    return { status: 'failed', briefId: args.briefId };
  }

  const [operatorContext, videos] = await Promise.all([
    fetchOperatorContext(args.workspaceId),
    listFavoriteVideos(args.workspaceId, parentSlug),
  ]);

  try {
    const parsed = await generateBrief({
      workspaceId: args.workspaceId,
      modelId,
      inputs: {
        nicheName: favorite.niche_name,
        nicheSlug: parentSlug,
        scores: favorite.scores,
        proofVideos: videos
          .filter((v) => !v.is_removed_upstream)
          .map((v) => ({
            title: v.title,
            channel_title: v.channel_title,
            subscriber_count: v.subscriber_count,
            view_count: v.view_count,
            outlier_score: v.outlier_score,
            classification: v.classification,
          })),
        operator: operatorContext,
      },
    });
    await completeBrief({
      workspaceId: args.workspaceId,
      briefId: args.briefId,
      parsed,
    });
    logger.info('runAndPersistBrief: completed', {
      brief_id: args.briefId,
      workspace_id: args.workspaceId,
      niche_slug: parentSlug,
      model_id: modelId,
      cost_usd: parsed.cost_usd,
      duration_ms: parsed.duration_ms,
      promise_score: parsed.promise_score,
    });
    return {
      status: 'ready',
      briefId: args.briefId,
      durationMs: parsed.duration_ms,
      costUsd: parsed.cost_usd,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('runAndPersistBrief: failed', {
      brief_id: args.briefId,
      workspace_id: args.workspaceId,
      niche_slug: parentSlug,
      model_id: modelId,
      duration_ms: Date.now() - startedAt,
      detail: msg.slice(0, 300),
    });
    await failBrief({
      workspaceId: args.workspaceId,
      briefId: args.briefId,
      errorMessage: msg,
    }).catch((failErr) => {
      logger.error('runAndPersistBrief: failBrief also failed', {
        brief_id: args.briefId,
        detail: failErr instanceof Error ? failErr.message : String(failErr),
      });
    });
    return { status: 'failed', briefId: args.briefId, errorMessage: msg };
  }
}
