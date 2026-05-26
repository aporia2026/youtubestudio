/**
 * Recently-used voices — per-user, per-browser persistence via
 * localStorage. Same posture as favorites.ts (personal preference,
 * no API trip).
 *
 * Each entry is the composite voice key (provider|voiceId|tier — see
 * favorites.ts for why tier is part of the identity) plus a
 * lastUsedAt timestamp. The list is sorted by lastUsedAt descending
 * and capped so a power user who picks dozens of voices doesn't
 * unbounded-grow localStorage.
 *
 * recordVoiceUse() is called from the picker's onSelect — every time
 * the user explicitly picks a voice. We don't auto-record on play-
 * preview because that's exploratory, not commitment.
 */

import type { TtsProviderId, VoiceRef } from './types';
import { favoriteKey, type FavoriteKey } from './favorites';

const STORAGE_KEY = 'voiceover_recent_voices_v1';
const MAX_RECENT = 50;

export interface RecentEntry {
  key: FavoriteKey;
  lastUsedAt: number;
  providerId: TtsProviderId;
  voiceId: string;
  tier: string;
}

export function readRecent(): RecentEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is RecentEntry => {
        return (
          typeof e === 'object' &&
          e !== null &&
          typeof (e as RecentEntry).key === 'string' &&
          typeof (e as RecentEntry).lastUsedAt === 'number'
        );
      })
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

function writeRecent(entries: RecentEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_RECENT)));
  } catch {
    // Quota exceeded / private mode — swallow.
  }
}

/**
 * Record that the user picked `voice` just now. If the voice is
 * already in the recent list, its timestamp is bumped; otherwise
 * it's prepended. The list is capped at MAX_RECENT entries.
 *
 * Returns the new list so callers can update React state immediately.
 */
export function recordVoiceUse(voice: VoiceRef): RecentEntry[] {
  const key = favoriteKey({
    providerId: voice.providerId,
    voiceId: voice.voiceId,
    tier: voice.tier,
  });
  const now = Date.now();
  const existing = readRecent().filter((e) => e.key !== key);
  const next: RecentEntry[] = [
    {
      key,
      lastUsedAt: now,
      providerId: voice.providerId,
      voiceId: voice.voiceId,
      tier: voice.tier,
    },
    ...existing,
  ].slice(0, MAX_RECENT);
  writeRecent(next);
  return next;
}
