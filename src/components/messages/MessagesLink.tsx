'use client';

import { useEffect, useState } from 'react';

interface Props {
  /** Collaborator's personal_token. Drives both the unread-count probe
   *  and the link target. */
  token: string;
  /** Poll cadence in ms. Defaults to 30s — chat unread doesn't need
   *  to be as eager as comment-resolution feedback, and we don't want
   *  to spam the API with hundreds of clients refreshing in unison. */
  pollMs?: number;
}

/**
 * Compact "chat icon with unread badge" link for the dashboard nav bar
 * (narrator + editor portals). Routes to the standalone `/inbox/[token]`
 * page when clicked.
 */
export function MessagesLink({ token, pollMs = 30_000 }: Props) {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch(`/api/messages/inbox/${token}/unread`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setUnread((data.unread as number) || 0);
      } catch {}
    }
    load();
    const id = setInterval(load, pollMs);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [token, pollMs]);

  return (
    <a
      href={`/inbox/${token}`}
      className="relative w-9 h-9 rounded-full flex items-center justify-center transition-colors"
      style={{ background: unread > 0 ? 'rgba(124,58,237,0.15)' : 'var(--bg-secondary)', border: `1px solid ${unread > 0 ? 'rgba(124,58,237,0.4)' : 'var(--border)'}` }}
      title={unread > 0 ? `${unread} unread message${unread === 1 ? '' : 's'}` : 'Messages'}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: unread > 0 ? '#a78bfa' : 'var(--text-secondary)' }}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {unread > 0 && (
        <span
          className="absolute -top-1 -right-1 text-[10px] px-1 rounded-full font-bold"
          style={{ background: '#ef4444', color: '#fff', minWidth: 16, textAlign: 'center', lineHeight: '14px' }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </a>
  );
}
