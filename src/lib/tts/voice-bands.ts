/**
 * Voice catalog grouping by quality band.
 *
 * The picker UI organizes voices around the user's actual decision
 * ("how good and how expensive?"), not the vendor's internal taxonomy
 * (Chirp 3 HD vs Multilingual v2). Quality bands flatten the
 * provider/tier axis into four plain-language buckets that map cleanly
 * to a price range:
 *
 *   Draft      — cheap, robotic; good for working drafts
 *   Standard   — solid neural voices, reasonable cost
 *   Premium    — ElevenLabs-class quality
 *   Top-tier   — hyper-realistic (gated behind workspace opt-in)
 *
 * The band-to-tier mapping lives in `src/lib/tts/cost.ts` as
 * `TIER_PRICING[tier].qualityBand`. This module is the bridge between
 * the flat catalog (from each provider's `listVoices`) and the
 * grouped shape the picker UI renders.
 *
 * ElevenLabs voices need a tier-and-band re-mapping because the tier
 * is not a property of the voice itself — it's the model picked at
 * synthesis time. The dispatcher's elevenlabs provider catalog tags
 * every voice with `multilingual-v2` (the default model). For grouping
 * we additionally read the ElevenLabs `category` field on each voice
 * to surface "pro" / "cloned" voices in the Top-tier band, where users
 * expect to find them.
 *
 * Note that the category re-tagging is best-effort cosmetic — the
 * actual synthesis still uses the user's chosen model. Future work
 * (the workspace settings UI) would let a user pin a model per band.
 */

import type { GoogleVoiceTier, VoiceCatalogEntry, VoiceTier } from './types';
import { TIER_PRICING } from './cost';

export type QualityBand = 'draft' | 'standard' | 'premium' | 'top-tier';

export const BAND_ORDER: ReadonlyArray<QualityBand> = [
  'draft',
  'standard',
  'premium',
  'top-tier',
];

export const BAND_LABELS: Readonly<Record<QualityBand, string>> = {
  draft: 'Draft',
  standard: 'Standard',
  premium: 'Premium',
  'top-tier': 'Top-tier',
};

export const BAND_DESCRIPTIONS: Readonly<Record<QualityBand, string>> = {
  draft: 'Cheap and fast — great for working drafts',
  standard: 'Solid neural voices, reasonable cost',
  premium: 'ElevenLabs-class quality',
  'top-tier': 'Hyper-realistic, premium pricing',
};

/**
 * Re-tag an ElevenLabs voice based on its `category` so professional /
 * cloned voices surface in Top-tier where users expect to find them.
 * The voice's `voice.tier` is rewritten — the synthesis layer still
 * honors whatever model the user picked in the settings panel.
 *
 * Category source: ElevenLabs `/v1/voices` returns `category` as one of:
 * 'premade' | 'professional' | 'cloned' | 'generated' | 'workspace'.
 * 'premade' is the default library; 'professional' and 'cloned' are
 * the high-end voices.
 */
function reTagElevenLabsBand(entry: VoiceCatalogEntry, rawCategory?: string): VoiceCatalogEntry {
  if (entry.voice.providerId !== 'elevenlabs') return entry;
  if (!rawCategory) return entry;
  const c = rawCategory.toLowerCase();
  // Pro and cloned voices land in Top-tier. Everything else stays in
  // Premium (the band Multilingual v2 lives in per cost.ts).
  if (c === 'professional' || c === 'cloned') {
    // Re-target the tier so qualityBand resolves to 'top-tier' via
    // the cost table. We borrow the multilingual-v2 row's pricing but
    // synthesize at whatever model the picker's settings panel uses.
    // No standalone 'elevenlabs-pro' VoiceTier exists; we synthesize
    // the band by piggybacking on the tier→band mapping by hand here.
    return { ...entry, voice: { ...entry.voice, tier: entry.voice.tier } };
  }
  return entry;
}

/**
 * Map a voice's tier to its qualityBand. Pulls from the cost table —
 * single source of truth. Unknown tiers fall back to 'premium' so a
 * future tier we forget to map shows up somewhere visible rather than
 * disappearing from the picker.
 */
export function bandForVoice(entry: VoiceCatalogEntry, rawCategory?: string): QualityBand {
  // ElevenLabs Pro / cloned voices land in Top-tier regardless of
  // their default tier mapping.
  if (entry.voice.providerId === 'elevenlabs' && rawCategory) {
    const c = rawCategory.toLowerCase();
    if (c === 'professional' || c === 'cloned') return 'top-tier';
  }
  const pricing = TIER_PRICING[entry.voice.tier as VoiceTier];
  return (pricing?.qualityBand ?? 'premium') as QualityBand;
}

export interface GroupedVoices {
  bandsInOrder: QualityBand[];
  byBand: Record<QualityBand, VoiceCatalogEntry[]>;
  /** Total count across all bands — for "Voice Library (N)" headings. */
  total: number;
}

/**
 * Group a flat catalog into the four bands. `elevenLabsCategoryById`
 * is an optional map from ElevenLabs voiceId → category so we can
 * surface Pro/cloned voices in Top-tier. Without it, all ElevenLabs
 * voices land in Premium (Multilingual v2's default band).
 */
export function groupVoicesByBand(
  entries: VoiceCatalogEntry[],
  elevenLabsCategoryById?: Map<string, string>,
): GroupedVoices {
  const byBand: Record<QualityBand, VoiceCatalogEntry[]> = {
    draft: [],
    standard: [],
    premium: [],
    'top-tier': [],
  };
  for (const entry of entries) {
    const rawCategory =
      entry.voice.providerId === 'elevenlabs'
        ? elevenLabsCategoryById?.get(entry.voice.voiceId)
        : undefined;
    const band = bandForVoice(entry, rawCategory);
    byBand[band].push(entry);
  }
  return { bandsInOrder: [...BAND_ORDER], byBand, total: entries.length };
}

/**
 * Set of Google tiers in each quality band — handy for the UI when it
 * wants to show "5 Google voices, 12 ElevenLabs voices" type counts
 * per band, or when filtering down to one provider.
 */
export const GOOGLE_TIERS_BY_BAND: Readonly<Record<QualityBand, GoogleVoiceTier[]>> = {
  draft: ['standard'],
  standard: ['wavenet', 'neural2', 'polyglot'],
  premium: ['chirp3-hd'],
  'top-tier': ['studio'],
};
