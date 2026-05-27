import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  applyScriptGateDecision,
  killVideo,
  markNarrationComplete,
  extendNarrationDeadline,
  abandonNarration,
  retryVideo,
  rerunVideoFromStage,
  setVideoStyleOverride,
  PipelineActionError,
  type ScriptGateDecision,
} from '@/lib/auto-pipeline/actions';
import { isPipelineStage } from '@/lib/auto-pipeline/types';

/**
 * POST /api/auto-pipeline/videos/[id]/actions
 *
 * Single endpoint that dispatches on `action` in the body so the
 * UI has one fetch shape for every per-video action. Keeps the
 * route surface small while preserving distinct action semantics.
 *
 * Supported actions:
 *   - script_gate:        body = { action: 'script_gate', decision: 'keep'|'regenerate'|'kill', style_override_id?: string | null }
 *   - kill:               body = { action: 'kill', reason?: string }
 *   - narration_done:     body = { action: 'narration_done' }   — manually flip waiting→complete
 *   - extend_narration:   body = { action: 'extend_narration', days: number }
 *   - abandon:            body = { action: 'abandon' }
 *   - retry:              body = { action: 'retry' }            — auto-picks target stage from TERMINAL_RETRY_TARGET
 *   - rerun_from_stage:   body = { action: 'rerun_from_stage', target_stage: PipelineStage } — explicit target
 *   - set_style_override: body = { action: 'set_style_override', style_id: string | null }
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        // Optional one-off style override on regenerate — see
        // applyScriptGateDecision for the persistence semantics
        // (sets the per-video override column before bumping stage).
        let styleOverrideId: string | null | undefined;
        if (b.style_override_id === null) {
          styleOverrideId = null;
        } else if (typeof b.style_override_id === 'string') {
          if (!UUID_RE.test(b.style_override_id)) {
            return NextResponse.json({ error: 'style_override_id must be a UUID, null, or omitted' }, { status: 400 });
          }
          styleOverrideId = b.style_override_id;
        } else if (b.style_override_id !== undefined) {
          return NextResponse.json({ error: 'style_override_id must be a UUID, null, or omitted' }, { status: 400 });
        }
        const result = await applyScriptGateDecision({ workspaceId: session.ws, videoId, decision, styleOverrideId });
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
      case 'rerun_from_stage': {
        const targetStage = typeof b.target_stage === 'string' ? b.target_stage : '';
        if (!isPipelineStage(targetStage)) {
          return NextResponse.json({ error: 'target_stage must be a known pipeline stage' }, { status: 400 });
        }
        const result = await rerunVideoFromStage({ workspaceId: session.ws, videoId, targetStage });
        return NextResponse.json(result);
      }
      case 'set_style_override': {
        let styleId: string | null;
        if (b.style_id === null) {
          styleId = null;
        } else if (typeof b.style_id === 'string') {
          if (!UUID_RE.test(b.style_id)) {
            return NextResponse.json({ error: 'style_id must be a UUID or null' }, { status: 400 });
          }
          styleId = b.style_id;
        } else {
          return NextResponse.json({ error: 'style_id is required (UUID or null)' }, { status: 400 });
        }
        const result = await setVideoStyleOverride({ workspaceId: session.ws, videoId, styleId });
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
