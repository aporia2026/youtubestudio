'use client';

import { useState, useRef } from 'react';
import type { ReviewComment } from './ReviewPage';

interface CommentInputProps {
  postUrl: string;
  activeVersionId: string;
  author: { name: string; color: string };
  currentTimeMs: number;
  onCommentAdded: (comment: ReviewComment) => void;
  pendingDrawing: { data: unknown; thumbnail: string } | null;
  onClearDrawing: () => void;
}

function formatTime(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function CommentInput({
  postUrl, activeVersionId, author, currentTimeMs,
  onCommentAdded, pendingDrawing, onClearDrawing,
}: CommentInputProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Range mode: when on, the comment applies from rangeStartMs..currentTimeMs.
  // The user clicks "Mark start" at the beginning of the range, then types
  // their comment + submits at the end of the range.
  const [rangeStartMs, setRangeStartMs] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Snapshot the start at the moment the user enabled range mode so seeking
  // around to verify the end doesn't lose the start.
  function startRange() {
    setRangeStartMs(currentTimeMs);
  }

  function clearRange() {
    setRangeStartMs(null);
  }

  async function handleSubmit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);

    try {
      // Upload drawing thumbnail to Vercel Blob if present
      let drawing_thumbnail_url: string | undefined;
      if (pendingDrawing?.thumbnail) {
        try {
          const blob = await fetch(pendingDrawing.thumbnail).then(r => r.blob());
          const formData = new FormData();
          formData.append('file', blob, 'annotation.png');
          formData.append('type', 'image');
          const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
          if (uploadRes.ok) {
            const data = await uploadRes.json();
            drawing_thumbnail_url = data.url;
          }
        } catch {}
      }

      // Compute the timestamp + optional end. Range mode submits start..now;
      // point mode submits just `now`.
      const isRange = rangeStartMs !== null && rangeStartMs < currentTimeMs;
      const timestamp_ms = isRange ? rangeStartMs! : currentTimeMs;
      const end_timestamp_ms = isRange ? currentTimeMs : null;

      const res = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version_id: activeVersionId,
          timestamp_ms,
          end_timestamp_ms,
          text: text.trim(),
          author_name: author.name,
          author_color: author.color,
          drawing_data: pendingDrawing?.data || undefined,
          drawing_thumbnail_url,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'Failed to post comment');
      }

      const comment = await res.json();
      onCommentAdded(comment);
      setText('');
      setRangeStartMs(null);
      onClearDrawing();
      textareaRef.current?.focus();
    } catch (err) {
      console.error('Failed to post comment:', err);
    } finally {
      setSubmitting(false);
    }
  }

  const isRangeActive = rangeStartMs !== null;
  const rangeValid = isRangeActive && rangeStartMs! < currentTimeMs;

  return (
    <div className="px-3 py-3 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
      {/* Drawing preview */}
      {pendingDrawing && (
        <div className="mb-2 relative">
          <img
            src={pendingDrawing.thumbnail}
            alt="Annotation preview"
            className="w-full rounded border"
            style={{ borderColor: 'var(--border)' }}
          />
          <button
            onClick={onClearDrawing}
            className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-white cursor-pointer"
            style={{ background: 'rgba(0,0,0,0.6)' }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* Range mode banner — visible when the user has marked a start */}
      {isRangeActive && (
        <div className="mb-2 flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style={{ background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.3)' }}>
          <span className="text-[10px] font-mono" style={{ color: '#a78bfa' }}>
            {formatTime(rangeStartMs!)} → {formatTime(currentTimeMs)}
          </span>
          {!rangeValid && (
            <span className="text-[10px] italic" style={{ color: '#eab308' }}>
              Seek to a later moment, then type your comment
            </span>
          )}
          <button
            onClick={clearRange}
            className="ml-auto text-[10px] px-1.5 py-0.5 rounded cursor-pointer"
            style={{ color: 'var(--text-muted)' }}
            title="Cancel range — make this a point-in-time comment"
          >
            Cancel range
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <div className="text-[10px] font-mono mb-1 px-1 flex items-center gap-2" style={{ color: '#a78bfa' }}>
            <span>
              {isRangeActive
                ? (rangeValid ? `range ${formatTime(rangeStartMs!)}–${formatTime(currentTimeMs)}` : `range starts at ${formatTime(rangeStartMs!)}`)
                : `at ${formatTime(currentTimeMs)}`}
            </span>
            {!isRangeActive && (
              <button
                onClick={startRange}
                className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer transition-colors hover:bg-purple-500/10"
                style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                title="Mark this as the START of a range comment, then seek forward and submit"
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
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
            }}
            placeholder={isRangeActive ? (rangeValid ? 'Comment on this range…' : 'Seek forward, then comment…') : 'Add a comment...'}
            rows={2}
            className="w-full px-3 py-2 rounded-lg text-xs resize-none"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          />
        </div>
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || submitting || (isRangeActive && !rangeValid)}
          className="p-2 rounded-lg text-white disabled:opacity-30 transition-colors shrink-0 cursor-pointer disabled:cursor-not-allowed"
          style={{ background: '#7c3aed' }}
          title={isRangeActive && !rangeValid ? 'Seek past the start time first' : 'Post comment'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
