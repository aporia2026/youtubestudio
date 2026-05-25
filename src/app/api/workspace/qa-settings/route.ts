/**
 * GET /api/workspace/qa-settings
 *   Returns the workspace's QA settings (currently just the
 *   nuclear-mode model preference). When nothing is saved, the response
 *   carries `nuclearModelId: null` which the UI renders as "no upgrade."
 *
 * PUT /api/workspace/qa-settings
 *   Body: { nuclearModelId: string | null }
 *   Sets the workspace's nuclear-mode model preference. Pass null to
 *   clear (returns to "no upgrade"). Unknown model ids are rejected
 *   with 400 so a typo doesn't silently disable QA.
 *
 * Both are workspace-scoped at the helper level — the session's
 * workspace id is the only thing that reaches the database, never a
 * client-supplied value.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import {
  getWorkspaceQaSettings,
  setWorkspaceNuclearModel,
  setWorkspaceStuckHours,
} from '@/lib/qa-workspace-settings';

export const GET = apiRoute.authed(async (session) => {
  const settings = await getWorkspaceQaSettings(session.ws);
  return NextResponse.json({ settings });
});

export const PUT = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Body shape (all keys optional; unspecified keys are left alone):
  //   { nuclearModelId?: string | null, stuckThresholdHours?: number | null }
  const obj = body as { nuclearModelId?: unknown; stuckThresholdHours?: unknown };

  try {
    if ('nuclearModelId' in obj) {
      const raw = obj.nuclearModelId;
      const modelId =
        raw === null
          ? null
          : typeof raw === 'string' && raw.trim().length > 0
            ? raw.trim()
            : null;
      await setWorkspaceNuclearModel(session.ws, modelId);
    }

    if ('stuckThresholdHours' in obj) {
      const raw = obj.stuckThresholdHours;
      const hours = raw === null ? null : typeof raw === 'number' ? raw : Number(raw);
      await setWorkspaceStuckHours(session.ws, hours === null || Number.isNaN(hours) ? null : hours);
    }

    const settings = await getWorkspaceQaSettings(session.ws);
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update QA settings';
    logger.warn('[qa workspace-settings] PUT rejected', { detail: message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
