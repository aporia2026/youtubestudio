'use client';

/**
 * Unified voice picker — quality-band-grouped, provider-invisible.
 *
 * Replaces the previous dual-tab picker (ElevenLabs / Google) with a
 * single grouped list organized by quality band (Draft / Standard /
 * Premium / Top-tier). The user picks a band, then picks a voice; the
 * provider is metadata on each voice card, not a primary axis.
 *
 * Top-tier voices include Google Studio ($160/1M) and ElevenLabs Pro
 * voices — both gated by `showExpensiveTiers`. The expensive-tier
 * toggle is owned by the parent (persisted to localStorage there) so
 * the picker stays presentational.
 *
 * ElevenLabs voices are only shown when the user has connected an
 * API key. The Premium band header carries an inline "Connect
 * ElevenLabs" CTA when no key is present — that's the only place
 * provider plumbing surfaces in the UI.
 *
 * See `_plans/2026-05-25-google-tts-voiceover-provider.md` §"Voice
 * catalog UX" for the design rationale.
 */

import { useEffect, useMemo, useState } from 'react';
import type { TtsProviderId, VoiceCatalogEntry } from '@/lib/tts/types';
import { TIER_PRICING, synthCostUsd } from '@/lib/tts/cost';
import {
  BAND_LABELS,
  BAND_ORDER,
  bandForVoice,
  groupVoicesByBand,
  type QualityBand,
} from '@/lib/tts/voice-bands';
import {
  favoriteKey,
  readFavorites,
  writeFavorites,
  type FavoriteKey,
} from '@/lib/tts/favorites';
import { readRecent, recordVoiceUse, type RecentEntry } from '@/lib/tts/recent';

/**
 * Browse filters. Not strictly providers — 'gemini' is a capability
 * filter (Gemini-TTS variants only, which accept input.prompt for
 * natural-language style control), and 'favorites' shows only voices
 * the user has starred. Surfaced alongside the provider options so the
 * user can narrow to "voices I'm working with" with one click.
 */
type ProviderFilter = 'all' | TtsProviderId | 'gemini' | 'favorites' | 'recent';

const RECENT_INITIAL_LIMIT = 5;

function isGeminiTier(tier: string): boolean {
  return tier === 'gemini-25-flash-tts' || tier === 'gemini-31-flash-tts';
}

interface UnifiedVoicePickerProps {
  /** ElevenLabs voices already converted to catalog-entry shape. Empty
   *  when no API key is connected. */
  elevenLabsEntries: VoiceCatalogEntry[];
  /** Map from ElevenLabs voiceId → category (premade/professional/
   *  cloned/...). Used by the band grouper to promote Pro/cloned
   *  voices into Top-tier. Empty when no ElevenLabs key. */
  elevenLabsCategoryById: Map<string, string>;
  googleEntries: VoiceCatalogEntry[];
  selectedEntry: VoiceCatalogEntry | null;
  onSelect: (entry: VoiceCatalogEntry) => void;
  /** Current language filter (BCP-47). Both the band selector and the
   *  voice list filter on this. */
  languageCode: string;
  onLanguageChange: (code: string) => void;
  /** When false, hides Top-tier entirely (Google Studio + ElevenLabs
   *  Pro). Persisted by parent. */
  showExpensiveTiers: boolean;
  onToggleExpensiveTiers: (next: boolean) => void;
  activeBand: QualityBand;
  onBandChange: (band: QualityBand) => void;
  /** Char count of the current script — drives the per-voice cost label
   *  ("$0.07 for this script"). */
  scriptCharCount: number;
  /** Whether an ElevenLabs API key is configured. Drives the inline
   *  "Connect ElevenLabs" CTA in the Premium band when false. */
  elevenLabsConnected: boolean;
  /** Whether Google credentials are configured. The picker hides the
   *  Google language dropdown options if not, but still works for
   *  ElevenLabs voices. */
  googleAvailable: boolean;
  onConnectElevenLabs: () => void;
  onDisconnectElevenLabs: () => void;
  /** Per-voice preview-play callback (ElevenLabs only — Google doesn't
   *  expose preview URLs). */
  onPreview?: (entry: VoiceCatalogEntry) => void;
  previewingVoiceId?: string | null;
}

const LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'he-IL', label: 'Hebrew' },
  { code: 'es-ES', label: 'Spanish' },
  { code: 'fr-FR', label: 'French' },
  { code: 'de-DE', label: 'German' },
  { code: 'ar-XA', label: 'Arabic' },
  { code: 'ja-JP', label: 'Japanese' },
];

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

function providerLabel(providerId: 'elevenlabs' | 'google'): string {
  return providerId === 'elevenlabs' ? 'ElevenLabs' : 'Google';
}

export function UnifiedVoicePicker({
  elevenLabsEntries,
  elevenLabsCategoryById,
  googleEntries,
  selectedEntry,
  onSelect,
  languageCode,
  onLanguageChange,
  showExpensiveTiers,
  onToggleExpensiveTiers,
  activeBand,
  onBandChange,
  scriptCharCount,
  elevenLabsConnected,
  googleAvailable,
  onConnectElevenLabs,
  onDisconnectElevenLabs,
  onPreview,
  previewingVoiceId,
}: UnifiedVoicePickerProps) {
  // Provider filter — 'all' shows mixed, 'elevenlabs' or 'google' narrows
  // the voice list to one provider while keeping the band tabs intact.
  // Local-only state: doesn't persist across sessions — it's a transient
  // browse aid, not a preference. The workspace settings' enabledProviders
  // is the right place for a sticky disable.
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  // Gender filter — narrows the voice list to a single gender. Local
  // state for the same reason as the provider filter: pure browse aid.
  const [genderFilter, setGenderFilter] = useState<'all' | 'male' | 'female' | 'neutral'>('all');
  // Dynamic search across voice names. Empty string = no filter.
  const [searchQuery, setSearchQuery] = useState('');
  // Favorites are persisted in localStorage (see lib/tts/favorites.ts).
  // Hydrate from storage on mount; toggles flush back immediately so
  // a page reload picks up the change.
  const [favorites, setFavorites] = useState<Set<FavoriteKey>>(() => new Set());
  // Last-used voices, sorted by recency. Updated by the parent's
  // onSelect via the storage-side recordVoiceUse helper; the picker
  // re-reads on every selection so its own UI stays in sync. The
  // "Show all" expander toggles between the top RECENT_INITIAL_LIMIT
  // and the full list (capped at 50 by the storage module).
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [recentExpanded, setRecentExpanded] = useState(false);
  useEffect(() => {
    setFavorites(readFavorites());
    setRecent(readRecent());
  }, []);
  function toggleFavorite(key: FavoriteKey) {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeFavorites(next);
      return next;
    });
  }

  // Filter to selected language up front, then group.
  const allEntries = useMemo(() => {
    const langPrefix = languageCode.toLowerCase().slice(0, 2);
    return [...elevenLabsEntries, ...googleEntries].filter((e) => {
      const entryLang = e.voice.languageCode.toLowerCase();
      // ElevenLabs voices are multilingual by default and often carry
      // 'en' as their tag even when they speak Hebrew. Show all
      // ElevenLabs voices for any language since the model handles it.
      if (e.voice.providerId === 'elevenlabs') return true;
      return entryLang.startsWith(langPrefix);
    });
  }, [elevenLabsEntries, googleEntries, languageCode]);

  const grouped = useMemo(
    () => groupVoicesByBand(allEntries, elevenLabsCategoryById),
    [allEntries, elevenLabsCategoryById],
  );

  // Bands surfaced in the tab strip. Top-tier is hidden unless the user
  // opted in via showExpensiveTiers OR they already have a Top-tier
  // voice selected (don't strand them on an invisible tab).
  const visibleBands = useMemo<QualityBand[]>(() => {
    const selectedBand = selectedEntry
      ? bandForVoice(
          selectedEntry,
          selectedEntry.voice.providerId === 'elevenlabs'
            ? elevenLabsCategoryById.get(selectedEntry.voice.voiceId)
            : undefined,
        )
      : null;
    return BAND_ORDER.filter((b) => {
      if (b === 'top-tier' && !showExpensiveTiers && selectedBand !== 'top-tier') {
        return false;
      }
      return true;
    });
  }, [showExpensiveTiers, selectedEntry, elevenLabsCategoryById]);

  const voicesInActiveBand = grouped.byBand[activeBand] ?? [];

  // Favorites and Recent intentionally bypass the band filter — they
  // are voice-identity filters across the whole catalog, not a band
  // view. The band tab strip stays active for visual continuity but
  // doesn't constrain the results. Provider+Gemini stay band-scoped
  // since they're capability filters within the current quality band.
  const voicesInActiveBandFiltered = useMemo(() => {
    let list: VoiceCatalogEntry[];

    if (providerFilter === 'favorites') {
      list = allEntries.filter((v) => favorites.has(favoriteKey(v.voice)));
    } else if (providerFilter === 'recent') {
      // Sort by lastUsedAt (most recent first) and apply the
      // 5-vs-all toggle. recentByKey gives O(1) lookup; missing
      // entries (favorited voice that's never been used, voice
      // outside the current catalog) are silently filtered out.
      const recentByKey = new Map<string, number>();
      for (const r of recent) recentByKey.set(r.key, r.lastUsedAt);
      const resolved = allEntries
        .map((v) => ({ v, t: recentByKey.get(favoriteKey(v.voice)) }))
        .filter((x): x is { v: VoiceCatalogEntry; t: number } => typeof x.t === 'number')
        .sort((a, b) => b.t - a.t)
        .map((x) => x.v);
      list = recentExpanded ? resolved : resolved.slice(0, RECENT_INITIAL_LIMIT);
    } else {
      list = voicesInActiveBand;
      if (providerFilter === 'gemini') {
        list = list.filter((v) => isGeminiTier(v.voice.tier));
      } else if (providerFilter !== 'all') {
        list = list.filter((v) => v.voice.providerId === providerFilter);
      }
    }

    if (genderFilter !== 'all') {
      list = list.filter((v) => v.gender === genderFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((v) => v.displayName.toLowerCase().includes(q));
    }
    return list;
  }, [
    voicesInActiveBand,
    allEntries,
    providerFilter,
    genderFilter,
    searchQuery,
    favorites,
    recent,
    recentExpanded,
  ]);

  // Total favorite + recent counts across the whole catalog — drive
  // the badges in the filter buttons regardless of active band.
  const totalFavoriteCount = useMemo(() => {
    return allEntries.filter((v) => favorites.has(favoriteKey(v.voice))).length;
  }, [allEntries, favorites]);

  const totalRecentCount = useMemo(() => {
    const recentKeys = new Set(recent.map((r) => r.key));
    return allEntries.filter((v) => recentKeys.has(favoriteKey(v.voice))).length;
  }, [allEntries, recent]);

  // Per-filter counts in the active band — drives the button labels and
  // disables a button when its filter would yield zero voices.
  const filterCountsInBand = useMemo(() => {
    let elevenlabs = 0;
    let google = 0;
    let gemini = 0;
    for (const v of voicesInActiveBand) {
      if (v.voice.providerId === 'elevenlabs') elevenlabs++;
      else if (v.voice.providerId === 'google') {
        google++;
        if (isGeminiTier(v.voice.tier)) gemini++;
      }
    }
    return { elevenlabs, google, gemini, all: voicesInActiveBand.length };
  }, [voicesInActiveBand]);

  // Per-gender counts respect the active provider filter so the gender
  // buttons reflect what's visible once both filters are applied.
  const genderCountsInBand = useMemo(() => {
    let male = 0;
    let female = 0;
    let neutral = 0;
    const list =
      providerFilter === 'all'
        ? voicesInActiveBand
        : providerFilter === 'gemini'
          ? voicesInActiveBand.filter((v) => isGeminiTier(v.voice.tier))
          : voicesInActiveBand.filter((v) => v.voice.providerId === providerFilter);
    for (const v of list) {
      if (v.gender === 'male') male++;
      else if (v.gender === 'female') female++;
      else if (v.gender === 'neutral') neutral++;
    }
    return { male, female, neutral, all: list.length };
  }, [voicesInActiveBand, providerFilter]);

  // Show the filter row only when both providers actually have voices
  // somewhere — otherwise the picker is effectively single-provider and
  // the filter adds visual weight for no choice.
  const elevenLabsAnywhere = elevenLabsEntries.length > 0;
  const googleAnywhere = googleEntries.length > 0;
  const showProviderFilter = elevenLabsAnywhere && googleAnywhere;

  return (
    <div
      className="glass rounded-xl overflow-hidden"
      style={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
    >
      {/* Header: language + counts + ElevenLabs status */}
      <div className="p-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-3 gap-2">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Voices ({grouped.total})
          </h2>
          {elevenLabsConnected && (
            <button
              onClick={onDisconnectElevenLabs}
              className="text-xs"
              style={{ color: 'var(--text-muted)' }}
              title="Disconnect ElevenLabs API key"
            >
              Disconnect ElevenLabs
            </button>
          )}
        </div>

        {/* Dynamic search — narrows the visible voice list by displayName.
            Applies on top of every other filter. */}
        <div className="relative mb-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search voices by name…"
            className="input-field w-full"
            style={{ padding: '6px 28px 6px 28px', fontSize: 12 }}
          />
          <span
            className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-muted)', fontSize: 11 }}
          >
            🔍
          </span>
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1 }}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* Language selector */}
        <select
          value={languageCode}
          onChange={(e) => onLanguageChange(e.target.value)}
          className="input-field mb-2 w-full"
          style={{ padding: '6px 10px', fontSize: 12 }}
          disabled={!googleAvailable}
          title={
            googleAvailable
              ? 'Language for Google voices (ElevenLabs voices are multilingual)'
              : 'Google not configured — ElevenLabs voices are multilingual'
          }
        >
          {LANGUAGE_OPTIONS.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* Band tab strip */}
        <div className="flex gap-1 mb-2 flex-wrap">
          {visibleBands.map((band) => {
            const count = grouped.byBand[band]?.length ?? 0;
            const isActive = activeBand === band;
            return (
              <button
                key={band}
                onClick={() => onBandChange(band)}
                className="px-2 py-1 rounded text-xs transition-all"
                style={{
                  background: isActive ? 'rgba(124,58,237,0.2)' : 'var(--bg-secondary)',
                  color: isActive
                    ? 'var(--accent-purple-bright)'
                    : count > 0
                      ? 'var(--text-secondary)'
                      : 'var(--text-muted)',
                  border: `1px solid ${isActive ? 'rgba(124,58,237,0.3)' : 'transparent'}`,
                  opacity: count > 0 ? 1 : 0.5,
                }}
                disabled={count === 0}
              >
                {BAND_LABELS[band]} {count > 0 && <span style={{ opacity: 0.7 }}>({count})</span>}
              </button>
            );
          })}
        </div>

        {/* Provider filter + expensive-tiers toggle */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          {showProviderFilter ? (
            <div className="flex gap-1 flex-wrap">
              {(
                [
                  { id: 'all' as const, label: 'All', count: filterCountsInBand.all, title: undefined },
                  { id: 'google' as const, label: 'Google', count: filterCountsInBand.google, title: undefined },
                  {
                    id: 'elevenlabs' as const,
                    label: 'ElevenLabs',
                    count: filterCountsInBand.elevenlabs,
                    title: undefined,
                  },
                  {
                    id: 'gemini' as const,
                    label: 'Style-prompt',
                    count: filterCountsInBand.gemini,
                    title:
                      'Voices that accept natural-language style instructions (Gemini 2.5 / 3.1 Flash TTS).',
                  },
                  // Favorites + Recent ignore the active band — see
                  // voicesInActiveBandFiltered. Counts here use the
                  // full catalog so the badge stays stable as the user
                  // navigates bands.
                  {
                    id: 'favorites' as const,
                    label: '⭐ Favorites',
                    count: totalFavoriteCount,
                    title:
                      'Voices you have starred. Click the ⭐ on any voice card to add.',
                  },
                  {
                    id: 'recent' as const,
                    label: '🕘 Recent',
                    count: totalRecentCount,
                    title:
                      `Voices you have picked recently — last ${RECENT_INITIAL_LIMIT} by default, expand to see all.`,
                  },
                ] as const
              ).map((opt) => {
                const isActive = providerFilter === opt.id;
                const disabled = opt.count === 0;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setProviderFilter(opt.id)}
                    disabled={disabled}
                    title={opt.title}
                    className="px-1.5 py-0.5 rounded text-[11px] transition-all"
                    style={{
                      background: isActive ? 'rgba(124,58,237,0.2)' : 'var(--bg-secondary)',
                      color: isActive
                        ? 'var(--accent-purple-bright)'
                        : disabled
                          ? 'var(--text-muted)'
                          : 'var(--text-secondary)',
                      border: `1px solid ${isActive ? 'rgba(124,58,237,0.3)' : 'transparent'}`,
                      opacity: disabled ? 0.4 : 1,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {opt.label}{' '}
                    <span style={{ opacity: 0.7 }}>({opt.count})</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {googleAnywhere ? 'Google only' : 'ElevenLabs only'}
            </p>
          )}
          <label
            className="flex items-center gap-1.5 cursor-pointer"
            style={{
              color: showExpensiveTiers
                ? 'var(--accent-purple-bright)'
                : 'var(--text-muted)',
            }}
            title="Top-tier voices: Google Studio ($160/1M) + ElevenLabs Pro. Hidden by default."
          >
            <input
              type="checkbox"
              checked={showExpensiveTiers}
              onChange={(e) => onToggleExpensiveTiers(e.target.checked)}
              style={{ width: 11, height: 11, accentColor: 'var(--accent-purple)' }}
            />
            <span className="text-[11px]">Show Top-tier</span>
          </label>
        </div>

        {/* Gender filter — appears when more than one gender is present
            in the current view. Counts respect the provider filter so
            "Male (12)" updates when you toggle ElevenLabs / Google. */}
        {(genderCountsInBand.male + genderCountsInBand.female + genderCountsInBand.neutral) > 0 && (
          <div className="flex gap-1 mt-2 flex-wrap">
            {(
              [
                { id: 'all' as const, label: 'Any gender', count: genderCountsInBand.all },
                { id: 'male' as const, label: 'Male', count: genderCountsInBand.male },
                { id: 'female' as const, label: 'Female', count: genderCountsInBand.female },
                { id: 'neutral' as const, label: 'Neutral', count: genderCountsInBand.neutral },
              ] as const
            ).map((opt) => {
              const isActive = genderFilter === opt.id;
              const disabled = opt.id !== 'all' && opt.count === 0;
              return (
                <button
                  key={opt.id}
                  onClick={() => setGenderFilter(opt.id)}
                  disabled={disabled}
                  className="px-1.5 py-0.5 rounded text-[11px] transition-all"
                  style={{
                    background: isActive ? 'rgba(124,58,237,0.2)' : 'var(--bg-secondary)',
                    color: isActive
                      ? 'var(--accent-purple-bright)'
                      : disabled
                        ? 'var(--text-muted)'
                        : 'var(--text-secondary)',
                    border: `1px solid ${isActive ? 'rgba(124,58,237,0.3)' : 'transparent'}`,
                    opacity: disabled ? 0.4 : 1,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {opt.label}
                  {opt.id !== 'all' && (
                    <span style={{ opacity: 0.7 }}> ({opt.count})</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Voice list */}
      <div className="overflow-y-auto flex-1">
        {/* Inline ElevenLabs CTA in Premium / Top-tier bands when no key */}
        {!elevenLabsConnected && (activeBand === 'premium' || activeBand === 'top-tier') && (
          <div
            className="m-3 p-3 rounded-lg"
            style={{
              background: 'rgba(124,58,237,0.08)',
              border: '1px solid rgba(124,58,237,0.2)',
            }}
          >
            <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
              Connect ElevenLabs to unlock more {BAND_LABELS[activeBand]} voices.
            </p>
            <button
              onClick={onConnectElevenLabs}
              className="text-xs font-medium"
              style={{ color: 'var(--accent-purple-bright)' }}
            >
              Connect ElevenLabs →
            </button>
          </div>
        )}

        {voicesInActiveBandFiltered.length === 0 ? (
          <div className="p-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            {providerFilter === 'all'
              ? `No ${BAND_LABELS[activeBand]} voices for ${LANGUAGE_OPTIONS.find((l) => l.code === languageCode)?.label ?? languageCode}.`
              : providerFilter === 'gemini'
                ? `No style-prompt voices in ${BAND_LABELS[activeBand]} for this language.`
                : `No ${providerFilter === 'google' ? 'Google' : 'ElevenLabs'} ${BAND_LABELS[activeBand]} voices.`}
          </div>
        ) : (
          voicesInActiveBandFiltered.map((entry) => {
            // Disambiguate by tier as well as voiceId because Chirp 3 HD
            // and the Gemini-TTS variants share voiceId (the API uses
            // the same voice catalog, the model differs via
            // `voice.modelName`). Without the tier check, picking
            // "Charon (Gemini 3.1)" would highlight all three Charon
            // cards.
            const isSelected =
              selectedEntry?.voice.providerId === entry.voice.providerId &&
              selectedEntry?.voice.voiceId === entry.voice.voiceId &&
              selectedEntry?.voice.tier === entry.voice.tier;
            // The parent identifies the currently-playing preview by a
            // composite key (provider|voiceId|tier) so the Chirp +
            // Gemini variants of the same voice don't all light up when
            // one plays. Picker computes the same key for each card.
            const elemKey = `${entry.voice.providerId}|${entry.voice.voiceId}|${entry.voice.tier}`;
            const isPreviewing = previewingVoiceId === elemKey;
            const cost = synthCostUsd(entry.voice.tier, scriptCharCount);
            const pricing = TIER_PRICING[entry.voice.tier];
            const favKey = favoriteKey(entry.voice);
            const isFavorite = favorites.has(favKey);
            return (
              <div
                key={`${entry.voice.providerId}-${entry.voice.voiceId}-${entry.voice.tier}`}
                onClick={() => {
                  // Record the use BEFORE calling onSelect so the
                  // Recent list reflects the pick immediately even
                  // if the parent's selection handler does async
                  // work that delays a re-render.
                  setRecent(recordVoiceUse(entry.voice));
                  onSelect(entry);
                }}
                className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-all"
                style={{
                  background: isSelected ? 'rgba(124,58,237,0.15)' : 'transparent',
                  borderLeft: isSelected
                    ? '2px solid var(--accent-purple)'
                    : '2px solid transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-card-hover)';
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                }}
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm"
                  style={{
                    background: isSelected ? 'rgba(124,58,237,0.3)' : 'var(--bg-secondary)',
                  }}
                >
                  🎤
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className="text-sm font-medium truncate"
                    style={{
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {entry.displayName}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {providerLabel(entry.voice.providerId)}
                    {entry.gender ? ` · ${entry.gender}` : ''}
                    {' · '}
                    {pricing?.displayLabel ?? entry.voice.tier}
                    {scriptCharCount > 0 && ` · ${formatCost(cost)}`}
                  </p>
                </div>
                {/* Favorite star — toggles per voice. Persists in
                    localStorage via the favorites module. Click target
                    stops propagation so it doesn't also select the
                    voice. */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFavorite(favKey);
                  }}
                  className="p-1.5 rounded-lg shrink-0 transition-all"
                  style={{
                    background: 'transparent',
                    color: isFavorite ? '#fbbf24' : 'var(--text-muted)',
                  }}
                  title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                  aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                >
                  {isFavorite ? '★' : '☆'}
                </button>
                {/* Play button shows for every voice. ElevenLabs voices
                    use entry.previewUrl directly; Google voices fetch a
                    sample from /api/tts/preview on first click (cached
                    server-side after the first generation). The parent
                    onPreview callback owns the dispatch. */}
                {onPreview && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreview(entry);
                    }}
                    className="p-1.5 rounded-lg shrink-0 transition-all"
                    style={{
                      background: isPreviewing
                        ? 'rgba(124,58,237,0.2)'
                        : 'var(--bg-secondary)',
                      color: isPreviewing
                        ? 'var(--accent-purple-bright)'
                        : 'var(--text-muted)',
                    }}
                    title="Preview voice"
                  >
                    {isPreviewing ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="4" width="4" height="16" />
                        <rect x="14" y="4" width="4" height="16" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            );
          })
        )}

        {/* Show-more / show-less for the Recent filter only. The
            initial state shows the top RECENT_INITIAL_LIMIT picks;
            expanding reveals the rest of the 50-entry recent list.
            Stays hidden under other filters. */}
        {providerFilter === 'recent' && totalRecentCount > RECENT_INITIAL_LIMIT && (
          <button
            onClick={() => setRecentExpanded((v) => !v)}
            className="w-full px-4 py-2 text-xs transition-all"
            style={{
              background: 'transparent',
              color: 'var(--accent-purple-bright)',
              borderTop: '1px solid var(--border)',
            }}
          >
            {recentExpanded
              ? `Show only the latest ${RECENT_INITIAL_LIMIT}`
              : `Show all ${totalRecentCount} recent`}
          </button>
        )}
      </div>
    </div>
  );
}
