'use client';

/**
 * Save a niche to the workspace's watchlist. Idempotent — clicking
 * again on an already-watched niche is a no-op on the server but
 * we surface that state in the UI by flipping to "Watching ✓".
 *
 * Probes `/api/niche-finder/watchlist` on mount via GET-list (cheap;
 * one row per row in the watchlist, no joins) to know whether this
 * niche is already saved.
 */
import { useCallback, useEffect, useState } from 'react';
import type { NicheWatchlistRow } from '@/lib/niche-finder/watchlist';

interface SaveToWatchlistButtonProps {
  slug: string;
  name: string;
}

export function SaveToWatchlistButton({ slug, name }: SaveToWatchlistButtonProps): React.ReactElement {
  const [state, setState] = useState<'unknown' | 'unsaved' | 'saved' | 'busy'>('unknown');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch('/api/niche-finder/watchlist');
        if (cancelled) return;
        if (!res.ok) {
          setState('unsaved');
          return;
        }
        const body = (await res.json()) as { rows: NicheWatchlistRow[] };
        setState(body.rows.some((r) => r.niche_slug === slug) ? 'saved' : 'unsaved');
      } catch {
        setState('unsaved');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const onSave = useCallback(async () => {
    if (state === 'busy') return;
    setState('busy');
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/niche-finder/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nicheSlug: slug, nicheName: name }),
      });
      setState(res.ok ? 'saved' : 'unsaved');
    } catch {
      setState('unsaved');
    }
  }, [name, slug, state]);

  const onRemove = useCallback(async () => {
    if (state === 'busy') return;
    setState('busy');
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
      const res = await fetch(`/api/niche-finder/watchlist/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      });
      setState(res.ok ? 'unsaved' : 'saved');
    } catch {
      setState('saved');
    }
  }, [slug, state]);

  if (state === 'unknown') {
    return <SkeletonButton />;
  }
  if (state === 'saved') {
    return (
      <button onClick={onRemove} style={chipStyle('#22c55e')} title="Remove from watchlist">
        Watching ✓
      </button>
    );
  }
  return (
    <button onClick={onSave} disabled={state === 'busy'} style={chipStyle('#334155')}>
      {state === 'busy' ? 'Saving…' : '+ Watchlist'}
    </button>
  );
}

function SkeletonButton(): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 110,
        height: 32,
        borderRadius: 8,
        background: 'rgba(255,255,255,0.04)',
      }}
    />
  );
}

function chipStyle(color: string): React.CSSProperties {
  return {
    padding: '7px 14px',
    background: 'transparent',
    color: '#cbd5e1',
    border: `1px solid ${color}`,
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
  };
}
