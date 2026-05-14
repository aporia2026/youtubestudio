import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getUserSettings, updateUserSettings } from '@/lib/user-settings';
import { DEFAULT_BROLL_MODEL_ID, findBrollModel } from '@/lib/broll-types';

/**
 * GET /api/user/settings/broll-default
 *
 * Returns the user's default B-roll / animation model id. Resolves a null
 * stored value (and any stale id that no longer exists in the registry)
 * to the library default so the caller never has to decide.
 *
 * Response: { modelId: string, isExplicit: boolean }
 *   - modelId    — always a registered id; safe to feed into the picker
 *   - isExplicit — true if the user has set their own, false when we
 *                  resolved from `DEFAULT_BROLL_MODEL_ID` instead
 *
 * Storage backing: `collaborators.encrypted_settings` (a versioned JSON
 * blob encrypted at rest — see `src/lib/user-settings.ts`). No new
 * migration is needed because the column has existed since 0003.
 */
export const GET = apiRoute.authed(async (session) => {
  const settings = await getUserSettings(session.uid);
  const stored = settings.default_broll_model_id ?? null;
  const valid = stored && findBrollModel(stored) ? stored : null;
  const modelId = valid ?? DEFAULT_BROLL_MODEL_ID;
  return NextResponse.json({ modelId, isExplicit: Boolean(valid) });
});

/**
 * PUT /api/user/settings/broll-default  body: { modelId: string | null }
 *
 * Set or clear the user's default. `null` (or omitted) clears it and the
 * resolver falls back to the library default on the next read.
 */
export const PUT = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const raw = (body as { modelId?: unknown } | null)?.modelId;

  let modelId: string | null;
  if (raw === null || raw === undefined || raw === '') {
    modelId = null;
  } else if (typeof raw === 'string') {
    if (!findBrollModel(raw)) {
      return NextResponse.json({ error: `Unknown B-roll model: ${raw}` }, { status: 400 });
    }
    modelId = raw;
  } else {
    return NextResponse.json({ error: 'modelId must be a string or null' }, { status: 400 });
  }

  await updateUserSettings(session.uid, { default_broll_model_id: modelId });
  return NextResponse.json({
    ok: true,
    modelId: modelId ?? DEFAULT_BROLL_MODEL_ID,
    isExplicit: modelId !== null,
  });
});
