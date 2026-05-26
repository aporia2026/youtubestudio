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
  setWorkspaceToggle,
  setWorkspaceWipLimit,
  type QaToggleState,
} from '@/lib/qa-workspace-settings';
import { isVideoStageId } from '@/lib/video-stages';

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

    // Tri-state toggles. Each can be 'on' | 'off' | 'inherit'; anything
    // else is rejected as a bad value.
    const toggleKeys: Array<{ key: 'preCheck' | 'rubricV2' | 'generatorV2'; field: string }> = [
      { key: 'preCheck',    field: 'preCheck' },
      { key: 'rubricV2',    field: 'rubricV2' },
      { key: 'generatorV2', field: 'generatorV2' },
    ];
    for (const { key, field } of toggleKeys) {
      if (field in (obj as Record<string, unknown>)) {
        const v = (obj as Record<string, unknown>)[field];
        if (v !== 'on' && v !== 'off' && v !== 'inherit') {
          return NextResponse.json(
            { error: `${field} must be 'on', 'off', or 'inherit'` },
            { status: 400 },
          );
        }
        await setWorkspaceToggle(session.ws, key, v as QaToggleState);
      }
    }

    // WIP limit set: body field 'wipLimit' = { stageId, limit | null }.
    if ('wipLimit' in (obj as Record<string, unknown>)) {
      const wip = (obj as Record<string, unknown>).wipLimit as
        | { stageId?: unknown; limit?: unknown }
        | null;
      if (!wip || typeof wip !== 'object') {
        return NextResponse.json({ error: 'wipLimit must be { stageId, limit }' }, { status: 400 });
      }
      const stageId = wip.stageId;
      if (typeof stageId !== 'string' || !isVideoStageId(stageId)) {
        return NextResponse.json({ error: 'wipLimit.stageId must be a valid VideoStageId' }, { status: 400 });
      }
      const rawLimit = wip.limit;
      const limit =
        rawLimit === null
          ? null
          : typeof rawLimit === 'number'
            ? rawLimit
            : Number(rawLimit);
      if (limit !== null && (!Number.isFinite(limit) || limit < 1 || limit > 1000)) {
        return NextResponse.json({ error: 'wipLimit.limit must be between 1 and 1000, or null to clear' }, { status: 400 });
      }
      await setWorkspaceWipLimit(session.ws, stageId, limit);
    }

    const settings = await getWorkspaceQaSettings(session.ws);
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update QA settings';
    logger.warn('[qa workspace-settings] PUT rejected', { detail: message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
