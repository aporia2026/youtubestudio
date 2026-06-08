'use client';

/**
 * VoicePicker — popover-based voice picker with search + favorites.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * UX:
 *   - Closed state: a single button showing the current voice
 *     (display name · language · gender) so the user can see at a
 *     glance what's selected.
 *   - Open state: a popover with:
 *       · A search input at the top (filters by name, description,
 *         language, gender). Auto-focused on open.
 *       · "Favorites" section pinned to the top when populated.
 *       · "All voices" grouped by provider (ElevenLabs / Google).
 *       · Per-voice star toggle that POSTs to
 *         /api/user/settings/tts-favorites with action='toggle'.
 *         Optimistic UI: the star flips immediately and reverts on
 *         server failure.
 *       · Per-voice preview button (▶) when previewUrl exists.
 *   - Escape closes the popover. Click-outside closes too.
 *
 * Favorites persist per-user via the user-settings row, so they sync
 * across browsers/devices the user logs in from.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface VoiceRef {
  providerId: 'elevenlabs' | 'google';
  voiceId: string;
  languageCode: string;
}

interface VoiceCatalogEntry {
  voice: VoiceRef;
  displayName: string;
  description?: string;
  gender?: 'male' | 'female' | 'neutral';
  previewUrl?: string;
}

interface FavoriteRef {
  providerId: string;
  voiceId: string;
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
  const [favorites, setFavorites] = useState<FavoriteRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Fetch voices + favorites in parallel on mount.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch('/api/tts/voices').then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      ),
      fetch('/api/user/settings/tts-favorites').then((r) =>
        r.ok ? r.json() : { favorites: [] },
      ),
    ])
      .then(([voicesRes, favRes]: [{ voices: VoiceCatalogEntry[] }, { favorites: FavoriteRef[] }]) => {
        if (cancelled) return;
        setVoices(voicesRes.voices ?? []);
        setFavorites(favRes.favorites ?? []);
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

  // Click-outside + Escape close the popover.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Auto-focus search on open.
  useEffect(() => {
    if (open) {
      // Defer to next paint so the input is mounted.
      const id = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const isFavorite = useCallback(
    (v: VoiceCatalogEntry) =>
      favorites.some(
        (f) => f.providerId === v.voice.providerId && f.voiceId === v.voice.voiceId,
      ),
    [favorites],
  );

  const toggleFavorite = useCallback(
    async (v: VoiceCatalogEntry, e?: React.MouseEvent) => {
      e?.stopPropagation();
      // Optimistic UI.
      const before = favorites;
      const newList = isFavorite(v)
        ? favorites.filter(
            (f) => !(f.providerId === v.voice.providerId && f.voiceId === v.voice.voiceId),
          )
        : [...favorites, { providerId: v.voice.providerId, voiceId: v.voice.voiceId }];
      setFavorites(newList);
      try {
        const res = await fetch('/api/user/settings/tts-favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: v.voice.providerId,
            voiceId: v.voice.voiceId,
            action: 'toggle',
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { favorites: FavoriteRef[] };
        setFavorites(data.favorites);
      } catch {
        // Roll back on failure.
        setFavorites(before);
      }
    },
    [favorites, isFavorite],
  );

  const active = useMemo(
    () => voices.find((v) => v.voice.voiceId === value),
    [voices, value],
  );

  const playPreview = useCallback((v: VoiceCatalogEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!v.previewUrl) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(v.previewUrl);
    } else {
      audioRef.current.src = v.previewUrl;
    }
    audioRef.current.play().catch(() => {
      /* autoplay blocked — silent */
    });
  }, []);

  // Filter + group voices for the popover.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return voices;
    return voices.filter((v) => {
      const hay = [
        v.displayName,
        v.description ?? '',
        v.voice.languageCode,
        v.gender ?? '',
        v.voice.providerId,
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [voices, query]);

  const grouped = useMemo(() => {
    const favs = filtered.filter(isFavorite);
    const rest = filtered.filter((v) => !isFavorite(v));
    const byProvider = new Map<string, VoiceCatalogEntry[]>();
    for (const v of rest) {
      const key = v.voice.providerId;
      if (!byProvider.has(key)) byProvider.set(key, []);
      byProvider.get(key)!.push(v);
    }
    for (const list of byProvider.values()) {
      list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    favs.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { favorites: favs, byProvider };
  }, [filtered, isFavorite]);

  const pick = (v: VoiceCatalogEntry) => {
    onChange(v.voice.voiceId);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={loading}
          className="flex flex-1 items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:border-[var(--border-bright)] focus:border-[var(--accent-purple)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="truncate">
            {loading
              ? 'Loading voices…'
              : active
              ? voiceLabel(active)
              : required
              ? '— pick a voice —'
              : 'No voice'}
          </span>
          <span className="ml-2 text-xs text-[var(--text-muted)]" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
        </button>
        {active?.previewUrl && (
          <button
            type="button"
            onClick={(e) => playPreview(active, e)}
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
      {error && <p className="mt-1 text-xs text-[var(--accent-yellow)]">{error}</p>}

      {open && (
        <div className="absolute left-0 right-0 z-20 mt-2 max-h-[420px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl">
          <div className="border-b border-[var(--border)] p-2">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search voices (name, language, gender)…"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent-purple)] focus:outline-none"
            />
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {grouped.favorites.length > 0 && (
              <Group label="★ Favorites">
                {grouped.favorites.map((v) => (
                  <VoiceRow
                    key={`fav:${v.voice.providerId}:${v.voice.voiceId}`}
                    voice={v}
                    selected={v.voice.voiceId === value}
                    isFavorite
                    onPick={() => pick(v)}
                    onToggleFavorite={(e) => toggleFavorite(v, e)}
                    onPreview={(e) => playPreview(v, e)}
                  />
                ))}
              </Group>
            )}

            {Array.from(grouped.byProvider.entries()).map(([provider, list]) => (
              <Group key={provider} label={providerLabel(provider)}>
                {list.map((v) => (
                  <VoiceRow
                    key={`${provider}:${v.voice.voiceId}`}
                    voice={v}
                    selected={v.voice.voiceId === value}
                    isFavorite={isFavorite(v)}
                    onPick={() => pick(v)}
                    onToggleFavorite={(e) => toggleFavorite(v, e)}
                    onPreview={(e) => playPreview(v, e)}
                  />
                ))}
              </Group>
            ))}

            {filtered.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">
                No voices match &ldquo;{query}&rdquo;.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="bg-[var(--bg-secondary)]/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function VoiceRow({
  voice,
  selected,
  isFavorite,
  onPick,
  onToggleFavorite,
  onPreview,
}: {
  voice: VoiceCatalogEntry;
  selected: boolean;
  isFavorite: boolean;
  onPick: () => void;
  onToggleFavorite: (e: React.MouseEvent) => void;
  onPreview: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={[
        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
        selected
          ? 'bg-[var(--accent-purple)]/15 text-[var(--text-primary)]'
          : 'text-[var(--text-primary)] hover:bg-white/[0.05]',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onToggleFavorite}
        className={[
          'shrink-0 text-base leading-none',
          isFavorite ? 'text-[var(--accent-yellow)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
        ].join(' ')}
        title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        {isFavorite ? '★' : '☆'}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{voice.displayName}</span>
          <span className="shrink-0 text-xs text-[var(--text-muted)]">
            {voice.voice.languageCode}
            {voice.gender ? ` · ${voice.gender}` : ''}
          </span>
        </div>
        {voice.description && (
          <p className="truncate text-xs text-[var(--text-muted)]">{voice.description}</p>
        )}
      </div>
      {voice.previewUrl && (
        <button
          type="button"
          onClick={onPreview}
          className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:bg-white/[0.05] hover:text-[var(--text-primary)]"
          title="Play sample"
        >
          ▶
        </button>
      )}
    </button>
  );
}

function providerLabel(id: string): string {
  if (id === 'elevenlabs') return 'ElevenLabs';
  if (id === 'google') return 'Google Cloud TTS';
  return id;
}

function voiceLabel(v: VoiceCatalogEntry): string {
  const parts = [v.displayName];
  if (v.description) parts.push(v.description);
  if (v.voice.languageCode) parts.push(v.voice.languageCode);
  return parts.join(' · ');
}
