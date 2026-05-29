'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export interface ChatMessage {
  id: string;
  from_collaborator_id: string;
  to_collaborator_id: string;
  text: string;
  read_at: string | null;
  created_at: string;
}

export interface ChatParticipant {
  id: string;
  name: string;
  color: string;
  role?: string | null;
}

interface ChatThreadProps {
  /**
   * GET endpoint — returns `{ me, counterpart, messages }`. Hit on mount,
   * on focus, and on the 15s poll. Marking-read happens server-side as
   * a side effect of GET.
   */
  loadUrl: string;
  /** POST endpoint — accepts `{ text }` and returns the created message. */
  postUrl: string;
  /** Pre-resolved counterpart so the header renders before the first
   *  fetch returns. Optional — falls back to whatever GET supplies. */
  counterpart?: ChatParticipant | null;
  /** Optional empty-state copy ("Start a conversation with…"). */
  emptyHint?: string;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Minimal yet sturdy chat surface — header, scrollable message list,
 * input row, optimistic send, 15s background poll. Used identically by
 * the owner-side `/messages` page and the collaborator-side `/inbox`
 * page (both supply different load/post URLs).
 */
export function ChatThread({ loadUrl, postUrl, counterpart: initialCounterpart, emptyHint }: ChatThreadProps) {
  const [me, setMe] = useState<ChatParticipant | null>(null);
  const [counterpart, setCounterpart] = useState<ChatParticipant | null>(initialCounterpart || null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Track last-loaded message id so we can decide whether to auto-scroll.
  // Without this, every poll re-snaps the user to the bottom even if
  // they were scrolled up reading older messages.
  const lastIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch(loadUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMe(data.me || null);
      if (data.counterpart) setCounterpart(data.counterpart);
      setMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch (err) {
      console.error('ChatThread load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [loadUrl]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh on focus (window/tab regaining focus is the most reliable
  // signal that the user came back and might have new messages).
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Light 15s poll for the case where the user keeps the tab open.
  useEffect(() => {
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  // Auto-scroll to bottom when a NEW message arrives (id changed since
  // last render). If the user has manually scrolled up, leave them be.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const newest = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (newest === lastIdRef.current) return;
    lastIdRef.current = newest;
    // Threshold: if they're within 80px of the bottom they're "following along".
    const distanceFromBottom = list.scrollHeight - list.clientHeight - list.scrollTop;
    if (distanceFromBottom < 80) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  const submit = useCallback(async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const created: ChatMessage = await res.json();
      setMessages(prev => [...prev, created]);
      setText('');
      // Snap to bottom regardless of prior scroll position — the user
      // just sent a message, they expect to see it land.
      requestAnimationFrame(() => {
        const list = listRef.current;
        if (list) list.scrollTop = list.scrollHeight;
      });
      textareaRef.current?.focus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }, [text, sending, postUrl]);

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        {counterpart ? (
          <>
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
              style={{ background: counterpart.color }}
            >
              {counterpart.name[0]?.toUpperCase() || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{counterpart.name}</p>
              {counterpart.role && (
                <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{counterpart.role}</p>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>
        )}
      </div>

      {/* Message list */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2" style={{ background: 'var(--bg-secondary)' }}>
        {loading ? (
          <div className="text-center py-10 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div className="text-center py-10 text-xs" style={{ color: 'var(--text-muted)' }}>
            {emptyHint || (counterpart ? `Start a conversation with ${counterpart.name}` : 'No messages yet')}
          </div>
        ) : (
          messages.map((m, i) => {
            const mine = me?.id && m.from_collaborator_id === me.id;
            const prev = i > 0 ? messages[i - 1] : null;
            const showAuthor = !prev || prev.from_collaborator_id !== m.from_collaborator_id;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className="max-w-[80%] px-3 py-2 rounded-lg"
                  style={{
                    background: mine ? 'rgba(124,58,237,0.18)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${mine ? 'rgba(124,58,237,0.3)' : 'transparent'}`,
                    color: 'var(--text-primary)',
                  }}
                  title={new Date(m.created_at).toLocaleString()}
                >
                  {showAuthor && !mine && counterpart && (
                    <p className="text-[10px] mb-0.5" style={{ color: counterpart.color, fontWeight: 600 }}>
                      {counterpart.name}
                    </p>
                  )}
                  <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.text}</p>
                  <p className="text-[10px] mt-1 text-right" style={{ color: 'var(--text-muted)' }}>
                    {formatTime(m.created_at)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input */}
      <div className="px-4 py-3 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Type a message — Enter to send, Shift+Enter for newline"
            rows={2}
            className="flex-1 px-3 py-2 rounded-lg text-sm resize-none"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            maxLength={10_000}
          />
          <button
            onClick={submit}
            disabled={!text.trim() || sending}
            className="p-2.5 rounded-lg text-white disabled:opacity-30 transition-colors shrink-0 cursor-pointer disabled:cursor-not-allowed"
            style={{ background: '#7c3aed' }}
            title="Send (Enter)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
