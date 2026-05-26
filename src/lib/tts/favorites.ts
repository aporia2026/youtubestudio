/**
 * Favorite voices — per-user, per-browser persistence via localStorage.
 *
 * Identifies each voice by the same composite key the picker uses to
 * disambiguate selection:
 *
 *     `${providerId}|${voiceId}|${tier}`
 *
 * The tier portion matters because Chirp 3 HD's "Charon" and the
 * Gemini 2.5 "Charon" share a voiceId but are different cards in the
 * picker — favoriting one shouldn't favorite the others.
 *
 * Storage choice: localStorage over workspace settings (which would
 * sync across devices) because favorites are an inherently personal
 * preference and adding the API round-trip would block toggle UI on
 * the network. If you want cross-device sync later we can promote the
 * data to workspaces.tts_settings without changing this module's
 * external shape — callers consume `toggleFavorite` / `isFavorite`,
 * not the underlying storage.
 */

import type { TtsProviderId, VoiceRef } from './types';

const STORAGE_KEY = 'voiceover_favorite_voices_v1';

export type FavoriteKey = string;

export function favoriteKey(voice: {
  providerId: TtsProviderId;
  voiceId: string;
  tier: string;
}): FavoriteKey {
  return `${voice.providerId}|${voice.voiceId}|${voice.tier}`;
}

export function favoriteKeyFromVoiceRef(voice: VoiceRef): FavoriteKey {
  return favoriteKey({
    providerId: voice.providerId,
    voiceId: voice.voiceId,
    tier: voice.tier,
  });
}

/**
 * Read the current set of favorite keys from localStorage. Returns an
 * empty Set on the server (no window) and on malformed storage (so a
 * future schema bump doesn't bring the picker down).
 */
export function readFavorites(): Set<FavoriteKey> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

export function writeFavorites(favorites: Set<FavoriteKey>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...favorites]));
  } catch {
    // Quota exceeded / private mode — swallow. Favorites are a
    // convenience, not load-bearing data.
  }
}
