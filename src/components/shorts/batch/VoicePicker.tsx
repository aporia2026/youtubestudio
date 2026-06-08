'use client';

/**
 * VoicePicker — fetches the configured TTS providers + their voice
 * catalogs from /api/tts/voices and renders a single dropdown the
 * user can pick from. No more typing raw voice ids.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Voices are grouped by provider in the dropdown, labelled with
 * name + language + gender. A small "▶ Preview" button to the side
 * plays the provider's preview URL when one exists (ElevenLabs ships
 * them; Google does not).
 */

import { useEffect, useMemo, useRef, useState } from 'react';

interface VoiceCatalogEntry {
  voice: {
    providerId: 'elevenlabs' | 'google';
    voiceId: string;
    languageCode: string;
  };
  displayName: string;
  description?: string;
  gender?: 'male' | 'female' | 'neutral';
  previewUrl?: string;
}

interface VoicesResponse {
  providers: string[];
  voices: VoiceCatalogEntry[];
}

export function VoicePicker({
  value,
  onChange,
  required,
}: {
  value: string;
  onChange: (voiceId: string) => void;
  required?: boolean;
}) {
  const [voices, setVoices] = useState<VoiceCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/tts/voices')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: VoicesResponse) => {
        if (cancelled) return;
        setVoices(data.voices ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load voices');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    const out = new Map<string, VoiceCatalogEntry[]>();
    for (const v of voices) {
      const key = v.voice.providerId;
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(v);
    }
    for (const list of out.values()) {
      list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    return out;
  }, [voices]);

  const active = useMemo(
    () => voices.find((v) => v.voice.voiceId === value),
    [voices, value],
  );

  const playPreview = () => {
    if (!active?.previewUrl) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(active.previewUrl);
    } else {
      audioRef.current.src = active.previewUrl;
    }
    audioRef.current.play().catch(() => {
      /* autoplay blocked or fetch failed — silent */
    });
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={loading}
          className="flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
        >
          <option value="">
            {loading ? 'Loading voices…' : required ? '— pick a voice —' : 'No voice'}
          </option>
          {Array.from(grouped.entries()).map(([provider, list]) => (
            <optgroup key={provider} label={providerLabel(provider)}>
              {list.map((v) => (
                <option key={`${provider}:${v.voice.voiceId}`} value={v.voice.voiceId}>
                  {voiceLabel(v)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {active?.previewUrl && (
          <button
            type="button"
            onClick={playPreview}
            className="shrink-0 rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-white/[0.05] hover:text-[var(--text-primary)]"
            title="Play sample"
          >
            ▶ Preview
          </button>
        )}
      </div>
      {active?.description && (
        <p className="mt-1 text-xs text-[var(--text-muted)]">{active.description}</p>
      )}
      {error && (
        <p className="mt-1 text-xs text-[var(--accent-yellow)]">{error}</p>
      )}
    </div>
  );
}

function providerLabel(id: string): string {
  if (id === 'elevenlabs') return 'ElevenLabs';
  if (id === 'google') return 'Google Cloud TTS';
  return id;
}

function voiceLabel(v: VoiceCatalogEntry): string {
  const parts = [v.displayName];
  if (v.voice.languageCode) parts.push(v.voice.languageCode);
  if (v.gender) parts.push(`(${v.gender})`);
  return parts.join(' · ');
}
