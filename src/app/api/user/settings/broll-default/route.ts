import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getUserSettings, updateUserSettings } from '@/lib/user-settings';
import {
  DEFAULT_BROLL_I2V_MODEL_ID,
  DEFAULT_BROLL_MODEL_ID,
  DEFAULT_BROLL_T2V_MODEL_ID,
  findBrollModel,
} from '@/lib/broll-types';

/**
 * GET /api/user/settings/broll-default
 *
 * Returns the user's two kind-specific defaults — one for text-to-video
 * (rows without a still) and one for image-to-video (rows with a still).
 * Each is resolved through the registry so callers never see a stale or
 * unknown id.
 *
 * Response: {
 *   t2vModelId, i2vModelId,
 *   t2vIsExplicit, i2vIsExplicit,
 *   // back-compat (deprecated, but kept so older clients keep working):
 *   modelId, isExplicit,
 * }
 *
 * Resolution order per kind:
 *   1. The kind-specific field (`default_broll_t2v_model_id` /
 *      `default_broll_i2v_model_id`) if set and still registered with the
 *      matching kind.
 *   2. The legacy single-default field (`default_broll_model_id`) if it
 *      happens to match the kind — this is how pre-split accounts adopt
 *      their saved choice.
 *   3. The library default for that kind.
 *
 * Storage backing: `collaborators.encrypted_settings`.
 */
export const GET = apiRoute.authed(async (session) => {
  const settings = await getUserSettings(session.uid);
  // Use explicit ternaries here, NOT `x && fn(x)`. With strict TS the
  // logical-AND keeps the empty string `""` in the result union (because
  // the left side is a string, and `""` short-circuits), which makes
  // optional-chain access on `.kind` fail to type-check. Plain strings
  // from settings can be empty, so falsy-by-truthy fallback is correct
  // but `?` chaining on the union needs the falsy side to be a non-object.
  const legacy = settings.default_broll_model_id ?? null;
  const legacyModel = legacy ? findBrollModel(legacy) : undefined;

  const storedT2v = settings.default_broll_t2v_model_id ?? null;
  const validT2v = storedT2v ? findBrollModel(storedT2v) : undefined;
  const t2vFromKindField = validT2v?.kind === 'text-to-video' ? storedT2v : null;
  const t2vFromLegacy = legacyModel?.kind === 'text-to-video' ? legacy : null;
  const t2vResolved = t2vFromKindField ?? t2vFromLegacy ?? null;
  const t2vModelId = t2vResolved ?? DEFAULT_BROLL_T2V_MODEL_ID;

  const storedI2v = settings.default_broll_i2v_model_id ?? null;
  const validI2v = storedI2v ? findBrollModel(storedI2v) : undefined;
  const i2vFromKindField = validI2v?.kind === 'image-to-video' ? storedI2v : null;
  const i2vFromLegacy = legacyModel?.kind === 'image-to-video' ? legacy : null;
  const i2vResolved = i2vFromKindField ?? i2vFromLegacy ?? null;
  const i2vModelId = i2vResolved ?? DEFAULT_BROLL_I2V_MODEL_ID;

  return NextResponse.json({
    t2vModelId,
    i2vModelId,
    t2vIsExplicit: Boolean(t2vResolved),
    i2vIsExplicit: Boolean(i2vResolved),
    // Legacy shape — kept so a client mid-refresh still gets a usable value.
    modelId: i2vResolved ?? t2vResolved ?? DEFAULT_BROLL_MODEL_ID,
    isExplicit: Boolean(i2vResolved || t2vResolved),
  });
});

/**
 * PUT /api/user/settings/broll-default
 *
 * Body: { modelId: string | null }
 *
 * Sets the user's default for the *kind* of the given model. A t2v model
 * is stored in `default_broll_t2v_model_id`; an i2v model lands in
 * `default_broll_i2v_model_id`. The legacy single field is mirrored
 * (kept in sync with whichever kind was set most recently) so older
 * code paths keep resolving to something sensible.
 *
 * Passing `modelId: null` clears BOTH kind defaults so the cell falls
 * back to the library defaults on next read.
 */
export const PUT = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const raw = (body as { modelId?: unknown } | null)?.modelId;

  if (raw === null || raw === undefined || raw === '') {
    await updateUserSettings(session.uid, {
      default_broll_model_id: null,
      default_broll_t2v_model_id: null,
      default_broll_i2v_model_id: null,
    });
    return NextResponse.json({
      ok: true,
      t2vModelId: DEFAULT_BROLL_T2V_MODEL_ID,
      i2vModelId: DEFAULT_BROLL_I2V_MODEL_ID,
      t2vIsExplicit: false,
      i2vIsExplicit: false,
      modelId: DEFAULT_BROLL_MODEL_ID,
      isExplicit: false,
    });
  }
  if (typeof raw !== 'string') {
    return NextResponse.json({ error: 'modelId must be a string or null' }, { status: 400 });
  }
  const model = findBrollModel(raw);
  if (!model) {
    return NextResponse.json({ error: `Unknown B-roll model: ${raw}` }, { status: 400 });
  }

  // Write to the slot the model's kind belongs to, AND mirror to the legacy
  // single field so a pre-split read path still works. The opposite-kind slot
  // is intentionally left untouched.
  const patch =
    model.kind === 'image-to-video'
      ? { default_broll_i2v_model_id: raw, default_broll_model_id: raw }
      : { default_broll_t2v_model_id: raw, default_broll_model_id: raw };
  const merged = await updateUserSettings(session.uid, patch);

  const storedT2v = merged.default_broll_t2v_model_id ?? null;
  const storedI2v = merged.default_broll_i2v_model_id ?? null;
  const t2vIsExplicit =
    !!storedT2v && (storedT2v ? findBrollModel(storedT2v) : undefined)?.kind === 'text-to-video';
  const i2vIsExplicit =
    !!storedI2v && (storedI2v ? findBrollModel(storedI2v) : undefined)?.kind === 'image-to-video';
  return NextResponse.json({
    ok: true,
    t2vModelId: t2vIsExplicit && storedT2v ? storedT2v : DEFAULT_BROLL_T2V_MODEL_ID,
    i2vModelId: i2vIsExplicit && storedI2v ? storedI2v : DEFAULT_BROLL_I2V_MODEL_ID,
    t2vIsExplicit,
    i2vIsExplicit,
    modelId: raw,
    isExplicit: true,
  });
});
