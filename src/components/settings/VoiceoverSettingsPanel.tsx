'use client';

/**
 * Workspace-level voiceover preferences.
 *
 * Backs the `tts_settings` JSONB column on workspaces (migration 0089)
 * via /api/workspace/tts-settings. Controls four things that affect
 * every voiceover generated in the workspace:
 *
 *   - Default provider          → picker pre-selects this on load
 *   - Default language          → picker filter starts here
 *   - Allow Studio tier         → cost-safety gate (server-enforced)
 *   - Enabled providers         → workspaces under NDA can disable one
 *
 * The server is authoritative on the Studio gate and enabled-providers
 * allowlist — /api/tts/generate rejects requests that violate them,
 * not just the UI. See src/lib/tts/workspace-settings.ts.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { TtsProviderId, VoiceCatalogEntry } from '@/lib/tts/types';

interface StoredSettings {
  defaultProvider?: TtsProviderId;
  defaultVoiceId?: string;
  defaultVoiceProvider?: TtsProviderId;
  defaultLanguageCode?: string;
  allowStudioTier?: boolean;
  enabledProviders?: TtsProviderId[];
}

interface EffectiveSettings {
  defaultProvider: TtsProviderId;
  defaultVoiceId: string | null;
  defaultVoiceProvider: TtsProviderId;
  defaultLanguageCode: string;
  allowStudioTier: boolean;
  enabledProviders: TtsProviderId[];
}

const LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'he-IL', label: 'Hebrew' },
  { code: 'es-ES', label: 'Spanish' },
  { code: 'fr-FR', label: 'French' },
  { code: 'de-DE', label: 'German' },
  { code: 'ar-XA', label: 'Arabic' },
  { code: 'ja-JP', label: 'Japanese' },
];

export function VoiceoverSettingsPanel() {
  const [stored, setStored] = useState<StoredSettings>({});
  const [effective, setEffective] = useState<EffectiveSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Voices for the currently-chosen default provider + language combo.
  // Refetched whenever either changes — small payload, free Google API
  // call, ElevenLabs uses the server env key.
  const [availableVoices, setAvailableVoices] = useState<VoiceCatalogEntry[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspace/tts-settings')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setStored(data.stored ?? {});
        setEffective(data.effective ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refetch the voice catalog whenever the chosen default provider or
  // language changes. The dropdown below depends on this.
  useEffect(() => {
    if (!effective) return;
    let cancelled = false;
    setVoicesLoading(true);
    fetch(
      `/api/tts/voices?provider=${encodeURIComponent(effective.defaultProvider)}&languageCode=${encodeURIComponent(effective.defaultLanguageCode)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setAvailableVoices((data?.voices as VoiceCatalogEntry[]) ?? []);
      })
      .catch(() => {
        if (!cancelled) setAvailableVoices([]);
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effective?.defaultProvider, effective?.defaultLanguageCode]);

  async function patch(next: StoredSettings) {
    setSaving(true);
    try {
      const res = await fetch('/api/workspace/tts-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setStored(data.stored);
      setEffective(data.effective);
      toast.success('Voiceover settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function toggleProvider(p: TtsProviderId) {
    const current = effective?.enabledProviders ?? ['elevenlabs', 'google'];
    const next = current.includes(p)
      ? current.filter((x) => x !== p)
      : [...current, p];
    // Refuse to disable the last enabled provider — the server would
    // accept the empty list as "no restriction" but that's confusing UX.
    if (next.length === 0) {
      toast.error('At least one provider must stay enabled.');
      return;
    }
    patch({ enabledProviders: next });
  }

  if (loading || !effective) {
    return (
      <div className="space-y-4">
        <div className="glass rounded-xl p-5">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading voiceover settings…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Voiceover defaults
        </h2>
        <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
          Apply across the voiceover studio, the editor regenerate flow, and the auto-pipeline.
        </p>

        <div className="space-y-4">
          {/* Default provider */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Default provider
            </label>
            <select
              value={effective.defaultProvider}
              onChange={(e) => patch({ defaultProvider: e.target.value as TtsProviderId })}
              disabled={saving}
              className="input-field"
              style={{ padding: '6px 10px', fontSize: 13, maxWidth: 280 }}
            >
              <option value="elevenlabs">ElevenLabs</option>
              <option value="google">Google Cloud</option>
            </select>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              The picker pre-selects voices from this provider on load. Users can switch per voiceover.
            </p>
          </div>

          {/* Default language */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Default language
            </label>
            <select
              value={effective.defaultLanguageCode}
              onChange={(e) => patch({ defaultLanguageCode: e.target.value })}
              disabled={saving}
              className="input-field"
              style={{ padding: '6px 10px', fontSize: 13, maxWidth: 280 }}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              Used for Google voice filtering. ElevenLabs voices are multilingual and listed for any language.
            </p>
          </div>

          {/* Default voice */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Default voice
            </label>
            {voicesLoading ? (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading voices…</p>
            ) : availableVoices.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {effective.defaultProvider === 'elevenlabs'
                  ? 'No ElevenLabs voices available — check that ELEVENLABS_API_KEY is configured server-side.'
                  : `No ${effective.defaultProvider} voices for ${effective.defaultLanguageCode}.`}
              </p>
            ) : (
              <select
                value={
                  // Only honor the stored default if its provider matches the
                  // currently-selected default provider — otherwise the dropdown
                  // would have a value that isn't in its options.
                  effective.defaultVoiceProvider === effective.defaultProvider
                    ? (effective.defaultVoiceId ?? '')
                    : ''
                }
                onChange={(e) => {
                  if (!e.target.value) {
                    patch({ defaultVoiceId: undefined, defaultVoiceProvider: undefined });
                  } else {
                    patch({
                      defaultVoiceId: e.target.value,
                      defaultVoiceProvider: effective.defaultProvider,
                    });
                  }
                }}
                disabled={saving}
                className="input-field"
                style={{ padding: '6px 10px', fontSize: 13, maxWidth: 360 }}
              >
                <option value="">— Picker chooses (best of selected tier) —</option>
                {availableVoices.map((v) => (
                  <option key={v.voice.voiceId} value={v.voice.voiceId}>
                    {v.displayName} ({v.voice.tier}
                    {v.gender ? `, ${v.gender}` : ''})
                  </option>
                ))}
              </select>
            )}
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              The voiceover studio pre-selects this voice on load. Leave at &quot;Picker chooses&quot;
              to let the picker pick the best voice for the active quality band.
            </p>
          </div>
        </div>
      </div>

      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Cost safety
        </h2>
        <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
          Server-enforced guards. The UI and the API both honor these — disabled options can&apos;t be reached.
        </p>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={effective.allowStudioTier}
            onChange={(e) => patch({ allowStudioTier: e.target.checked })}
            disabled={saving}
            style={{ marginTop: 3, width: 14, height: 14, accentColor: 'var(--accent-purple)' }}
          />
          <div className="flex-1">
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Allow Google Studio tier ($160 per 1M characters)
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Off by default. Google Studio is 5× the price of Chirp 3 HD and 40× the price of WaveNet.
              An auto-pipeline batch on Studio can yield a four-figure bill — keep this off unless you
              have a deliberate reason.
            </p>
          </div>
        </label>
      </div>

      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Enabled providers
        </h2>
        <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
          Disable a provider entirely if compliance / NDA terms forbid sending script content there.
        </p>

        <div className="space-y-2">
          {(['elevenlabs', 'google'] as const).map((p) => {
            const enabled = effective.enabledProviders.includes(p);
            return (
              <label key={p} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => toggleProvider(p)}
                  disabled={saving}
                  style={{ width: 14, height: 14, accentColor: 'var(--accent-purple)' }}
                />
                <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {p === 'elevenlabs' ? 'ElevenLabs' : 'Google Cloud TTS'}
                </span>
                {!enabled && (
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    (hidden from the picker; API rejects requests)
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>

      {stored.defaultProvider === undefined && stored.allowStudioTier === undefined && (
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Showing default values. Make any change to start saving workspace-specific settings.
        </p>
      )}
    </div>
  );
}
