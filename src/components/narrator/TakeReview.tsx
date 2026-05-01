'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
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
  /** Optional re-record callback. When provided, renders a prominent
   *  "Upload new take with fixes" CTA inside the panel so the narrator
   *  can read feedback → mark resolved → upload — without leaving the
   *  review surface. The wrapping component (NarratorPortal) supplies
   *  the right handler for either per-section or full-audio context. */
  onUploadNewTake?: (file: File) => Promise<void>;
  /** True while a parent-driven upload is in flight; gates the button. */
  uploadingNewTake?: boolean;
  /** Optional copy override for the upload button — defaults to
   *  "Upload new take with fixes" but full-audio context wants
   *  "Replace full narration with fixes". */
  uploadButtonLabel?: string;
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
  onUploadNewTake, uploadingNewTake, uploadButtonLabel,
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
  // Track the marker-highlight clear-timer in a ref so rapid clicks don't
  // queue overlapping timers, and so unmount mid-window doesn't trigger a
  // setState-on-unmounted-component warning.
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

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
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedId(null);
      highlightTimerRef.current = null;
    }, 2000);
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
    // Read the live playhead from the wavesurfer ref rather than the React
    // state — between a click on the waveform and the audioprocess/seeking
    // event handler firing setState, currentMs is one frame stale. The
    // server-side timestamp must reflect where the user actually is now,
    // not where they were on the previous render.
    const liveMs = playerRef.current?.getCurrentMs() ?? currentMs;
    try {
      const isRange = rangeStartMs !== null && rangeStartMs < liveMs;
      const timestamp_ms = replyTo
        ? (comments.find(c => c.id === replyTo)?.timestamp_ms ?? liveMs)
        : (isRange ? rangeStartMs! : liveMs);
      const end_timestamp_ms = !replyTo && isRange ? liveMs : null;

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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const created: TakeComment = await res.json();
      setComments(prev => [...prev, created]);
      setText('');
      setRangeStartMs(null);
      setReplyTo(null);
      textareaRef.current?.focus();
    } catch (err) {
      console.error('Failed to post take comment:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to post comment');
      // Leave the user's text in place so they don't lose their thought.
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleResolved(commentId: string, resolved: boolean) {
    // Snapshot prior state for rollback. Without this, a network/server
    // failure would leave the UI showing "Resolved" while the DB stays
    // unresolved — silent divergence between two clients.
    const prior = comments.find(c => c.id === commentId);
    if (!prior) return;
    setComments(prev => prev.map(c => c.id === commentId ? {
      ...c,
      resolved,
      resolved_by: resolved ? author.name : null,
      resolved_at: resolved ? new Date().toISOString() : null,
    } : c));
    try {
      const res = await fetch(itemUrl(commentId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved, author_name: author.name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Roll back the optimistic update.
      setComments(prev => prev.map(c => c.id === commentId ? prior : c));
      toast.error(err instanceof Error ? err.message : 'Failed to update — please try again');
    }
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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      // The server cascades replies via FK; mirror that locally.
      setComments(prev => prev.filter(c => c.id !== commentId && c.parent_id !== commentId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete comment');
    }
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

      {/* Re-record CTA — only rendered when a parent supplies the upload
          handler (narrator-side does, owner-side doesn't). Sits at the top
          of the comment block so the narrator sees the call-to-action
          immediately after reading feedback. Disabled while another
          upload is in flight. */}
      {onUploadNewTake && (
        <label
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
          style={{
            background: uploadingNewTake ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.12)',
            border: '1px solid rgba(34,197,94,0.4)',
            opacity: uploadingNewTake ? 0.7 : 1,
            cursor: uploadingNewTake ? 'wait' : 'pointer',
          }}
        >
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            disabled={uploadingNewTake}
            onChange={async e => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f && onUploadNewTake) {
                try { await onUploadNewTake(f); } catch {}
              }
            }}
          />
          {uploadingNewTake ? (
            <>
              <span
                className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin shrink-0"
                style={{ borderColor: '#22c55e', borderTopColor: 'transparent' }}
              />
              <span className="text-xs font-medium" style={{ color: '#22c55e' }}>Uploading…</span>
            </>
          ) : (
            <>
              <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: 'rgba(34,197,94,0.18)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold" style={{ color: '#22c55e' }}>
                  {uploadButtonLabel || 'Upload new take with fixes'}
                </p>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  After re-recording, drop the file here. The owner sees the new take alongside this one.
                </p>
              </div>
            </>
          )}
        </label>
      )}

      {/* Workflow hint — visible to the narrator only, and only when there's
          unresolved owner feedback. Tells them how to close out items as they
          fix them. Disappears once everything's resolved (or on owner side). */}
      {author.role === 'narrator' && comments.some(c => !c.parent_id && !c.resolved && c.author_role === 'owner') && (
        <div
          className="px-3 py-2 rounded-lg text-[11px] flex items-center gap-2"
          style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', color: 'var(--text-secondary)' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" className="shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>
            Click <strong style={{ color: '#22c55e' }}>“Mark as fixed”</strong> on each comment after you've addressed it. The owner sees what you've resolved and what's still pending.
          </span>
        </div>
      )}

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
                  viewerRole={author.role}
                  highlighted={highlightedId === c.id}
                  onSeek={() => handleMarkerClick(c.id, c.timestamp_ms)}
                  onResolve={() => toggleResolved(c.id, !c.resolved)}
                  onReply={() => {
                    setReplyTo(c.id);
                    // Replies anchor to the parent's timestamp, not a range —
                    // clear any pending range so the user isn't confused by
                    // the lingering banner / silently dropped range on submit.
                    setRangeStartMs(null);
                    textareaRef.current?.focus();
                  }}
                  onDelete={canDelete ? () => deleteComment(c.id) : undefined}
                />
                {myReplies.map(r => (
                  <div key={r.id} className="ml-4 mt-1" data-comment-id={r.id}>
                    <CommentRow
                      c={r}
                      viewerRole={author.role}
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
  c, viewerRole, highlighted, isReply, onSeek, onResolve, onReply, onDelete,
}: {
  c: TakeComment;
  /** Drives the resolve-button copy + tone. Narrators see "Mark as fixed"
   *  framing on owner-authored comments; owners see plain "Resolve". */
  viewerRole: 'owner' | 'narrator';
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

      {!isReply && (() => {
        // The narrator's mental model is "I fixed it" — frame the action
        // that way, with green tinting, so it doesn't read as "owner-only
        // closing your own ticket". Owners see plain "Resolve".
        const isFix = viewerRole === 'narrator' && c.author_role === 'owner';
        const resolveLabel = c.resolved
          ? (isFix ? '✓ Marked as fixed' : '✓ Resolved')
          : (isFix ? '✓ Mark as fixed' : '○ Resolve');
        const resolveTitle = c.resolved
          ? 'Click to re-open'
          : (isFix ? 'You addressed this — click to mark it fixed' : 'Mark this comment resolved');
        return (
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onReply}
              className="text-[11px] px-2 py-1 rounded cursor-pointer transition-colors"
              style={{ color: 'var(--text-muted)', background: 'transparent', border: '1px solid transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              ↩ Reply
            </button>
            {c.resolved && c.resolved_by && (
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                by {c.resolved_by}
              </span>
            )}
            <button
              onClick={onResolve}
              className="text-[11px] px-2.5 py-1 rounded font-medium cursor-pointer transition-colors ml-auto"
              style={{
                color: c.resolved ? '#22c55e' : (isFix ? '#22c55e' : '#a78bfa'),
                background: c.resolved
                  ? 'rgba(34,197,94,0.10)'
                  : isFix ? 'rgba(34,197,94,0.12)' : 'rgba(124,58,237,0.10)',
                border: `1px solid ${c.resolved
                  ? 'rgba(34,197,94,0.25)'
                  : isFix ? 'rgba(34,197,94,0.4)' : 'rgba(124,58,237,0.3)'}`,
              }}
              title={resolveTitle}
            >
              {resolveLabel}
            </button>
          </div>
        );
      })()}
    </div>
  );
}
