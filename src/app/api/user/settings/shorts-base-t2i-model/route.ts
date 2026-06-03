import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getUserSettings, updateUserSettings } from '@/lib/user-settings';
import { logger } from '@/lib/logger';
import { BASE_T2I_MODELS, resolveBaseT2iModelId } from '@/lib/shorts-base-t2i';

/**
 * Phase 15.15 — per-user default base-frame T2I model for the Shorts
 * asset pipeline. Surfaced by the Shots panel's model dropdown so the
 * user's choice sticks across sessions. Routes that consume the
 * setting follow `body override > UserSettings > DEFAULT_BASE_T2I_MODEL_ID`.
 *
 *   GET  → current setting + the registry so the UI can render the
 *          dropdown without round-tripping a separate "list models"
 *          call. `current` is `null` when unset; the consumer applies
 *          the cost-optimal default itself.
 *   POST { model_id: ShortsBaseT2iModelId | null } → persist.
 *
 * Mirrors the `gpt-image-2-edit-primary` route shape.
 */
export const GET = apiRoute.authed(async (session) => {
  const settings = await getUserSettings(session.uid);
  return NextResponse.json({
    shorts_base_t2i_model_id: settings.shorts_base_t2i_model_id ?? null,
    /** Registry surfaced inline so the UI's dropdown can render without
     *  a second fetch. The set is small (4 entries) and changes rarely. */
    models: BASE_T2I_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      vendor: m.vendor,
      costUsd: m.costUsd,
      hint: m.hint,
    })),
  });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const raw = (body as { model_id?: unknown } | null)?.model_id;
  let modelId: string | null;
  if (raw === null || raw === undefined || raw === '') {
    modelId = null;
  } else if (typeof raw === 'string') {
    // Validate against the registry — refuse arbitrary strings so a
    // bad client never persists a retired model id.
    const resolved = resolveBaseT2iModelId(raw);
    if (resolved !== raw) {
      return NextResponse.json(
        { error: `Unknown model id "${raw}". See GET for the supported list.` },
        { status: 400 },
      );
    }
    modelId = resolved;
  } else {
    return NextResponse.json(
      { error: 'model_id must be a string or null' },
      { status: 400 },
    );
  }

  await updateUserSettings(session.uid, { shorts_base_t2i_model_id: modelId });
  logger.info('[user settings shorts-base-t2i-model] updated', {
    userId: session.uid,
    modelId,
  });
  return NextResponse.json({ ok: true, shorts_base_t2i_model_id: modelId });
});
