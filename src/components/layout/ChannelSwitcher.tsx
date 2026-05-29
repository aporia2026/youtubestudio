'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export interface ChannelOption {
  id: string;
  name: string;
  account_color?: string | null;
}

/**
 * Top-bar channel switcher. Initial value is server-rendered into
 * `initialActiveChannelId`; the dropdown options come from `channels` (also
 * server-rendered). Switching POSTs to /api/user/settings/active-channel
 * and triggers a router refresh so server-rendered pages re-fetch with the
 * new context.
 *
 * Optimistic update: the dropdown reflects the new selection immediately;
 * if the POST fails we surface the error inline and revert.
 */
export function ChannelSwitcher({
  initialActiveChannelId,
  channels,
}: {
  initialActiveChannelId: string | null;
  channels: ChannelOption[];
}) {
  const [active, setActive] = useState<string | null>(initialActiveChannelId);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const ALL_VALUE = '__all';

  async function onChange(value: string) {
    const next = value === ALL_VALUE ? null : value;
    if (next === active) return;
    const prev = active;
    setActive(next);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/user/settings/active-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to switch channel');
      }
      startTransition(() => {
        router.refresh();
      });
    } catch (e) {
      setActive(prev); // revert
      setError(e instanceof Error ? e.message : 'Failed to switch channel');
    }
  }

  if (channels.length === 0) {
    // No channels in this workspace yet — render a placeholder that links
    // to the channel-add flow. Don't show an empty <select>.
    return (
      <a
        href="/channel"
        title="No channels yet — add one"
        style={{
          fontSize: 13,
          color: 'var(--text-muted)',
          textDecoration: 'none',
          padding: '4px 10px',
          borderRadius: 6,
          border: '1px dashed rgba(255,255,255,0.15)',
        }}
      >
        + Add a channel
      </a>
    );
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <select
        value={active ?? ALL_VALUE}
        onChange={e => void onChange(e.target.value)}
        disabled={isPending}
        aria-label="Active channel"
        style={{
          fontSize: 13,
          padding: '5px 26px 5px 10px',
          borderRadius: 6,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.10)',
          color: 'var(--text-primary)',
          appearance: 'none',
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2394a3b8' stroke-width='1.5'/></svg>\")",
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 8px center',
          minWidth: 140,
          cursor: isPending ? 'wait' : 'pointer',
        }}
      >
        <option value={ALL_VALUE}>All channels</option>
        {channels.map(c => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {error && (
        <span style={{ fontSize: 12, color: '#ef4444' }} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
