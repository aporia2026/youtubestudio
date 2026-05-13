'use client';

import { useState, useRef, useEffect } from 'react';
import { CommentItem } from './CommentItem';
import { CommentInput } from './CommentInput';
import type { ReviewComment } from './ReviewPage';

interface CommentPanelProps {
  /** Endpoint to POST a new comment to */
  commentsUrl: string;
  /** Builds the endpoint to PATCH a specific comment */
  commentItemUrl: (commentId: string) => string;
  /** Whether this view is the project owner (can resolve + delete any comment) */
  isOwner: boolean;
  /** Whether this user can resolve/unresolve comments. Owners always can;
   *  for token users the server flips this on for editors and narrators. */
  canResolve?: boolean;
  comments: ReviewComment[];
  activeVersionId: string;
  permission: 'view-only' | 'can-comment' | 'can-annotate';
  author: { name: string; color: string } | null;
  currentTimeMs: number;
  onSeek: (ms: number) => void;
  onCommentAdded: (comment: ReviewComment) => void;
  onCommentResolved: (commentId: string, resolved: boolean, resolvedBy?: string) => void;
  /** Called locally after a successful delete so the panel can drop the row. */
  onCommentDeleted?: (commentId: string) => void;
  showAllVersions: boolean;
  onToggleAllVersions: () => void;
  pendingDrawing: { data: unknown; thumbnail: string } | null;
  onClearDrawing: () => void;
  /** Deep-link target — when present, the panel scrolls to and highlights
   *  the matching comment once it's in the list. Used by the global
   *  comments inbox to land the owner on the exact comment they came
   *  from. Switches filter to 'all' so a resolved target isn't hidden. */
  initialHighlightCommentId?: string;
  /** Read-only feedback rows from prior versions, used to surface "did v1
   *  actually get fixed in v2?" while watching the new version. Each row
   *  carries a derived status badge. Empty when on v1 or when no eligible
   *  prior comments exist. */
  priorVersionRows?: Array<{
    comment: ReviewComment;
    status: 'fixed' | 'resolved' | 'open';
  }>;
  /** External highlight pulse — bumping `nonce` re-fires scroll-into-view
   *  + transient highlight for the matching comment. The timeline calls
   *  this via a parent-owned callback when the user clicks a marker. */
  pulseHighlightCommentId?: { id: string; nonce: number } | null;
}

type Filter = 'all' | 'unresolved' | 'resolved';

export function CommentPanel({
  commentsUrl, commentItemUrl, isOwner, canResolve, comments, activeVersionId, permission, author, currentTimeMs,
  onSeek, onCommentAdded, onCommentResolved, onCommentDeleted, showAllVersions, onToggleAllVersions,
  pendingDrawing, onClearDrawing, initialHighlightCommentId, priorVersionRows, pulseHighlightCommentId,
}: CommentPanelProps) {
  // Effective resolve permission: owner always can; token side respects
  // the server's per-collaborator decision (editors + narrators yes).
  const effectiveCanResolve = isOwner || !!canResolve;

  // Owner uses PATCH/DELETE on the same itemUrl. Token-side delete is the
  // same endpoint but with ?author_name=… so the server can verify ownership.
  async function deleteComment(commentId: string, authorName: string) {
    let url = commentItemUrl(commentId);
    if (!isOwner) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}author_name=${encodeURIComponent(authorName)}`;
    }
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (res.ok) onCommentDeleted?.(commentId);
    } catch {}
  }
  const [filter, setFilter] = useState<Filter>('all');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Collapsed by default when the user has lots of prior-version feedback
  // to avoid burying the current-version comments below a long list. We
  // surface the unresolved count in the header so the affordance is still
  // obvious.
  const [priorOpen, setPriorOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Latest priorVersionRows captured for the pulse effect below. The effect
  // intentionally does NOT include `priorVersionRows` in its dep array
  // because ReviewPage rebuilds the array on every render — including it
  // would re-fire the highlight pulse on every comments poll. The ref
  // lets us read the latest rows at the time of the click without making
  // the effect react to the rows themselves.
  const priorVersionRowsRef = useRef(priorVersionRows);
  useEffect(() => { priorVersionRowsRef.current = priorVersionRows; }, [priorVersionRows]);

  // External highlight pulse — fired by the timeline when a marker is
  // clicked. We re-run on every `nonce` bump, even if the id is the same
  // as last time, so two consecutive clicks both pulse-and-scroll.
  useEffect(() => {
    if (!pulseHighlightCommentId) return;
    const { id } = pulseHighlightCommentId;
    setFilter('all');
    setHighlightedId(id);
    if (priorVersionRowsRef.current?.some(r => r.comment.id === id)) setPriorOpen(true);
    const t = setTimeout(() => setHighlightedId(null), 2000);
    return () => clearTimeout(t);
  }, [pulseHighlightCommentId]);

  // Deep-link from the inbox: once the matching comment appears in the
  // list (it lands after the parent's loadData), light it up and scroll.
  // Track which id we've already consumed so a re-render with the same
  // prop doesn't re-trigger the scroll mid-session.
  const consumedDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialHighlightCommentId) return;
    if (consumedDeepLinkRef.current === initialHighlightCommentId) return;
    if (!comments.some(c => c.id === initialHighlightCommentId)) return;
    consumedDeepLinkRef.current = initialHighlightCommentId;
    setFilter('all');
    setHighlightedId(initialHighlightCommentId);
    // Keep the highlight up long enough for the user's eye to find it.
    const t = setTimeout(() => setHighlightedId(null), 4000);
    return () => clearTimeout(t);
  }, [initialHighlightCommentId, comments]);

  const filtered = comments.filter(c => {
    if (c.parent_id) return false; // top-level only; replies rendered under parent
    if (filter === 'unresolved') return !c.resolved;
    if (filter === 'resolved') return c.resolved;
    return true;
  });

  const replies = (parentId: string) => comments.filter(c => c.parent_id === parentId);

  function handleSeekToComment(commentId: string, ms: number) {
    onSeek(ms);
    setHighlightedId(commentId);
    setTimeout(() => setHighlightedId(null), 2000);
  }

  // Scroll to highlighted comment
  useEffect(() => {
    if (highlightedId && listRef.current) {
      const el = listRef.current.querySelector(`[data-comment-id="${highlightedId}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedId]);

  const unresolvedCount = comments.filter(c => !c.resolved && !c.parent_id).length;

  return (
    <div className="w-80 flex flex-col shrink-0" style={{ borderLeft: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
      {/* Header */}
      <div className="px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Comments
            {unresolvedCount > 0 && (
              <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
                {unresolvedCount}
              </span>
            )}
          </h2>
          <button
            onClick={onToggleAllVersions}
            className="text-xs px-2 py-1 rounded transition-colors"
            style={{
              background: showAllVersions ? 'rgba(124,58,237,0.15)' : 'transparent',
              color: showAllVersions ? '#7c3aed' : 'var(--text-muted)',
            }}
          >
            {showAllVersions ? 'All versions' : 'This version'}
          </button>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1">
          {(['all', 'unresolved', 'resolved'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-2 py-1 rounded text-xs capitalize transition-colors"
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
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {/* Prior-version section. Only renders when there are prior comments
            available (i.e. the user is viewing v2+). Each row links back to
            the timestamp on the current version and shows a status badge
            so the reviewer can quickly verify which feedback was actually
            fixed in this version. */}
        {priorVersionRows && priorVersionRows.length > 0 && (
          <PriorVersionsSection
            rows={priorVersionRows}
            open={priorOpen}
            onToggleOpen={() => setPriorOpen(o => !o)}
            highlightedId={highlightedId}
            onJump={(commentId, ms) => handleSeekToComment(commentId, ms)}
          />
        )}
        {filtered.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {filter === 'all' ? 'No comments yet — click the timeline to leave one' : `No ${filter} comments`}
            </p>
          </div>
        ) : (
          filtered.map(comment => {
            // For fix-note comments, look up the original feedback so the
            // CommentItem can render the "Fix for…" badge inline.
            const fixForOriginal = comment.fix_for_comment_id
              ? comments.find(c => c.id === comment.fix_for_comment_id)
              : null;
            return (
            <div key={comment.id}>
              <CommentItem
                comment={comment}
                fixForComment={fixForOriginal ? { author_name: fixForOriginal.author_name, text: fixForOriginal.text, version_number: fixForOriginal.version_number ?? null } : null}
                highlighted={highlightedId === comment.id}
                onSeek={() => handleSeekToComment(comment.id, comment.timestamp_ms)}
                onResolve={async (resolved) => {
                  try {
                    const res = await fetch(commentItemUrl(comment.id), {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ resolved, author_name: author?.name }),
                    });
                    if (res.ok) onCommentResolved(comment.id, resolved, author?.name);
                  } catch {}
                }}
                onDelete={
                  // Owner can delete any comment; non-owner can only delete
                  // their own (server enforces this).
                  isOwner || (author && author.name === comment.author_name)
                    ? () => deleteComment(comment.id, comment.author_name)
                    : undefined
                }
                canResolve={effectiveCanResolve}
              />
              {/* Replies */}
              {replies(comment.id).map(reply => (
                <div key={reply.id} className="ml-4 mt-1">
                  <CommentItem
                    comment={reply}
                    highlighted={highlightedId === reply.id}
                    onSeek={() => handleSeekToComment(reply.id, reply.timestamp_ms)}
                    onResolve={() => {}}
                    canResolve={false}
                    isReply
                  />
                </div>
              ))}
            </div>
            );
          })
        )}
      </div>

      {/* Comment input */}
      {permission !== 'view-only' && author && (
        <CommentInput
          postUrl={commentsUrl}
          activeVersionId={activeVersionId}
          author={author}
          currentTimeMs={currentTimeMs}
          onCommentAdded={onCommentAdded}
          pendingDrawing={pendingDrawing}
          onClearDrawing={onClearDrawing}
        />
      )}
    </div>
  );
}

// ─── Prior versions section ─────────────────────────────────────────────
// Read-only list of feedback from earlier versions, with a per-row status
// badge so the reviewer can scan "did this get fixed?" without flipping
// versions. Clicking a row seeks the current video to that timestamp and
// pulses the highlight (handled by the parent's handleSeekToComment).

interface PriorVersionsSectionProps {
  rows: Array<{ comment: ReviewComment; status: 'fixed' | 'resolved' | 'open' }>;
  open: boolean;
  onToggleOpen: () => void;
  highlightedId: string | null;
  onJump: (commentId: string, ms: number) => void;
}

function formatTimePanel(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function PriorVersionsSection({ rows, open, onToggleOpen, highlightedId, onJump }: PriorVersionsSectionProps) {
  const openCount = rows.filter(r => r.status === 'open').length;
  const fixedCount = rows.filter(r => r.status === 'fixed').length;
  return (
    <div
      className="mb-2 rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}
    >
      <button
        onClick={onToggleOpen}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-white/[0.03] cursor-pointer"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms' }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          From previous versions
        </span>
        <span className="ml-auto flex items-center gap-1">
          {openCount > 0 && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full font-mono"
              style={{ background: 'rgba(234,179,8,0.15)', color: '#eab308' }}
              title={`${openCount} still open`}
            >
              {openCount} open
            </span>
          )}
          {fixedCount > 0 && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full font-mono"
              style={{ background: 'rgba(34,197,94,0.12)', color: '#22c55e' }}
              title={`${fixedCount} fixed in a later version`}
            >
              {fixedCount} fixed
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1.5">
          {rows.map(({ comment, status }) => (
            <PriorVersionRow
              key={comment.id}
              comment={comment}
              status={status}
              highlighted={highlightedId === comment.id}
              onJump={() => onJump(comment.id, comment.timestamp_ms)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PriorVersionRowProps {
  comment: ReviewComment;
  status: 'fixed' | 'resolved' | 'open';
  highlighted: boolean;
  onJump: () => void;
}

function PriorVersionRow({ comment, status, highlighted, onJump }: PriorVersionRowProps) {
  const isRange = comment.end_timestamp_ms != null && comment.end_timestamp_ms > comment.timestamp_ms;
  const badge = status === 'fixed'
    ? { label: 'Fixed', color: '#22c55e', bg: 'rgba(34,197,94,0.12)' }
    : status === 'resolved'
      ? { label: 'Resolved', color: '#06b6d4', bg: 'rgba(6,182,212,0.12)' }
      : { label: 'Open', color: '#eab308', bg: 'rgba(234,179,8,0.15)' };
  // Dim rows that have already been dealt with so the reviewer's eye lands
  // on what still needs attention.
  const dimmed = status !== 'open';
  return (
    <button
      data-comment-id={comment.id}
      onClick={onJump}
      className="w-full text-left p-2 rounded-md cursor-pointer transition-colors hover:bg-white/[0.04]"
      style={{
        background: highlighted ? 'rgba(124,58,237,0.1)' : 'transparent',
        border: highlighted ? '1px solid rgba(124,58,237,0.3)' : '1px solid transparent',
        opacity: dimmed ? 0.6 : 1,
      }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="text-[10px] font-mono px-1 py-0.5 rounded shrink-0"
          style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
        >
          v{comment.version_number ?? '?'}
        </span>
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0"
          style={{ background: 'rgba(124,58,237,0.1)', color: '#a78bfa' }}
        >
          {isRange
            ? `${formatTimePanel(comment.timestamp_ms)}–${formatTimePanel(comment.end_timestamp_ms!)}`
            : formatTimePanel(comment.timestamp_ms)}
        </span>
        <span
          className="text-[10px] font-medium truncate"
          style={{ color: comment.author_color }}
          title={comment.author_name}
        >
          {comment.author_name}
        </span>
        <span
          className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
          style={{ background: badge.bg, color: badge.color }}
        >
          {badge.label}
        </span>
      </div>
      <p
        className="text-[11px] leading-snug line-clamp-2"
        style={{ color: 'var(--text-secondary)' }}
      >
        {comment.text}
      </p>
    </button>
  );
}
