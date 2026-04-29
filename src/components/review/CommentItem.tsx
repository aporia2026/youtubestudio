'use client';

import type { ReviewComment } from './ReviewPage';

interface CommentItemProps {
  comment: ReviewComment;
  highlighted: boolean;
  onSeek: () => void;
  onResolve: (resolved: boolean) => void;
  canResolve: boolean;
  isReply?: boolean;
}

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

export function CommentItem({ comment, highlighted, onSeek, onResolve, canResolve, isReply }: CommentItemProps) {
  return (
    <div
      data-comment-id={comment.id}
      className="p-2.5 rounded-lg transition-all"
      style={{
        background: highlighted ? 'rgba(124,58,237,0.1)' : 'var(--bg-primary)',
        border: highlighted ? '1px solid rgba(124,58,237,0.3)' : '1px solid transparent',
        opacity: comment.resolved ? 0.5 : 1,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <div
          className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
          style={{ background: comment.author_color }}
        >
          {(comment.author_name || '?')[0].toUpperCase()}
        </div>
        <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {comment.author_name}
        </span>
        {comment.version_number != null && (
          <span className="text-[10px] px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>
            v{comment.version_number}
          </span>
        )}
        <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-muted)' }}>
          {timeAgo(comment.created_at)}
        </span>
      </div>

      {/* Timestamp badge */}
      {!isReply && (
        <button
          onClick={onSeek}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded mb-1.5 transition-colors hover:bg-purple-500/20"
          style={{ background: 'rgba(124,58,237,0.1)', color: '#a78bfa' }}
        >
          {formatTime(comment.timestamp_ms)}
        </button>
      )}

      {/* Drawing thumbnail */}
      {comment.drawing_thumbnail_url && (
        <div className="mb-1.5">
          <img
            src={comment.drawing_thumbnail_url}
            alt="Annotation"
            className="w-full rounded border cursor-pointer"
            style={{ borderColor: 'var(--border)' }}
            onClick={onSeek}
          />
        </div>
      )}

      {/* Text */}
      <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
        {comment.text}
      </p>

      {/* Resolve button */}
      {canResolve && !isReply && (
        <div className="flex items-center justify-end mt-1.5">
          <button
            onClick={() => onResolve(!comment.resolved)}
            className="text-[10px] flex items-center gap-1 transition-colors"
            style={{ color: comment.resolved ? '#22c55e' : 'var(--text-muted)' }}
          >
            {comment.resolved ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                Resolved
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /></svg>
                Resolve
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
