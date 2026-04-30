'use client';

import { useEffect, useRef, useState } from 'react';

interface ActivityEvent {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link_path: string | null;
  read_at: string | null;
  created_at: string;
}

interface Props {
  /** Personal token of the viewing collaborator. */
  token: string;
  /** Polling interval in ms. Default 45s — long enough to feel real-time
   *  without hammering the API while a tab is left open. */
  pollMs?: number;
}

const TYPE_ICONS: Record<string, { emoji: string; tint: string }> = {
  review_comment:   { emoji: '💬', tint: '#a78bfa' },
  comment_resolved: { emoji: '✅', tint: '#22c55e' },
  version_uploaded: { emoji: '🎬', tint: '#3b82f6' },
  status_changed:   { emoji: '🔄', tint: '#06b6d4' },
  narrator_take:    { emoji: '🎙️', tint: '#7c3aed' },
  narrator_comment: { emoji: '🗣️', tint: '#a78bfa' },
  retake_requested: { emoji: '🔁', tint: '#ef4444' },
  editor_assigned:  { emoji: '🎞️', tint: '#06b6d4' },
  narrator_assigned:{ emoji: '🎤', tint: '#7c3aed' },
  script_updated:   { emoji: '📝', tint: '#eab308' },
  deadline_reminder:{ emoji: '⏰', tint: '#f97316' },
  system:           { emoji: '🔔', tint: 'var(--text-muted)' },
};

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

export function NotificationBell({ token, pollMs = 45_000 }: Props) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const res = await fetch(`/api/activity/${token}?limit=30`);
      if (!res.ok) return;
      const data = await res.json();
      setEvents(data.events || []);
      setUnreadCount(data.unreadCount || 0);
    } catch {}
  }

  useEffect(() => {
    load();
    const t = setInterval(load, pollMs);
    // Refresh whenever the tab regains focus so users see new events
    // immediately after coming back from another tab.
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, pollMs]);

  // Click outside / Esc closes the popover
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  async function markAllRead() {
    setLoading(true);
    try {
      await fetch(`/api/activity/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      setEvents(prev => prev.map(e => ({ ...e, read_at: e.read_at || new Date().toISOString() })));
      setUnreadCount(0);
    } finally { setLoading(false); }
  }

  async function markOneRead(id: string) {
    try {
      await fetch(`/api/activity/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setEvents(prev => prev.map(e => e.id === id ? { ...e, read_at: e.read_at || new Date().toISOString() } : e));
      setUnreadCount(c => Math.max(0, c - 1));
    } catch {}
  }

  return (
    <div ref={popRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="relative w-9 h-9 rounded-full flex items-center justify-center transition-colors"
        style={{
          background: open ? 'rgba(124,58,237,0.15)' : 'var(--bg-secondary)',
          border: `1px solid ${open ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
        }}
        title={unreadCount > 0 ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}` : 'Notifications'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
            style={{ background: '#ef4444', color: 'white', boxShadow: '0 0 0 2px var(--bg-primary)' }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute top-full mt-2 right-0 w-[min(380px,90vw)] rounded-xl overflow-hidden flex flex-col z-[60]"
          style={{
            background: 'var(--bg-card, var(--bg-secondary))',
            border: '1px solid var(--border-bright, var(--border))',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            maxHeight: '70vh',
          }}
        >
          <div className="px-4 py-3 flex items-center justify-between shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Notifications</p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
              </p>
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                disabled={loading}
                className="text-[11px] px-2.5 py-1 rounded-lg transition-colors"
                style={{ color: '#a78bfa', background: 'rgba(124,58,237,0.1)' }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {events.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                <p>No notifications yet.</p>
                <p className="text-[11px] mt-1">When someone comments or assigns you work, it&apos;ll show up here.</p>
              </div>
            ) : (
              events.map(e => {
                const icon = TYPE_ICONS[e.type] || TYPE_ICONS.system;
                const unread = !e.read_at;
                const Wrapper = (e.link_path ? 'a' : 'div') as 'a' | 'div';
                const wrapperProps = e.link_path
                  ? { href: e.link_path, target: '_blank' as const, rel: 'noreferrer' }
                  : {};
                return (
                  <Wrapper
                    key={e.id}
                    {...wrapperProps}
                    onClick={() => { if (unread) markOneRead(e.id); }}
                    className="block px-3 py-2.5 transition-colors cursor-pointer"
                    style={{
                      background: unread ? 'rgba(124,58,237,0.05)' : 'transparent',
                      borderBottom: '1px solid var(--border)',
                    }}
                    onMouseEnter={el => { (el.currentTarget as HTMLElement).style.background = unread ? 'rgba(124,58,237,0.1)' : 'rgba(255,255,255,0.03)'; }}
                    onMouseLeave={el => { (el.currentTarget as HTMLElement).style.background = unread ? 'rgba(124,58,237,0.05)' : 'transparent'; }}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0" style={{ background: `${icon.tint}22` }}>
                        {icon.emoji}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2">
                          <p className="text-xs font-medium leading-snug flex-1 min-w-0" style={{ color: unread ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                            {e.title}
                          </p>
                          {unread && <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: '#a78bfa' }} />}
                        </div>
                        {e.body && (
                          <p className="text-[11px] mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                            {e.body}
                          </p>
                        )}
                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                          {timeAgo(e.created_at)}
                        </p>
                      </div>
                    </div>
                  </Wrapper>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
