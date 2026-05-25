'use client';

import React, { useEffect, useRef, useState } from 'react';

interface InlinePromptEditorProps {
  /** Current value of the prompt. Empty string is allowed and renders an
   *  "Add a prompt" affordance. */
  value: string;
  /** Save the new value without triggering image generation. */
  onSave: (next: string) => void;
  /** Save + immediately kick off a regen with the new prompt. Optional;
   *  when undefined we hide the "Save & regenerate" affordance. */
  onSaveAndRegenerate?: (next: string) => void;
  placeholder?: string;
  /** Hard cap mirroring the server's prompt validator (see the generate
   *  routes). 2000 chars is generous but stops the user from pasting a
   *  full script by accident. */
  maxLength?: number;
}

/**
 * Inline editor for the row's `ai_image_prompt`. Read-only display by
 * default; clicking ✎ switches to a textarea with Save / Cancel /
 * "Save & regenerate" actions. The whole thing lives inside the
 * B-roll accordion in the editor view, so the user can fix a wrong
 * prompt and immediately re-roll the image without leaving the section.
 *
 * This is the editor's answer to a long-standing friction: today the
 * prompt is rendered as a static span in the table cell and is only
 * editable via a separate "edit prompt" inline form on the table row
 * that the editor view doesn't currently expose. With this component
 * the editor matches table parity for prompt edits and adds the
 * Save-and-regenerate shortcut on top.
 */
export const InlinePromptEditor: React.FC<InlinePromptEditorProps> = ({
  value,
  onSave,
  onSaveAndRegenerate,
  placeholder = 'Add a prompt for this image…',
  maxLength = 2000,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync the draft when the upstream value changes from outside (e.g. an
  // undo restored a prior prompt). Only resyncs when we're not actively
  // editing so the user's in-progress text isn't clobbered.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // Auto-focus + autosize the textarea on enter.
  useEffect(() => {
    if (!editing) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autosize(ta);
  }, [editing]);

  const trimmedDraft = draft.trim();
  const hasChange = trimmedDraft !== value.trim();

  const commit = (alsoRegen: boolean) => {
    if (!editing) return;
    if (alsoRegen && onSaveAndRegenerate && trimmedDraft) {
      onSaveAndRegenerate(trimmedDraft);
    } else if (hasChange) {
      onSave(trimmedDraft);
    }
    setEditing(false);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        className="text-xs rounded px-2 py-2 group relative"
        style={{
          background: 'rgba(0,0,0,0.3)',
          color: value ? 'var(--text-secondary)' : 'var(--text-muted)',
          border: '1px solid var(--border)',
        }}
      >
        <div className="whitespace-pre-wrap pr-7" style={{ fontStyle: value ? 'normal' : 'italic' }}>
          {value || placeholder}
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="absolute top-1.5 right-1.5 rounded px-1.5 py-0.5 text-[10px] transition-opacity opacity-60 hover:opacity-100"
          style={{
            background: 'rgba(255,255,255,0.06)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}
          title="Edit AI prompt"
          aria-label="Edit AI prompt"
        >
          ✎ Edit
        </button>
      </div>
    );
  }

  return (
    <div
      className="rounded"
      style={{
        background: 'rgba(0,0,0,0.3)',
        border: '1px solid rgba(168,85,247,0.45)',
      }}
    >
      <textarea
        ref={textareaRef}
        value={draft}
        maxLength={maxLength}
        onChange={(e) => {
          setDraft(e.target.value);
          autosize(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
            return;
          }
          // Cmd/Ctrl + Enter saves (matches code-editor conventions and
          // doesn't fight the user's natural typing of newlines in
          // prompt text).
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            commit(e.shiftKey && Boolean(onSaveAndRegenerate));
          }
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full text-xs px-2 py-2 outline-none resize-none"
        style={{
          background: 'transparent',
          color: 'var(--text-primary)',
          minHeight: 60,
          maxHeight: 240,
          lineHeight: 1.5,
        }}
      />
      <div
        className="flex items-center justify-between gap-2 px-2 py-1.5"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <span
          className="text-[10px] tabular-nums"
          style={{
            color: draft.length >= maxLength ? '#f87171' : 'var(--text-muted)',
            fontVariantNumeric: 'tabular-nums',
          }}
          title={`${maxLength} character limit`}
        >
          {draft.length} / {maxLength}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={cancel}
            className="text-[11px] px-2 py-1 rounded"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
            }}
            title="Discard changes (Esc)"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => commit(false)}
            disabled={!hasChange}
            className="text-[11px] px-2 py-1 rounded"
            style={{
              background: hasChange ? 'rgba(255,255,255,0.06)' : 'transparent',
              color: hasChange ? 'var(--text-primary)' : 'var(--text-muted)',
              border: '1px solid var(--border)',
              opacity: hasChange ? 1 : 0.55,
              cursor: hasChange ? 'pointer' : 'not-allowed',
            }}
            title="Save (Cmd/Ctrl + Enter)"
          >
            Save
          </button>
          {onSaveAndRegenerate && (
            <button
              type="button"
              onClick={() => commit(true)}
              disabled={!trimmedDraft}
              className="text-[11px] px-2 py-1 rounded font-medium"
              style={{
                background: trimmedDraft ? 'rgba(168,85,247,0.22)' : 'transparent',
                color: trimmedDraft ? '#c084fc' : 'var(--text-muted)',
                border: '1px solid rgba(168,85,247,0.45)',
                opacity: trimmedDraft ? 1 : 0.55,
                cursor: trimmedDraft ? 'pointer' : 'not-allowed',
              }}
              title="Save and immediately regenerate the image with the new prompt (Cmd/Ctrl + Shift + Enter)"
            >
              ✦ Save & regenerate
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}
