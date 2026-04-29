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
  /** Whether this view is the project owner (can resolve comments) */
  isOwner: boolean;
  comments: ReviewComment[];
  activeVersionId: string;
  permission: 'view-only' | 'can-comment' | 'can-annotate';
  author: { name: string; color: string } | null;
  currentTimeMs: number;
  onSeek: (ms: number) => void;
  onCommentAdded: (comment: ReviewComment) => void;
  onCommentResolved: (commentId: string, resolved: boolean, resolvedBy?: string) => void;
  showAllVersions: boolean;
  onToggleAllVersions: () => void;
  pendingDrawing: { data: unknown; thumbnail: string } | null;
  onClearDrawing: () => void;
}

type Filter = 'all' | 'unresolved' | 'resolved';

export function CommentPanel({
  commentsUrl, commentItemUrl, isOwner, comments, activeVersionId, permission, author, currentTimeMs,
  onSeek, onCommentAdded, onCommentResolved, showAllVersions, onToggleAllVersions,
  pendingDrawing, onClearDrawing,
}: CommentPanelProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
        {filtered.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {filter === 'all' ? 'No comments yet — click the timeline to leave one' : `No ${filter} comments`}
            </p>
          </div>
        ) : (
          filtered.map(comment => (
            <div key={comment.id}>
              <CommentItem
                comment={comment}
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
                canResolve={isOwner}
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
          ))
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
