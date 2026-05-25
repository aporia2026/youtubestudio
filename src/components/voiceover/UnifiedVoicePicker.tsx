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

import { useMemo, useState } from 'react';
import type { TtsProviderId, VoiceCatalogEntry } from '@/lib/tts/types';
import { TIER_PRICING, synthCostUsd } from '@/lib/tts/cost';
import {
  BAND_LABELS,
  BAND_ORDER,
  bandForVoice,
  groupVoicesByBand,
  type QualityBand,
} from '@/lib/tts/voice-bands';

type ProviderFilter = 'all' | TtsProviderId;

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
  const voicesInActiveBandFiltered = useMemo(
    () =>
      providerFilter === 'all'
        ? voicesInActiveBand
        : voicesInActiveBand.filter((v) => v.voice.providerId === providerFilter),
    [voicesInActiveBand, providerFilter],
  );

  // Per-provider counts in the active band — drives the filter button
  // labels and disables a button when its provider has no voices in
  // the current band.
  const providerCountsInBand = useMemo(() => {
    let elevenlabs = 0;
    let google = 0;
    for (const v of voicesInActiveBand) {
      if (v.voice.providerId === 'elevenlabs') elevenlabs++;
      else if (v.voice.providerId === 'google') google++;
    }
    return { elevenlabs, google, all: voicesInActiveBand.length };
  }, [voicesInActiveBand]);

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
            <div className="flex gap-1">
              {(
                [
                  { id: 'all' as const, label: 'All', count: providerCountsInBand.all },
                  { id: 'google' as const, label: 'Google', count: providerCountsInBand.google },
                  {
                    id: 'elevenlabs' as const,
                    label: 'ElevenLabs',
                    count: providerCountsInBand.elevenlabs,
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
            {providerFilter !== 'all'
              ? `No ${providerFilter === 'google' ? 'Google' : 'ElevenLabs'} ${BAND_LABELS[activeBand]} voices.`
              : `No ${BAND_LABELS[activeBand]} voices for ${LANGUAGE_OPTIONS.find((l) => l.code === languageCode)?.label ?? languageCode}.`}
          </div>
        ) : (
          voicesInActiveBandFiltered.map((entry) => {
            const isSelected =
              selectedEntry?.voice.providerId === entry.voice.providerId &&
              selectedEntry?.voice.voiceId === entry.voice.voiceId;
            const isPreviewing =
              previewingVoiceId &&
              previewingVoiceId === entry.voice.voiceId;
            const cost = synthCostUsd(entry.voice.tier, scriptCharCount);
            const pricing = TIER_PRICING[entry.voice.tier];
            return (
              <div
                key={`${entry.voice.providerId}-${entry.voice.voiceId}`}
                onClick={() => onSelect(entry)}
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
                {entry.previewUrl && onPreview && (
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
      </div>
    </div>
  );
}
