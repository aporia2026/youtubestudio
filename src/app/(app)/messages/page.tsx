'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChatThread } from '@/components/messages/ChatThread';

interface ThreadSummary {
  collaborator_id: string;
  collaborator_name: string;
  collaborator_email: string | null;
  collaborator_color: string;
  collaborator_role: string | null;
  collaborator_personal_token: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  last_message_from_id: string | null;
  unread_count: number;
}

function formatRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Owner-side messages inbox. Sidebar of every collaborator (sorted by
 * most recent thread activity, with no-thread-yet collaborators at the
 * bottom) + the open thread on the right.
 *
 * Polls the thread list every 15s so unread counts and last-message
 * previews stay current without requiring a manual refresh.
 */
export default function MessagesPage() {
  const searchParams = useSearchParams();
  // `?with=<collaborator_id>` deep-link target — when present, the page
  // auto-selects that thread on load (and re-selects when the param
  // changes). Set by the "Message {Name}" shortcuts on per-project
  // surfaces (NarrationTab, EditorTab) so the owner lands in the right
  // conversation in one click.
  const requestedId = searchParams.get('with');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  const loadThreads = useCallback(async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch('/api/messages/threads', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: ThreadSummary[] = Array.isArray(data.threads) ? data.threads : [];
      setThreads(list);
      setActiveId(prev => {
        // Honour the deep-link target ahead of any other heuristic when
        // it matches a real collaborator on the list. Falls through to
        // the unread/most-recent/first-collaborator chain otherwise.
        if (requestedId && list.some(t => t.collaborator_id === requestedId)) {
          return requestedId;
        }
        if (prev) return prev;
        const firstUnread = list.find(t => t.unread_count > 0);
        if (firstUnread) return firstUnread.collaborator_id;
        const firstActive = list.find(t => t.last_message_at);
        if (firstActive) return firstActive.collaborator_id;
        return list[0]?.collaborator_id ?? null;
      });
    } catch (err) {
      console.error('Threads load failed:', err);
    } finally {
      setLoadingList(false);
    }
  }, [requestedId]);

  useEffect(() => {
    loadThreads();
    const id = setInterval(loadThreads, 15_000);
    return () => clearInterval(id);
  }, [loadThreads]);

  // When the user opens a thread, optimistically zero its unread count
  // so the sidebar doesn't keep showing the badge until the next poll.
  function handleSelect(id: string) {
    setActiveId(id);
    setThreads(prev => prev.map(t => t.collaborator_id === id ? { ...t, unread_count: 0 } : t));
  }

  const active = activeId ? threads.find(t => t.collaborator_id === activeId) : null;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <header className="px-6 py-4 shrink-0">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Messages</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
          Direct chat with each narrator, editor, and collaborator.
        </p>
      </header>

      <div className="flex-1 flex overflow-hidden mx-6 mb-6 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        {/* Thread list */}
        <aside className="w-72 shrink-0 overflow-y-auto" style={{ borderRight: '1px solid var(--border)' }}>
          {loadingList ? (
            <div className="p-4 text-xs text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>
          ) : threads.length === 0 ? (
            <div className="p-4 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              No collaborators yet — invite a narrator or editor to start a conversation.
            </div>
          ) : (
            threads.map(t => {
              const isActive = activeId === t.collaborator_id;
              const lastByMe = t.last_message_from_id && t.last_message_from_id !== t.collaborator_id;
              return (
                <button
                  key={t.collaborator_id}
                  onClick={() => handleSelect(t.collaborator_id)}
                  className="w-full px-3 py-3 text-left transition-colors flex items-start gap-3 cursor-pointer"
                  style={{
                    background: isActive ? 'rgba(124,58,237,0.10)' : 'transparent',
                    borderBottom: '1px solid var(--border)',
                    borderLeft: `3px solid ${isActive ? '#7c3aed' : 'transparent'}`,
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                    style={{ background: t.collaborator_color }}
                  >
                    {(t.collaborator_name[0] || '?').toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className="text-sm font-medium truncate"
                        style={{ color: 'var(--text-primary)', fontWeight: t.unread_count > 0 ? 700 : 500 }}
                      >
                        {t.collaborator_name}
                      </p>
                      {t.last_message_at && (
                        <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                          {formatRelative(t.last_message_at)}
                        </span>
                      )}
                    </div>
                    <p
                      className="text-[11px] truncate"
                      style={{ color: t.unread_count > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}
                    >
                      {t.last_message_text
                        ? `${lastByMe ? 'You: ' : ''}${t.last_message_text}`
                        : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>{t.collaborator_role || 'collaborator'} · no messages yet</span>}
                    </p>
                  </div>
                  {t.unread_count > 0 && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0"
                      style={{ background: '#ef4444', color: '#fff', minWidth: 18, textAlign: 'center' }}
                    >
                      {t.unread_count}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </aside>

        {/* Chat panel */}
        <main className="flex-1 min-w-0">
          {active ? (
            <ChatThread
              key={active.collaborator_id}
              loadUrl={`/api/messages/threads/${active.collaborator_id}`}
              postUrl={`/api/messages/threads/${active.collaborator_id}`}
              counterpart={{
                id: active.collaborator_id,
                name: active.collaborator_name,
                color: active.collaborator_color,
                role: active.collaborator_role,
              }}
              emptyHint={`No messages yet — say hi to ${active.collaborator_name}.`}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Select a conversation</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
