/**
 * TTS pricing — single source of truth.
 *
 * Verified 2026-05-25 against:
 *   - https://costbench.com/software/ai-voice-tools/google-cloud-text-to-speech/
 *   - https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
 *   - https://elevenlabs.io/pricing
 *
 * Updating these numbers is a deliberate event — they show up in the
 * picker UI cost estimate and in `media_assets.metadata.costUsd`, which
 * downstream usage analytics depend on. Note any change in the commit
 * message so future audits can correlate the price shift to a date.
 *
 * Cost estimates are DISPLAY values. The vendor invoice is the bill of
 * record; reconciliation between estimated and actual sums is a follow-
 * up job (see plan section "Security → cost reconcile").
 */

import type { VoiceTier } from './types';

interface TierPricing {
  /** USD per 1,000,000 characters. */
  usdPerMillionChars: number;
  /** Free quota per month (characters). Subtract this from the monthly
   *  rollup before billing the customer (display-side only). */
  freeMonthlyChars: number;
  /** Human-readable label for the cost-display column in the picker. */
  displayLabel: string;
  /** Plain-language quality band used for the picker's primary grouping
   *  (see plan section "Voice catalog UX"). */
  qualityBand: 'draft' | 'standard' | 'premium' | 'top-tier';
}

/**
 * Pricing table. Keys are the `VoiceTier` union from `types.ts`. Adding
 * a new tier means: add the enum value in types.ts AND a row here AND a
 * catalog entry in the matching provider. TypeScript catches the first
 * two; the catalog file has its own enforcement (see voices/google-catalog.ts).
 */
export const TIER_PRICING: Record<VoiceTier, TierPricing> = {
  // Google
  standard: {
    usdPerMillionChars: 4,
    freeMonthlyChars: 4_000_000,
    displayLabel: 'Draft',
    qualityBand: 'draft',
  },
  wavenet: {
    usdPerMillionChars: 4,
    freeMonthlyChars: 1_000_000,
    displayLabel: 'Standard',
    qualityBand: 'standard',
  },
  neural2: {
    usdPerMillionChars: 16,
    freeMonthlyChars: 0,
    displayLabel: 'Standard+',
    qualityBand: 'standard',
  },
  polyglot: {
    usdPerMillionChars: 16,
    freeMonthlyChars: 0,
    displayLabel: 'Multilingual',
    qualityBand: 'standard',
  },
  'chirp3-hd': {
    usdPerMillionChars: 30,
    freeMonthlyChars: 1_000_000,
    displayLabel: 'Premium',
    qualityBand: 'premium',
  },
  studio: {
    usdPerMillionChars: 160,
    freeMonthlyChars: 1_000_000,
    displayLabel: 'Top-tier',
    qualityBand: 'top-tier',
  },

  // ElevenLabs — pricing here is per-character at the published
  // Multilingual v2 rate, normalized to per-1M chars for symmetry with
  // Google. Source: elevenlabs.io/pricing (Pro plan = $0.30 per 1K chars
  // = $300 per 1M, verified 2026-05-25).
  'multilingual-v2': {
    usdPerMillionChars: 300,
    freeMonthlyChars: 0,
    displayLabel: 'Premium (ElevenLabs)',
    qualityBand: 'premium',
  },
  'turbo-v2-5': {
    usdPerMillionChars: 150,
    freeMonthlyChars: 0,
    displayLabel: 'Standard (ElevenLabs)',
    qualityBand: 'standard',
  },
  'turbo-v2': {
    usdPerMillionChars: 150,
    freeMonthlyChars: 0,
    displayLabel: 'Standard (ElevenLabs)',
    qualityBand: 'standard',
  },
  'monolingual-v1': {
    usdPerMillionChars: 150,
    freeMonthlyChars: 0,
    displayLabel: 'Standard (ElevenLabs)',
    qualityBand: 'standard',
  },
};

/**
 * Google Speech-to-Text v2 standard model — used for aligning Google
 * voiceovers. Verified 2026-05-25 at cloud.google.com/speech-to-text/pricing.
 * Per-minute, not per-character (audio-billed).
 */
export const GOOGLE_STT_USD_PER_MINUTE = 0.024;

/**
 * ElevenLabs Scribe STT pricing (used by the ElevenLabs aligner). The
 * existing `voiceover-alignment-cache.ts` carries the same constant —
 * keep these in sync. Verified 2026-05-13 at elevenlabs.io/pricing.
 */
export const ELEVENLABS_SCRIBE_USD_PER_HOUR = 0.22;

/**
 * Per-character cost. Used by `Synthesizer.estimateCost` so the picker
 * can show the cost of the current script without a network round trip.
 */
export function synthCostUsd(tier: VoiceTier, charCount: number): number {
  const price = TIER_PRICING[tier];
  if (!price) return 0;
  const billable = Math.max(0, charCount);
  return (billable / 1_000_000) * price.usdPerMillionChars;
}

/**
 * Estimated alignment cost in USD for an audio of `durationSec`. Caller
 * picks which constant applies (Google STT vs ElevenLabs Scribe).
 */
export function alignCostUsd(
  aligner: 'google-stt' | 'elevenlabs',
  durationSec: number,
): number {
  if (aligner === 'google-stt') {
    return (durationSec / 60) * GOOGLE_STT_USD_PER_MINUTE;
  }
  return (durationSec / 3600) * ELEVENLABS_SCRIBE_USD_PER_HOUR;
}
