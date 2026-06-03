import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getUserSettings } from '@/lib/user-settings';
import { listShortsI2vModels } from '@/lib/shorts-frame-animate';
import { DEFAULT_BROLL_I2V_MODEL_ID } from '@/lib/broll-types';

/**
 * Phase 15.16 — list the i2v models the Shorts animator can use, plus
 * the user's stored default. Drives the Shots panel's "Animate" model
 * dropdown so the picker renders without round-tripping the b-roll
 * registry through two surfaces.
 *
 * Filtered to: kind=image-to-video, supportedAspects includes 9:16,
 * provider=kie. Local ComfyUI i2v workflows are landscape-only and
 * gated by LOCAL_STUDIO=1, so they don't apply here.
 *
 * GET → { current, models[] }
 */
export const GET = apiRoute.authed(async (session) => {
  const settings = await getUserSettings(session.uid);
  const models = listShortsI2vModels().map((m) => ({
    id: m.id,
    label: m.label,
    family: m.family,
    durationSeconds: m.durationSeconds,
    priceUsd: m.priceUsd,
    priceUsdLabel: m.priceUsdLabel,
    blurb: m.blurb,
    recommended: !!m.recommended,
  }));
  return NextResponse.json({
    current: settings.default_broll_i2v_model_id ?? DEFAULT_BROLL_I2V_MODEL_ID,
    models,
  });
});
