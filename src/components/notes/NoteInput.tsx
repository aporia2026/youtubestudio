'use client';

import React, { useEffect, useRef, useState } from 'react';
import { NOTE_TAGS, NOTE_TAG_COLOR, NOTE_TAG_LABEL, type NoteTag } from '@/lib/notes/types';

interface Props {
  /** Pre-filled label showing where the note will be pinned. e.g.
   *  "Scene 4 @ 2.3s" — purely informational. */
  pinLabel: string;
  /** Initial text + tag (used when editing an existing note). */
  initialText?: string;
  initialTag?: NoteTag | null;
  /** Auto-focus the textarea on mount. The dock sets this true so the
   *  N-hotkey workflow is one-keypress-to-typing. */
  autoFocus?: boolean;
  onCancel: () => void;
  /** Called when the user presses Enter (without Shift) or clicks Save.
   *  Shift+Enter inserts a literal newline. */
  onSave: (text: string, tag: NoteTag | null) => void;
}

/**
 * The compact note-input row used by the dock. Renders a textarea with
 * an auto-focus + auto-resize behaviour and a chip row for the six
 * supported tags. Designed for the "pause-and-type" flow:
 *
 *   - `N` opens the input (handled by useNotesHotkeys upstream).
 *   - The textarea is focused immediately so the user types right away.
 *   - Pressing `R/T/S/I/P/Q` with the input focused tags the note.
 *   - `Enter` saves and resumes; `Esc` cancels and resumes.
 *
 * Tag chips are also clickable for the mouse path. The current tag has
 * a stronger background so the user sees what they picked.
 */
export const NoteInput: React.FC<Props> = ({
  pinLabel,
  initialText = '',
  initialTag = null,
  autoFocus = true,
  onCancel,
  onSave,
}) => {
  const [text, setText] = useState(initialText);
  const [tag, setTag] = useState<NoteTag | null>(initialTag);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus + place caret at the end so a quick edit lands the cursor
  // somewhere useful instead of at position 0.
  useEffect(() => {
    if (!autoFocus) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [autoFocus]);

  // Auto-resize textarea up to ~5 lines so the dock doesn't suddenly
  // grow vertical when a long note is typed, but multi-line notes stay
  // readable while being typed.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 140);
    el.style.height = `${next}px`;
  }, [text]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      if (!trimmed) return;
      onSave(trimmed, tag);
      return;
    }
    // Tag shortcuts: only when the textarea is empty OR the user hasn't
    // typed a letter that would naturally appear in prose. Holding ctrl
    // disambiguates from typing — so ctrl+R sets the tag without
    // triggering the browser reload shortcut (we preventDefault).
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const key = e.key.toUpperCase();
      if ((NOTE_TAGS as readonly string[]).includes(key)) {
        e.preventDefault();
        setTag((curr) => (curr === key ? null : (key as NoteTag)));
      }
    }
  }

  const canSave = text.trim().length > 0;

  return (
    <div
      className="rounded-lg"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid var(--border)',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {pinLabel}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Enter to save · Esc to cancel · Ctrl+R/T/S/I/P/Q to tag
        </span>
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What did you notice?"
        rows={2}
        className="w-full text-sm"
        style={{
          background: 'rgba(0,0,0,0.30)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '8px 10px',
          color: 'var(--text-primary)',
          resize: 'none',
          outline: 'none',
          minHeight: 40,
        }}
      />
      <div className="flex items-center justify-between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="flex items-center" style={{ gap: 4, flexWrap: 'wrap' }}>
          {NOTE_TAGS.map((t) => {
            const active = tag === t;
            const color = NOTE_TAG_COLOR[t];
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTag((curr) => (curr === t ? null : t))}
                title={`${NOTE_TAG_LABEL[t]} (Ctrl+${t})`}
                className="text-[10px] px-1.5 py-1 rounded"
                style={{
                  background: active ? `${color}33` : 'rgba(255,255,255,0.04)',
                  color: active ? color : 'var(--text-muted)',
                  border: `1px solid ${active ? color : 'transparent'}`,
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  letterSpacing: '0.04em',
                }}
              >
                {t} · {NOTE_TAG_LABEL[t]}
              </button>
            );
          })}
        </div>
        <div className="flex items-center" style={{ gap: 6 }}>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-2 py-1 rounded"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!canSave) return;
              onSave(text.trim(), tag);
            }}
            disabled={!canSave}
            className="text-xs px-2.5 py-1 rounded"
            style={{
              background: canSave ? 'rgba(168,85,247,0.20)' : 'rgba(255,255,255,0.04)',
              color: canSave ? '#c084fc' : 'var(--text-muted)',
              border: `1px solid ${canSave ? 'rgba(168,85,247,0.40)' : 'var(--border)'}`,
              cursor: canSave ? 'pointer' : 'not-allowed',
              fontWeight: 600,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
