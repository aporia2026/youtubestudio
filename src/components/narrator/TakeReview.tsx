'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { WaveformPlayer, type WaveformPlayerHandle, type TakeCommentMarker } from './WaveformPlayer';
import { ScriptFollow } from './ScriptFollow';

export interface TakeComment {
  id: string;
  take_id: string;
  timestamp_ms: number;
  end_timestamp_ms: number | null;
  text: string;
  author_name: string;
  author_color: string;
  author_role: 'owner' | 'narrator';
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  parent_id: string | null;
  fix_for_comment_id: string | null;
  created_at: string;
}

interface TakeReviewProps {
  takeId: string;
  audioUrl: string;
  /** Narrator's section script — drives the script-follow panel. */
  scriptText: string;
  /** Optional duration hint (from narrator_takes.duration_seconds). */
  initialDurationMs?: number | null;
  /** API endpoint conventions:
   *    listUrl: GET → comments[]; POST { timestamp_ms, end_timestamp_ms?, text, parent_id?, author_name?, author_color? }
   *    itemUrl(id): PATCH { resolved, author_name? } / DELETE
   * Owner side passes /api/narrator/takes/[takeId]/comments + /api/narrator/take-comments/[id].
   * Token side passes /api/narrate/[token]/takes/[takeId]/comments + /api/narrate/[token]/take-comments/[id]. */
  listUrl: string;
  itemUrl: (commentId: string) => string;
  /** Author identity. Owner = the project owner; narrator = whatever the
   *  assignment says. The server enforces author_role from the route, so
   *  this is purely for the optimistic UI. */
  author: { name: string; color: string; role: 'owner' | 'narrator' };
  /** Hide the author/role row when the wrapping UI already shows it. */
  compactHeader?: boolean;
  /** Token-side narrators can only delete their own comments; owner can delete any. */
  canDeleteAny: boolean;
}

type Filter = 'all' | 'unresolved' | 'resolved';

function formatTime(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Frame.io-style review surface for a single audio take.
 *
 *   ┌─ Waveform + transport (with comment markers) ───────────┐
 *   ├─ Script follow (plain | teleprompter) ──────────────────┤
 *   └─ Comments panel: filter / list / threaded replies / input
 *
 * Mirrors the video CommentPanel/CommentInput patterns but stays
 * self-contained so it can be embedded inside an expanding take card.
 */
export function TakeReview({
  takeId, audioUrl, scriptText, initialDurationMs, listUrl, itemUrl, author, compactHeader, canDeleteAny,
}: TakeReviewProps) {
  const playerRef = useRef<WaveformPlayerHandle>(null);
  const [comments, setComments] = useState<TakeComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(true);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(initialDurationMs || 0);
  const [filter, setFilter] = useState<Filter>('all');
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rangeStartMs, setRangeStartMs] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initial fetch — and refetch on takeId change.
  useEffect(() => {
    let cancelled = false;
    setLoadingComments(true);
    setComments([]);
    fetch(listUrl)
      .then(r => r.ok ? r.json() : [])
      .then((data: TakeComment[]) => { if (!cancelled) setComments(Array.isArray(data) ? data : []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingComments(false); });
    return () => { cancelled = true; };
  }, [listUrl]);

  // Compute marker lanes so overlapping ranges don't all stack on the same row.
  const markers: TakeCommentMarker[] = useMemo(() => {
    const topLevel = comments.filter(c => !c.parent_id);
    let laneIdx = 0;
    return topLevel.map(c => {
      const lane = c.end_timestamp_ms != null && c.end_timestamp_ms > c.timestamp_ms ? (laneIdx++ % 3) : 0;
      return {
        id: c.id,
        timestamp_ms: c.timestamp_ms,
        end_timestamp_ms: c.end_timestamp_ms,
        author_color: c.author_color,
        resolved: c.resolved,
        lane,
      };
    });
  }, [comments]);

  function seek(ms: number) {
    playerRef.current?.seek(ms);
  }

  function handleMarkerClick(commentId: string, ms: number) {
    seek(ms);
    setHighlightedId(commentId);
    setTimeout(() => setHighlightedId(null), 2000);
  }

  // Scroll the highlighted comment into view inside the list.
  useEffect(() => {
    if (!highlightedId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-comment-id="${highlightedId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightedId]);

  const filtered = comments.filter(c => {
    if (c.parent_id) return false;
    if (filter === 'unresolved') return !c.resolved;
    if (filter === 'resolved') return c.resolved;
    return true;
  });

  const replies = (parentId: string) => comments.filter(c => c.parent_id === parentId);

  const unresolvedCount = comments.filter(c => !c.parent_id && !c.resolved).length;

  // --- Comment input -------------------------------------------------------

  async function submit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try {
      const isRange = rangeStartMs !== null && rangeStartMs < currentMs;
      const timestamp_ms = replyTo
        ? (comments.find(c => c.id === replyTo)?.timestamp_ms ?? currentMs)
        : (isRange ? rangeStartMs! : currentMs);
      const end_timestamp_ms = !replyTo && isRange ? currentMs : null;

      const res = await fetch(listUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp_ms: Math.round(timestamp_ms),
          end_timestamp_ms: end_timestamp_ms != null ? Math.round(end_timestamp_ms) : null,
          text: text.trim(),
          author_name: author.name,
          author_color: author.color,
          parent_id: replyTo,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const created: TakeComment = await res.json();
      setComments(prev => [...prev, created]);
      setText('');
      setRangeStartMs(null);
      setReplyTo(null);
      textareaRef.current?.focus();
    } catch (err) {
      console.error('Failed to post take comment:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleResolved(commentId: string, resolved: boolean) {
    // Optimistic update
    setComments(prev => prev.map(c => c.id === commentId ? {
      ...c,
      resolved,
      resolved_by: resolved ? author.name : null,
      resolved_at: resolved ? new Date().toISOString() : null,
    } : c));
    try {
      await fetch(itemUrl(commentId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved, author_name: author.name }),
      });
    } catch {}
  }

  async function deleteComment(commentId: string) {
    if (!confirm('Delete this comment?')) return;
    let url = itemUrl(commentId);
    // Token-side delete needs author_name in the query string for verification.
    if (!canDeleteAny) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}author_name=${encodeURIComponent(author.name)}`;
    }
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (res.ok) setComments(prev => prev.filter(c => c.id !== commentId && c.parent_id !== commentId));
    } catch {}
  }

  const isRangeActive = rangeStartMs !== null;
  const rangeValid = isRangeActive && rangeStartMs! < currentMs;
  const replyParent = replyTo ? comments.find(c => c.id === replyTo) : null;

  return (
    <div className="space-y-3">
      {!compactHeader && (
        <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <div
            className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
            style={{ background: author.color }}
          >
            {author.name[0]?.toUpperCase()}
          </div>
          <span>Reviewing as {author.name} · {author.role === 'owner' ? 'Owner' : 'Narrator'}</span>
          {unresolvedCount > 0 && (
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
              {unresolvedCount} unresolved
            </span>
          )}
        </div>
      )}

      <WaveformPlayer
        ref={playerRef}
        src={audioUrl}
        initialDurationMs={initialDurationMs}
        comments={markers}
        onTimeUpdate={setCurrentMs}
        onDurationChange={setDurationMs}
        onMarkerClick={handleMarkerClick}
      />

      <ScriptFollow
        scriptText={scriptText}
        currentMs={currentMs}
        durationMs={durationMs}
        onSeek={seek}
      />

      {/* Comments header */}
      <div className="flex items-center justify-between pt-1">
        <h3 className="text-xs font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          Comments
          {unresolvedCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
              {unresolvedCount}
            </span>
          )}
        </h3>
        <div className="flex gap-1">
          {(['all', 'unresolved', 'resolved'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-2 py-0.5 rounded text-[10px] capitalize transition-colors cursor-pointer"
              style={{
                background: filter === f ? 'rgba(255,255,255,0.08)' : 'transparent',
                color: filter === f ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Comment list */}
      <div ref={listRef} className="space-y-2 max-h-72 overflow-y-auto">
        {loadingComments ? (
          <div className="text-center py-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {filter === 'all' ? 'No comments yet — play the take and click the timeline to leave one' : `No ${filter} comments`}
          </div>
        ) : (
          filtered.map(c => {
            const myReplies = replies(c.id);
            const canDelete = canDeleteAny || c.author_name === author.name;
            return (
              <div key={c.id} data-comment-id={c.id}>
                <CommentRow
                  c={c}
                  highlighted={highlightedId === c.id}
                  onSeek={() => handleMarkerClick(c.id, c.timestamp_ms)}
                  onResolve={() => toggleResolved(c.id, !c.resolved)}
                  onReply={() => { setReplyTo(c.id); textareaRef.current?.focus(); }}
                  onDelete={canDelete ? () => deleteComment(c.id) : undefined}
                />
                {myReplies.map(r => (
                  <div key={r.id} className="ml-4 mt-1" data-comment-id={r.id}>
                    <CommentRow
                      c={r}
                      isReply
                      highlighted={highlightedId === r.id}
                      onSeek={() => {}}
                      onResolve={() => {}}
                      onReply={() => {}}
                      onDelete={canDeleteAny || r.author_name === author.name ? () => deleteComment(r.id) : undefined}
                    />
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* Comment input */}
      <div className="rounded-lg p-2.5" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
        {replyTo && replyParent && (
          <div className="mb-2 flex items-center gap-2 px-2 py-1 rounded text-[10px]" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Replying to {replyParent.author_name}:</span>
            <span className="truncate flex-1" style={{ color: 'var(--text-secondary)' }}>{replyParent.text}</span>
            <button
              onClick={() => setReplyTo(null)}
              className="text-[10px] cursor-pointer"
              style={{ color: 'var(--text-muted)' }}
              title="Cancel reply"
            >
              Cancel
            </button>
          </div>
        )}

        {!replyTo && isRangeActive && (
          <div className="mb-2 flex items-center gap-2 px-2 py-1 rounded text-[10px]" style={{ background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.3)' }}>
            <span className="font-mono" style={{ color: '#a78bfa' }}>
              {formatTime(rangeStartMs!)} → {formatTime(currentMs)}
            </span>
            {!rangeValid && (
              <span className="italic" style={{ color: '#eab308' }}>Seek forward, then submit</span>
            )}
            <button
              onClick={() => setRangeStartMs(null)}
              className="ml-auto cursor-pointer"
              style={{ color: 'var(--text-muted)' }}
              title="Cancel range"
            >
              Cancel range
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <div className="text-[10px] font-mono mb-1 px-1 flex items-center gap-2" style={{ color: '#a78bfa' }}>
              <span>
                {replyTo
                  ? 'Reply'
                  : isRangeActive
                    ? (rangeValid ? `range ${formatTime(rangeStartMs!)}–${formatTime(currentMs)}` : `range starts at ${formatTime(rangeStartMs!)}`)
                    : `at ${formatTime(currentMs)}`}
              </span>
              {!replyTo && !isRangeActive && (
                <button
                  onClick={() => setRangeStartMs(currentMs)}
                  className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer"
                  style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                  title="Mark this as the START of a range, then seek forward and submit"
                >
                  ↔ Mark start
                </button>
              )}
            </div>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
              placeholder={replyTo ? 'Reply…' : isRangeActive ? (rangeValid ? 'Comment on this range…' : 'Seek forward, then comment…') : 'Add a comment...'}
              rows={2}
              className="w-full px-3 py-2 rounded-lg text-xs resize-none"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>
          <button
            onClick={submit}
            disabled={!text.trim() || submitting || (!replyTo && isRangeActive && !rangeValid)}
            className="p-2 rounded-lg text-white disabled:opacity-30 transition-colors shrink-0 cursor-pointer disabled:cursor-not-allowed"
            style={{ background: '#7c3aed' }}
            title="Post"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function CommentRow({
  c, highlighted, isReply, onSeek, onResolve, onReply, onDelete,
}: {
  c: TakeComment;
  highlighted: boolean;
  isReply?: boolean;
  onSeek: () => void;
  onResolve: () => void;
  onReply: () => void;
  onDelete?: () => void;
}) {
  const isRange = c.end_timestamp_ms != null && c.end_timestamp_ms > c.timestamp_ms;
  return (
    <div
      className="group p-2 rounded-lg transition-all"
      style={{
        background: highlighted ? 'rgba(124,58,237,0.1)' : 'var(--bg-primary)',
        border: highlighted ? '1px solid rgba(124,58,237,0.3)' : '1px solid transparent',
        opacity: c.resolved ? 0.55 : 1,
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0" style={{ background: c.author_color }}>
          {(c.author_name || '?')[0].toUpperCase()}
        </div>
        <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{c.author_name}</span>
        <span
          className="text-[9px] px-1 py-0.5 rounded uppercase tracking-wider"
          style={{ background: c.author_role === 'owner' ? 'rgba(6,182,212,0.15)' : 'rgba(124,58,237,0.15)', color: c.author_role === 'owner' ? '#06b6d4' : '#a78bfa' }}
        >
          {c.author_role}
        </span>
        <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-muted)' }}>{timeAgo(c.created_at)}</span>
        {onDelete && !isReply && (
          <button
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded cursor-pointer transition-opacity"
            title="Delete comment"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#ef4444' }}>
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        )}
      </div>

      {!isReply && (
        <button
          onClick={onSeek}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded mb-1 cursor-pointer flex items-center gap-1"
          style={{ background: 'rgba(124,58,237,0.1)', color: '#a78bfa' }}
        >
          {isRange ? `${formatTime(c.timestamp_ms)} – ${formatTime(c.end_timestamp_ms!)}` : formatTime(c.timestamp_ms)}
        </button>
      )}

      <p className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{c.text}</p>

      {!isReply && (
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={onReply}
            className="text-[10px] cursor-pointer transition-colors"
            style={{ color: 'var(--text-muted)' }}
          >
            Reply
          </button>
          <button
            onClick={onResolve}
            className="text-[10px] flex items-center gap-1 transition-colors cursor-pointer ml-auto"
            style={{ color: c.resolved ? '#22c55e' : 'var(--text-muted)' }}
          >
            {c.resolved ? '✓ Resolved' : '○ Resolve'}
          </button>
        </div>
      )}
    </div>
  );
}
