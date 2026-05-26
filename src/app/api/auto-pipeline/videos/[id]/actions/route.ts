import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  applyScriptGateDecision,
  killVideo,
  markNarrationComplete,
  extendNarrationDeadline,
  abandonNarration,
  retryVideo,
  PipelineActionError,
  type ScriptGateDecision,
} from '@/lib/auto-pipeline/actions';

/**
 * POST /api/auto-pipeline/videos/[id]/actions
 *
 * Single endpoint that dispatches on `action` in the body so the
 * UI has one fetch shape for every per-video action. Keeps the
 * route surface small while preserving distinct action semantics.
 *
 * Supported actions:
 *   - script_gate:     body = { action: 'script_gate', decision: 'keep'|'regenerate'|'kill' }
 *   - kill:            body = { action: 'kill', reason?: string }
 *   - narration_done:  body = { action: 'narration_done' }   — manually flip waiting→complete
 *   - extend_narration:body = { action: 'extend_narration', days: number }
 *   - abandon:         body = { action: 'abandon' }
 */
export const POST = apiRoute.authed<{ id: string }>(async (session, req: NextRequest, ctx) => {
  const { id: videoId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const action = typeof b.action === 'string' ? b.action : '';

  try {
    switch (action) {
      case 'script_gate': {
        const decision = b.decision as ScriptGateDecision;
        if (decision !== 'keep' && decision !== 'regenerate' && decision !== 'kill') {
          return NextResponse.json({ error: 'decision must be keep | regenerate | kill' }, { status: 400 });
        }
        const result = await applyScriptGateDecision({ workspaceId: session.ws, videoId, decision });
        return NextResponse.json(result);
      }
      case 'kill': {
        const reason = typeof b.reason === 'string' ? b.reason : undefined;
        const result = await killVideo({ workspaceId: session.ws, videoId, reason });
        return NextResponse.json(result);
      }
      case 'narration_done': {
        const result = await markNarrationComplete({ workspaceId: session.ws, videoId });
        return NextResponse.json(result);
      }
      case 'extend_narration': {
        const days = typeof b.days === 'number' && Number.isFinite(b.days) ? Math.floor(b.days) : 0;
        const result = await extendNarrationDeadline({ workspaceId: session.ws, videoId, days });
        return NextResponse.json(result);
      }
      case 'abandon': {
        const result = await abandonNarration({ workspaceId: session.ws, videoId });
        return NextResponse.json(result);
      }
      case 'retry': {
        const result = await retryVideo({ workspaceId: session.ws, videoId });
        return NextResponse.json(result);
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof PipelineActionError) {
      const status = err.code === 'video_not_found' || err.code === 'run_not_found' ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return domainErrorResponse(err, {
      op: `auto-pipeline: action ${action}`,
      fallbackMessage: 'Action failed.',
    });
  }
});
