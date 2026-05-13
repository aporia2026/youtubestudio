import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { getFavorite } from '@/lib/niche-finder/favorites';
import {
  createPendingBrief,
  getActiveBrief,
  getLatestBrief,
  listBriefVersions,
} from '@/lib/niche-finder/brief-db';
import { fetchOperatorContext } from '@/lib/niche-finder/operator-context';
import { runAndPersistBrief } from '@/lib/niche-finder/brief-runner';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { getModelById } from '@/lib/ai-models';
import { slugifyNiche } from '@/lib/niche-finder/slug';
import { logger } from '@/lib/logger';

/**
 * GET  /api/niche-finder/favorites/[slug]/brief
 *   → { active: BriefRow|null, latest: BriefRow|null, history: BriefRow[] }
 *   - `active` is the most recent successful brief (status='ready').
 *   - `latest` is the most recent brief regardless of status — drives
 *     the shimmer (pending/running) and error (failed) UI states.
 *   - `history` is the full version list, capped at 20.
 *
 * POST /api/niche-finder/favorites/[slug]/brief
 *   Body: { modelId?: string }
 *   → { briefId: string }
 *   Fire-and-forget kickoff. Creates a 'pending' row, returns its id
 *   immediately, then runs Perplexity Deep Research in the background
 *   and writes the result back. The UI polls /brief until status flips
 *   to 'ready' or 'failed'. The cron retries any rows the inline
 *   kickoff drops (cold-start timeouts, etc).
 *
 * The optional `modelId` in the request body overrides the workspace's
 * picker selection for this single call — used by the brief card's
 * "Switch model & regenerate" action. When omitted, the workspace's
 * resolved model is used.
 */
export const GET = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug: rawSlug } = await params;
    const slug = slugifyNiche(rawSlug);
    const [active, latest, history] = await Promise.all([
      getActiveBrief(session.ws, slug),
      getLatestBrief(session.ws, slug),
      listBriefVersions(session.ws, slug),
    ]);
    return NextResponse.json({ active, latest, history });
  },
);

export const POST = apiRoute.authed(
  async (session, req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug: rawSlug } = await params;
    const slug = slugifyNiche(rawSlug);

    // Body parsing — empty body is allowed (use workspace default model).
    let body: { modelId?: unknown } = {};
    try {
      body = (await req.json().catch(() => ({}))) as { modelId?: unknown };
    } catch {
      body = {};
    }

    // Confirm the favorite exists + isn't soft-deleted. Surface a 404
    // instead of letting an FK violation bubble up.
    const favorite = await getFavorite(session.ws, slug);
    if (!favorite) {
      return NextResponse.json(
        { error: 'Favorite not found. Save the niche first, then request a brief.' },
        { status: 404 },
      );
    }

    // Resolve the model. Explicit override beats workspace default.
    let modelId: string;
    if (typeof body.modelId === 'string' && body.modelId.length > 0) {
      if (!getModelById(body.modelId)) {
        return NextResponse.json({ error: `Unknown modelId: ${body.modelId}` }, { status: 400 });
      }
      modelId = body.modelId;
    } else {
      modelId = await getEffectiveModelId(session.ws, 'niche-favorite-brief');
    }

    // Snapshot the operator context onto the pending row so the
    // background runner has an audit trail of what the model saw.
    const operatorContext = await fetchOperatorContext(session.ws);

    // Create the pending row UP FRONT so the UI sees something
    // immediately and the cron has a row to retry on if the inline
    // kickoff drops.
    let briefId: string;
    try {
      briefId = await createPendingBrief({
        workspaceId: session.ws,
        nicheSlug: slug,
        modelId,
        operatorContext,
        scoresSnapshot: favorite.scores,
      });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'niche-finder: brief create-pending',
        fallbackMessage: 'Could not start brief generation.',
      });
    }

    // Fire-and-forget. The runner re-loads inputs from the briefId,
    // claims via markBriefRunning, and writes the result. Errors are
    // recorded on the row + logged; they never block the response.
    runAndPersistBrief({
      workspaceId: session.ws,
      briefId,
    }).catch((err) => {
      // Should never escape — runAndPersistBrief catches all paths —
      // but log defensively in case a future refactor leaks one.
      logger.error('runAndPersistBrief escaped its own try/catch', {
        detail: err instanceof Error ? err.message : String(err),
        brief_id: briefId,
      });
    });

    return NextResponse.json({ briefId });
  },
);
