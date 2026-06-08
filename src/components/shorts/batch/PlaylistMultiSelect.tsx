'use client';

/**
 * PlaylistMultiSelect — fetches the channel's playlists and lets the
 * user pick zero or more for attachment after upload. Lazy-load on
 * mount so the parent renders fast even when the channel has many
 * playlists.
 */

import { useEffect, useState } from 'react';

interface YoutubePlaylist {
  id: string;
  title: string;
  itemCount: number | null;
}

export function PlaylistMultiSelect({
  channelId,
  value,
  onChange,
}: {
  channelId: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [playlists, setPlaylists] = useState<YoutubePlaylist[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/youtube/channel/${channelId}/playlists`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ playlists: YoutubePlaylist[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setPlaylists(data.playlists);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load playlists');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter((p) => p !== id));
    else onChange([...value, id]);
  };

  if (loading) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading playlists…</p>;
  }
  if (error) {
    return <p className="text-xs text-amber-600 dark:text-amber-400">{error}</p>;
  }
  if (!playlists || playlists.length === 0) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        No playlists on this channel yet.
      </p>
    );
  }

  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900">
      {playlists.map((pl) => {
        const checked = value.includes(pl.id);
        return (
          <label
            key={pl.id}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(pl.id)}
              className="h-4 w-4 accent-zinc-900 dark:accent-white"
            />
            <span className="flex-1 truncate text-zinc-900 dark:text-zinc-100">{pl.title}</span>
            {pl.itemCount !== null && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {pl.itemCount} videos
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}
