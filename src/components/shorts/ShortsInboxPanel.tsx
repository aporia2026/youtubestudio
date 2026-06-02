'use client';

/**
 * ShortsInboxPanel — the global Shorts inbox.
 *
 * Renders at /shorts?tab=inbox. Aggregates every pending Short candidate
 * across every project in the workspace, ordered by hook_score (NULLS
 * LAST) then created_at. Each candidate row offers two actions:
 *
 *   - Open in YouTube Studio (for kind='channel_clip_recommendation')
 *   - Dismiss (sets dismissed_at via POST /api/shorts/[id]/dismiss)
 *
 * Empty state explains how to populate the inbox (save a long-form
 * script → auto-fan-out creates candidates) so a first-time user knows
 * why the surface is empty.
 *
 * Optimistic UI: dismiss removes the row from local state immediately.
 * On error we re-fetch + show the toast. Audit-aware delete pattern
 * (rule 8.4.g — check res.ok before mutating local state was applied
 * elsewhere; here we use the optimistic pattern because the user can
 * always undo by un-dismissing via DB, and the inbox is high-volume.)
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ShortRow } from '@/lib/shorts-types';

function formatMsAsTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function studioDeepLink(youtubeVideoId: string, startMs: number): string {
  const t = Math.max(0, Math.floor(startMs / 1000));
  return `https://studio.youtube.com/video/${encodeURIComponent(youtubeVideoId)}/edit?t=${t}`;
}

interface Props {
  /** Filter to one medium. 'all' shows both short_clip + short_native. */
  mediumFilter?: 'all' | 'short_clip' | 'short_native';
}

export function ShortsInboxPanel({ mediumFilter = 'all' }: Props) {
  const [rows, setRows] = useState<ShortRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeMedium, setActiveMedium] = useState<'all' | 'short_clip' | 'short_native'>(
    mediumFilter,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/shorts', window.location.origin);
      url.searchParams.set('inboxOnly', 'true');
      url.searchParams.set('limit', '100');
      if (activeMedium !== 'all') url.searchParams.set('medium', activeMedium);
      // eslint-disable-next-line no-restricted-syntax -- GET, loads inbox
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows((data.shorts || []) as ShortRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load inbox');
    } finally {
      setLoading(false);
    }
  }, [activeMedium]);

  useEffect(() => {
    load();
  }, [load]);

  const dismiss = useCallback(
    async (id: string) => {
      // Optimistic remove
      const prior = rows;
      setRows((r) => r.filter((row) => row.id !== id));
      try {
        const res = await fetch(`/api/shorts/${encodeURIComponent(id)}/dismiss`, {
          method: 'POST',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        // Roll back on failure
        setRows(prior);
        toast.error(e instanceof Error ? e.message : 'Dismiss failed');
      }
    },
    [rows],
  );

  return (
    <div style={{ padding: '8px 0' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Shorts inbox</h2>
        <div
          role="tablist"
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 3,
            borderRadius: 10,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          {(['all', 'short_clip', 'short_native'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={activeMedium === m}
              type="button"
              onClick={() => setActiveMedium(m)}
              style={{
                padding: '4px 10px',
                borderRadius: 7,
                border: 'none',
                cursor: activeMedium === m ? 'default' : 'pointer',
                fontSize: 12,
                fontWeight: activeMedium === m ? 600 : 500,
                background: activeMedium === m ? 'rgba(124,58,237,0.9)' : 'transparent',
                color: activeMedium === m ? '#fff' : 'var(--text-secondary, rgba(255,255,255,0.7))',
              }}
            >
              {m === 'all' ? 'All' : m === 'short_clip' ? 'Clips' : 'New Shorts'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={load}
          style={{
            marginLeft: 'auto',
            padding: '4px 10px',
            borderRadius: 7,
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      {error && (
        <div
          style={{
            padding: 10,
            borderRadius: 8,
            border: '1px solid rgba(239,68,68,0.3)',
            background: 'rgba(239,68,68,0.08)',
            fontSize: 12,
            color: '#fca5a5',
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div
          style={{
            padding: 24,
            borderRadius: 12,
            background: 'rgba(255,255,255,0.03)',
            border: '1px dashed rgba(255,255,255,0.12)',
            color: 'var(--text-secondary, rgba(255,255,255,0.6))',
            fontSize: 14,
            lineHeight: 1.55,
            maxWidth: 720,
          }}
        >
          The inbox is empty.{' '}
          <strong>Save a long-form script</strong> in any project — auto-fan-out queues
          3 Short candidates per script — or hit Shorts mode in <em>Scripts</em> to find
          clips inside an existing channel video.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((row) => (
          <article
            key={row.id}
            style={{
              padding: 14,
              borderRadius: 12,
              background: 'rgba(0,0,0,0.18)',
              border: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <header
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 12,
                color: 'var(--text-secondary, rgba(255,255,255,0.7))',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  background:
                    row.medium === 'short_clip'
                      ? 'rgba(6,182,212,0.18)'
                      : 'rgba(124,58,237,0.18)',
                  color: row.medium === 'short_clip' ? '#67e8f9' : '#c4b5fd',
                  fontWeight: 600,
                }}
              >
                {row.medium === 'short_clip' ? 'Clip' : 'New Short'}
              </span>
              {typeof row.hook_score === 'number' && (
                <span style={{ opacity: 0.85 }}>
                  hook {(row.hook_score * 100).toFixed(0)}
                </span>
              )}
              {row.estimated_duration_seconds && (
                <span>~{row.estimated_duration_seconds}s</span>
              )}
              {row.clip_start_ms !== null && row.clip_end_ms !== null && (
                <span>
                  {formatMsAsTimestamp(row.clip_start_ms!)}–
                  {formatMsAsTimestamp(row.clip_end_ms!)}
                </span>
              )}
              <span style={{ marginLeft: 'auto', opacity: 0.55 }}>
                {new Date(row.created_at).toLocaleString()}
              </span>
            </header>

            <div style={{ fontSize: 14, lineHeight: 1.5 }}>
              {row.hook && <strong style={{ color: '#fbbf24' }}>{row.hook}</strong>}
              {row.short_script && (
                <span style={{ color: 'var(--text-secondary, rgba(255,255,255,0.75))' }}>
                  {row.hook ? ' ' : ''}
                  {row.short_script.length > 280
                    ? row.short_script.slice(0, 280) + '…'
                    : row.short_script}
                </span>
              )}
            </div>

            <footer style={{ display: 'flex', gap: 8 }}>
              {row.medium === 'short_clip' && row.source_youtube_video_id && (
                <a
                  href={studioDeepLink(row.source_youtube_video_id, row.clip_start_ms ?? 0)}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    padding: '5px 11px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.15)',
                    background: 'transparent',
                    color: 'inherit',
                    textDecoration: 'none',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  Open in YouTube Studio →
                </a>
              )}
              <button
                type="button"
                onClick={() => dismiss(row.id)}
                style={{
                  marginLeft: 'auto',
                  padding: '5px 11px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'rgba(255,255,255,0.05)',
                  color: 'var(--text-secondary, rgba(255,255,255,0.65))',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                Dismiss
              </button>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}
