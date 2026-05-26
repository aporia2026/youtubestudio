/**
 * Google TTS voice catalog — tier inference and runtime listing.
 *
 * Google's `voices.list` API returns a flat list of all voices, and the
 * tier (Standard, WaveNet, Neural2, Polyglot, Chirp 3 HD, Studio) is
 * encoded in the voice name. We fetch the live catalog (free — no
 * quota cost), tag tier from the name pattern, and cache per-locale in
 * the function instance.
 *
 * Naming conventions (verified 2026-05-25 against the Chirp 3 HD docs
 * and the live listVoices output):
 *
 *   - Chirp 3 HD:  '<locale>-Chirp3-HD-<VoiceName>'  e.g. 'en-US-Chirp3-HD-Charon'
 *   - Studio:      '<locale>-Studio-<Letter>'         e.g. 'en-US-Studio-O'
 *   - Neural2:     '<locale>-Neural2-<Letter>'        e.g. 'en-US-Neural2-A'
 *   - WaveNet:     '<locale>-Wavenet-<Letter>'        e.g. 'en-US-Wavenet-D'
 *   - Polyglot:    '<locale>-Polyglot-<Number>'       e.g. 'en-US-Polyglot-1'
 *   - Standard:    '<locale>-Standard-<Letter>'       e.g. 'en-US-Standard-A'
 *
 * If Google ever renames or adds a tier, two things need to change:
 *   1. `TIER_PATTERNS` below.
 *   2. The `VoiceTier` union in `src/lib/tts/types.ts` AND the matching
 *      row in `src/lib/tts/cost.ts`.
 */

import type { GoogleVoiceTier, VoiceCatalogEntry, ListVoicesFilter } from '../types';
import { loadGoogleCredentials } from '../google-env';
import { logger } from '../../logger';

/**
 * Ordered most-specific to least-specific so 'Chirp3-HD' wins before
 * the bare letter-tier regexes match.
 */
const TIER_PATTERNS: ReadonlyArray<{ tier: GoogleVoiceTier; test: RegExp }> = [
  { tier: 'chirp3-hd', test: /-Chirp3-HD-/i },
  { tier: 'studio', test: /-Studio-/i },
  { tier: 'neural2', test: /-Neural2-/i },
  { tier: 'wavenet', test: /-Wavenet-/i },
  { tier: 'polyglot', test: /-Polyglot-/i },
  { tier: 'standard', test: /-Standard-/i },
];

export function inferTier(voiceName: string): GoogleVoiceTier | null {
  for (const { tier, test } of TIER_PATTERNS) {
    if (test.test(voiceName)) return tier;
  }
  return null;
}

/**
 * In-memory cache keyed by language code. Cleared when the function
 * instance recycles, which is fine — the listVoices call is free and
 * fast. Module-level cache (not per-request) so the picker page load
 * doesn't re-fetch on every navigation.
 */
const cache = new Map<string, { fetchedAt: number; entries: VoiceCatalogEntry[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

import type { protos } from '@google-cloud/text-to-speech';
type GoogleVoiceFromSdk = protos.google.cloud.texttospeech.v1.IVoice;

/**
 * Lazy SDK import — the `@google-cloud/text-to-speech` package is large
 * and we don't want it pulled into bundles that never touch Google.
 */
async function getTtsClient() {
  const creds = loadGoogleCredentials();
  if (!creds) return null;
  const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
  return new TextToSpeechClient({
    projectId: creds.projectId,
    credentials: {
      client_email: creds.clientEmail,
      private_key: creds.privateKey,
    },
  });
}

/**
 * Fetch + cache the live Google voice catalog. Returns [] when Google
 * is not configured — caller filters provider tabs accordingly.
 */
export async function listGoogleVoices(
  filter?: ListVoicesFilter,
): Promise<VoiceCatalogEntry[]> {
  const langKey = filter?.languageCode ?? '*';
  const cached = cache.get(langKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return tierFilter(cached.entries, filter?.tier);
  }

  const client = await getTtsClient();
  if (!client) return [];

  let voices: GoogleVoiceFromSdk[];
  try {
    const [result] = await client.listVoices(
      filter?.languageCode ? { languageCode: filter.languageCode } : {},
    );
    voices = result.voices ?? [];
  } catch (err) {
    logger.warn('[tts google listVoices err]', {
      detail: err instanceof Error ? err.message : String(err),
      languageCode: filter?.languageCode,
    });
    return [];
  }

  const entries: VoiceCatalogEntry[] = [];
  for (const v of voices) {
    const name = v.name ?? '';
    const tier = inferTier(name);
    if (!tier) continue;
    const languageCode = v.languageCodes?.[0] ?? filter?.languageCode ?? 'en-US';
    entries.push({
      voice: {
        providerId: 'google',
        voiceId: name,
        languageCode,
        tier,
      },
      displayName: prettifyVoiceName(name),
      gender: mapGender(v.ssmlGender),
    });

    // Synthesize Gemini-TTS variants for every Chirp 3 HD voice. The
    // Gemini models reuse the same voice names but synthesize through
    // the controllable Gemini path (input.prompt + inline audio tags).
    // See _plans note 2026-05-26 + docs.cloud.google.com/text-to-speech/docs/gemini-tts.
    if (tier === 'chirp3-hd') {
      entries.push(...synthesizeGeminiVariants({ name, languageCode, gender: v.ssmlGender }));
    }
  }

  cache.set(langKey, { fetchedAt: Date.now(), entries });
  logger.info('[tts google listVoices ok]', {
    languageCode: filter?.languageCode,
    count: entries.length,
    tiers: countByTier(entries),
  });

  return tierFilter(entries, filter?.tier);
}

/**
 * 'en-US-Chirp3-HD-Charon' → 'Charon (Chirp 3 HD)'
 * 'en-US-Studio-O'          → 'Studio O'
 * 'en-US-Wavenet-D'         → 'Wavenet D'
 * The picker UI gets a cleaner display string than the raw voice id;
 * the raw id is still available on `voice.voiceId` for analytics.
 */
function prettifyVoiceName(raw: string): string {
  const chirpMatch = raw.match(/Chirp3-HD-(.+)$/i);
  if (chirpMatch) return `${chirpMatch[1]} (Chirp 3 HD)`;
  const segments = raw.split('-');
  if (segments.length >= 4) {
    return segments.slice(2).join(' ');
  }
  return raw;
}

/**
 * For each Chirp 3 HD voice we surface Gemini-TTS sibling entries — one
 * per controllable model. The voiceId stays the same (Gemini-TTS reuses
 * the Chirp voice catalog) but the tier shifts to a Gemini tier so the
 * provider knows to set `voice.modelName` at synthesis time.
 *
 * Hebrew + Gemini 3.1 Flash TTS has a known empty-audio bug
 * (discuss.ai.google.dev/t/.../144297). We omit the 3.1 entry for he-IL
 * to keep the picker from offering a known-broken combo. The 2.5
 * variant works in Hebrew.
 */
function synthesizeGeminiVariants(args: {
  name: string;
  languageCode: string;
  gender?: string | number | null;
}): VoiceCatalogEntry[] {
  const chirpDisplay = prettifyVoiceName(args.name).replace(/ \(Chirp 3 HD\)$/, '');
  const baseGender = mapGender(args.gender);
  const out: VoiceCatalogEntry[] = [
    {
      voice: {
        providerId: 'google',
        voiceId: args.name,
        languageCode: args.languageCode,
        tier: 'gemini-25-flash-tts',
      },
      // Gemini 2.5 Flash TTS is generally available — no preview tag.
      displayName: `${chirpDisplay} (Gemini 2.5)`,
      gender: baseGender,
    },
  ];
  const isHebrew = args.languageCode.toLowerCase().startsWith('he');
  if (!isHebrew) {
    out.push({
      voice: {
        providerId: 'google',
        voiceId: args.name,
        languageCode: args.languageCode,
        tier: 'gemini-31-flash-tts',
      },
      // Gemini 3.1 Flash TTS is in Preview per Google's docs — surface
      // that on the voice card so users see it before picking, not on
      // the style-instructions panel where it was misleadingly attached
      // to the feature instead of the model.
      displayName: `${chirpDisplay} (Gemini 3.1, preview)`,
      gender: baseGender,
    });
  }
  return out;
}

function mapGender(
  raw?: string | number | null,
): 'male' | 'female' | 'neutral' | undefined {
  if (raw === null || raw === undefined) return undefined;
  // SDK returns either the enum number, the string literal name, or the
  // mixed-case proto form. Coerce to upper-case string and key off that.
  const v = String(raw).toUpperCase();
  if (v === 'MALE' || v === '1') return 'male';
  if (v === 'FEMALE' || v === '2') return 'female';
  if (v === 'NEUTRAL' || v === '3') return 'neutral';
  return undefined;
}

function tierFilter(
  entries: VoiceCatalogEntry[],
  tier?: string,
): VoiceCatalogEntry[] {
  if (!tier) return entries;
  return entries.filter((e) => e.voice.tier === tier);
}

function countByTier(entries: VoiceCatalogEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    out[e.voice.tier] = (out[e.voice.tier] ?? 0) + 1;
  }
  return out;
}

export function __clearGoogleVoiceCacheForTests(): void {
  cache.clear();
}
