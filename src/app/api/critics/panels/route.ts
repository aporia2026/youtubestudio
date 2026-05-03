import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import {
  appendCriticPanelEvent,
  completeCriticPanel,
  createCriticPanel,
  failCriticPanel,
  listCriticPanels,
} from '@/lib/critic-panels';
import { runScriptPanelLive } from '@/lib/script-critics/runner-live';
import type { ScriptAggressiveness } from '@/lib/script-critics/types';
import { logger } from '@/lib/logger';

// The full panel typically takes 60-120s. The route ceiling has to cover
// the slowest realistic run; 300s is the Vercel Pro upper bound.
export const maxDuration = 300;

/**
 * GET /api/critics/panels?projectId=&scriptId=&limit=
 *
 * Workspace-scoped list of past panel runs, newest first.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId') || undefined;
  const scriptId = searchParams.get('scriptId') || undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;
  const panels = await listCriticPanels(session.ws, { projectId, scriptId, limit });
  return NextResponse.json({ panels });
});

/**
 * POST /api/critics/panels
 *
 * Body: {
 *   script: string,
 *   niche: string,
 *   passNumber?: number,
 *   aggressiveness?: 'standard' | 'brutal' | 'nuclear',
 *   modelId: string,
 *   projectId?: string,
 *   sourceScriptId?: string,
 * }
 *
 * Streams an SSE response with one `event: <phase>` frame per emitted
 * panel event. Each event also persists to `critic_panel_events`. The
 * first frame is `{ type: 'panel_id', panel_id: '<uuid>' }` so the client
 * can store the id for replay or detail lookup.
 *
 * On client disconnect (browser tab closed mid-run), the AsyncGenerator
 * keeps running server-side and persistence continues. The next reader
 * of /panels/[id] sees the up-to-date status, and reconnecting clients
 * can replay from /panels/[id]/events?since=N.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const script = typeof b.script === 'string' ? b.script.trim() : '';
  const niche = typeof b.niche === 'string' ? b.niche.trim() : '';
  const modelId = typeof b.modelId === 'string' ? b.modelId.trim() : '';
  if (!script || script.length < 200) {
    return NextResponse.json({ error: 'script is required (min 200 chars)' }, { status: 400 });
  }
  if (!niche) return NextResponse.json({ error: 'niche is required' }, { status: 400 });
  if (!modelId) return NextResponse.json({ error: 'modelId is required' }, { status: 400 });

  const passNumber =
    typeof b.passNumber === 'number' && Number.isFinite(b.passNumber)
      ? Math.max(1, Math.min(10, Math.round(b.passNumber)))
      : 1;
  const aggressiveness: ScriptAggressiveness =
    b.aggressiveness === 'brutal' || b.aggressiveness === 'nuclear' ? b.aggressiveness : 'standard';
  const projectId = typeof b.projectId === 'string' && b.projectId ? b.projectId : null;
  const sourceScriptId = typeof b.sourceScriptId === 'string' && b.sourceScriptId ? b.sourceScriptId : null;

  // Ownership for optional FK fields.
  try {
    if (projectId) await assertOwnsResource('projects', projectId, session.ws);
    if (sourceScriptId) await assertOwnsResource('scripts', sourceScriptId, session.ws);
  } catch (err) {
    if (err instanceof ResourceNotInWorkspaceError) {
      return NextResponse.json({ error: 'Resource not found in this workspace' }, { status: 404 });
    }
    throw err;
  }

  const { id: panelId } = await createCriticPanel({
    workspaceId: session.ws,
    projectId,
    sourceScriptId,
    scriptText: script,
    niche,
    passNumber,
    aggressiveness,
    modelId,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let sequenceNo = 0;
      const send = (frame: { event?: string; data: unknown }) => {
        const eventLine = frame.event ? `event: ${frame.event}\n` : '';
        const dataLine = `data: ${JSON.stringify(frame.data)}\n\n`;
        controller.enqueue(encoder.encode(eventLine + dataLine));
      };

      // First frame so the client knows the panel id immediately.
      send({ event: 'panel_id', data: { panel_id: panelId } });

      try {
        const generator = runScriptPanelLive({
          script,
          niche,
          passNumber,
          aggressiveness,
          modelId,
          spend: {
            workspaceId: session.ws,
            projectId,
            sourceScriptId,
          },
        });
        for await (const ev of generator) {
          sequenceNo += 1;
          // Persist first so a disconnected client that reconnects via
          // /events?since=N never sees a hole.
          try {
            await appendCriticPanelEvent({
              workspaceId: session.ws,
              panelId,
              sequenceNo,
              event: ev,
            });
          } catch (persistErr) {
            logger.warn('critic panel: event persistence failed', {
              panelId,
              sequenceNo,
              detail: persistErr instanceof Error ? persistErr.message : String(persistErr),
            });
          }
          send({
            event: ev.phase,
            data: { ...ev, sequence_no: sequenceNo, captured_at: new Date().toISOString() },
          });
          if (ev.phase === 'panel' && ev.event_type === 'complete') {
            const payload = ev.payload as { verdict?: unknown };
            const verdict = payload.verdict as Parameters<typeof completeCriticPanel>[0]['verdict'];
            // Charter is on the verdict — runner attaches it before yielding.
            const charter = (verdict as { charter?: Parameters<typeof completeCriticPanel>[0]['charter'] }).charter ?? null;
            await completeCriticPanel({
              workspaceId: session.ws,
              panelId,
              verdict,
              charter,
            });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('critic panel: runner threw', { panelId, detail: msg });
        sequenceNo += 1;
        const errorEvent = {
          phase: 'panel' as const,
          critic_id: null,
          event_type: 'error' as const,
          payload: { message: msg },
        };
        try {
          await appendCriticPanelEvent({
            workspaceId: session.ws,
            panelId,
            sequenceNo,
            event: errorEvent,
          });
        } catch {
          /* swallow — already in error path */
        }
        await failCriticPanel({ workspaceId: session.ws, panelId, errorMessage: msg }).catch(() => {});
        send({
          event: 'panel',
          data: { ...errorEvent, sequence_no: sequenceNo, captured_at: new Date().toISOString() },
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Vercel buffers responses by default — disable for SSE.
      'X-Accel-Buffering': 'no',
    },
  });
});
