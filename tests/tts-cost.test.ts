import { describe, expect, it } from 'vitest';
import {
  TIER_PRICING,
  GOOGLE_STT_USD_PER_MINUTE,
  ELEVENLABS_SCRIBE_USD_PER_HOUR,
  synthCostUsd,
  alignCostUsd,
} from '@/lib/tts/cost';

// Pricing table is the source of truth for everything user-facing: the
// picker estimate, the per-asset costUsd written to media_assets, and
// future usage analytics. Pinning the math here so a typo in the table
// gets caught instead of silently shifting every invoice estimate.

describe('TTS pricing — per-tier rates (verified 2026-05-25)', () => {
  it('Google tiers carry the live published rates', () => {
    expect(TIER_PRICING.standard.usdPerMillionChars).toBe(4);
    expect(TIER_PRICING.wavenet.usdPerMillionChars).toBe(4);
    expect(TIER_PRICING.neural2.usdPerMillionChars).toBe(16);
    expect(TIER_PRICING.polyglot.usdPerMillionChars).toBe(16);
    expect(TIER_PRICING['chirp3-hd'].usdPerMillionChars).toBe(30);
    expect(TIER_PRICING.studio.usdPerMillionChars).toBe(160);
  });

  it('Google free-tier quotas match the docs', () => {
    expect(TIER_PRICING.standard.freeMonthlyChars).toBe(4_000_000);
    expect(TIER_PRICING.wavenet.freeMonthlyChars).toBe(1_000_000);
    expect(TIER_PRICING['chirp3-hd'].freeMonthlyChars).toBe(1_000_000);
    expect(TIER_PRICING.studio.freeMonthlyChars).toBe(1_000_000);
    expect(TIER_PRICING.neural2.freeMonthlyChars).toBe(0);
    expect(TIER_PRICING.polyglot.freeMonthlyChars).toBe(0);
  });

  it('Studio is the most expensive *Google* tier — gating it behind workspace opt-in matters', () => {
    const googleTiers = ['standard', 'wavenet', 'neural2', 'polyglot', 'chirp3-hd', 'studio'] as const;
    const prices = googleTiers.map((t) => TIER_PRICING[t].usdPerMillionChars);
    expect(Math.max(...prices)).toBe(160);
    expect(TIER_PRICING.studio.qualityBand).toBe('top-tier');
  });
});

describe('synthCostUsd — per-character math', () => {
  it('2,500-char Chirp 3 HD narration costs ~$0.075', () => {
    const cost = synthCostUsd('chirp3-hd', 2500);
    expect(cost).toBeCloseTo(0.075, 4);
  });

  it('2,500-char Studio narration costs ~$0.40 (gated behind opt-in for a reason)', () => {
    const cost = synthCostUsd('studio', 2500);
    expect(cost).toBeCloseTo(0.4, 4);
  });

  it('2,500-char ElevenLabs Multilingual v2 costs ~$0.75', () => {
    const cost = synthCostUsd('multilingual-v2', 2500);
    expect(cost).toBeCloseTo(0.75, 4);
  });

  it('zero chars produces zero cost (no negative rates leaking through)', () => {
    expect(synthCostUsd('chirp3-hd', 0)).toBe(0);
    expect(synthCostUsd('chirp3-hd', -100)).toBe(0);
  });
});

describe('alignCostUsd — per-duration math', () => {
  it('120s (2-min narration) via Google STT ≈ $0.048', () => {
    const cost = alignCostUsd('google-stt', 120);
    expect(cost).toBeCloseTo(120 / 60 * GOOGLE_STT_USD_PER_MINUTE, 6);
    expect(cost).toBeCloseTo(0.048, 4);
  });

  it('1 hour of audio via ElevenLabs Scribe = $0.22', () => {
    expect(alignCostUsd('elevenlabs', 3600)).toBeCloseTo(ELEVENLABS_SCRIBE_USD_PER_HOUR, 6);
  });
});
