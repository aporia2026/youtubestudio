import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  getSynthesizer,
  listAllVoices,
  listConfiguredProviders,
} from '@/lib/tts/dispatch';
import { TIER_PRICING } from '@/lib/tts/cost';
import type { TtsProviderId, VoiceCatalogEntry, VoiceTier } from '@/lib/tts/types';

/**
 * GET /api/tts/voices
 *
 * Query params:
 *   - provider:     'elevenlabs' | 'google'   (optional — omit to merge all)
 *   - languageCode: BCP-47, e.g. 'he-IL'      (optional — omit to list every language)
 *   - tier:         VoiceTier                 (optional)
 *
 * Returns:
 *   {
 *     providers: TtsProviderId[],     // configured providers on this deploy
 *     voices: VoiceCatalogEntry[],    // matching the filter, with pricing metadata folded in
 *     pricing: Record<VoiceTier, { displayLabel, qualityBand, usdPerMillionChars, freeMonthlyChars }>,
 *   }
 *
 * The picker UI calls this once on mount; the catalog is cached in
 * memory per provider for ~10 minutes so re-renders don't re-fetch.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const providerParam = url.searchParams.get('provider');
  const languageCode = url.searchParams.get('languageCode') ?? undefined;
  const tier = url.searchParams.get('tier') ?? undefined;

  const filter = {
    languageCode,
    tier: tier as VoiceTier | undefined,
  };

  try {
    const providers = listConfiguredProviders();

    let voices: VoiceCatalogEntry[];
    if (providerParam && providers.includes(providerParam as TtsProviderId)) {
      voices = await getSynthesizer(providerParam as TtsProviderId).listVoices(filter);
    } else if (providerParam) {
      voices = [];
    } else {
      voices = await listAllVoices(filter);
    }

    return NextResponse.json({
      providers,
      voices,
      pricing: TIER_PRICING,
    });
  } catch (err) {
    logger.error('[tts api voices] error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not list voices' },
      { status: 500 },
    );
  }
}
