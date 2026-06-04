'use client';

import React, { useEffect, useRef, useState } from 'react';

/**
 * InspectorInlineField — a labelled text field with a ✎ edit affordance
 * that swaps to a textarea + Save / Cancel controls. Shared building
 * block for the Studio inspector's editable rows.
 *
 * Behaviour mirrors the legacy production-doc inline edit pattern so
 * keyboard muscle memory transfers:
 *   - Ctrl/Cmd+Enter saves the draft
 *   - Esc cancels the draft
 *   - Blank values display a soft "—" placeholder in read mode
 *
 * Pass `onSave` to make the field editable; omit it for read-only
 * displays (e.g. tests that don't wire writers, or fields the current
 * phase hasn't migrated yet). Per rule 10, the ✎ affordance hides
 * when there's no `onSave` so the user is never shown a control that
 * does nothing.
 */
export interface InspectorInlineFieldProps {
  label: string;
  value: string | undefined;
  /** Called with the trimmed draft when the user commits. The caller
   *  is responsible for translating the new value into the row patch. */
  onSave?: (next: string) => void;
  multiline?: boolean;
  /** Stable string used for `aria-labelledby` / `htmlFor` wiring. */
  fieldId: string;
}

const EMPTY_PLACEHOLDER = '—';

export const InspectorInlineField: React.FC<InspectorInlineFieldProps> = ({
  label,
  value,
  onSave,
  multiline = false,
  fieldId,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // When the row selection changes the underlying value can change
  // while we're not editing — sync the draft so the next "Edit" picks
  // up the fresh value instead of a stale snapshot.
  useEffect(() => {
    if (!isEditing) setDraft(value ?? '');
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      // Place caret at end so the user can append immediately.
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [isEditing]);

  const commit = () => {
    if (!onSave) return;
    const next = draft.trim();
    onSave(next);
    setIsEditing(false);
  };

  const cancel = () => {
    setDraft(value ?? '');
    setIsEditing(false);
  };

  const display = value?.trim() ? value : EMPTY_PLACEHOLDER;
  const isPlaceholder = display === EMPTY_PLACEHOLDER;
  const labelId = `inspector-field-${fieldId}-label`;
  const textareaId = `inspector-field-${fieldId}-textarea`;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div
          id={labelId}
          className="text-[10px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--text-muted)' }}
        >
          {label}
        </div>
        {onSave && !isEditing && (
          <button
            type="button"
            onClick={() => {
              setDraft(value ?? '');
              setIsEditing(true);
            }}
            className="text-[11px] px-1.5 py-0.5 rounded"
            style={{
              color: 'var(--text-muted)',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              cursor: 'pointer',
            }}
            aria-label={`Edit ${label}`}
            title={`Edit ${label}`}
          >
            ✎
          </button>
        )}
      </div>
      {isEditing ? (
        <div className="space-y-2">
          <textarea
            ref={textareaRef}
            id={textareaId}
            aria-labelledby={labelId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            rows={multiline ? 4 : 2}
            className="w-full text-xs rounded px-2 py-1.5 leading-relaxed"
            style={{
              background: 'rgba(0,0,0,0.25)',
              color: 'var(--text-primary)',
              border: '1px solid rgba(255,255,255,0.10)',
              resize: multiline ? 'vertical' : 'none',
            }}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Ctrl+Enter saves · Esc cancels
            </span>
            <button
              type="button"
              onClick={cancel}
              className="text-[11px] px-2 py-1 rounded"
              style={{
                color: 'var(--text-muted)',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.10)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              className="text-[11px] px-2 py-1 rounded"
              style={{
                color: '#0a0a0a',
                background: 'var(--accent-purple-bright, #a78bfa)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div
          aria-labelledby={labelId}
          className={multiline ? 'whitespace-pre-wrap text-xs leading-relaxed' : 'text-xs'}
          style={{
            color: isPlaceholder ? 'var(--text-muted)' : 'var(--text-primary)',
            opacity: isPlaceholder ? 0.6 : 1,
          }}
        >
          {display}
        </div>
      )}
    </div>
  );
};
