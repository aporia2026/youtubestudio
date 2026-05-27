'use client';

/**
 * Inspector → Notes panel. Surfaces the per-row `notes` field as an
 * editable textarea. Distinct from the timeline-level NotesDock,
 * which stores annotations on timeline positions; this is the same
 * field the production-doc grid view shows in its rightmost column
 * and the same field the title-card promotion path backs the prior
 * prompt into.
 *
 * Buffered local state so each keystroke doesn't pump a PATCH_ROW
 * into the undo stack — commits on blur OR Cmd/Ctrl+Enter, mirroring
 * the variant-edit-prompt field's convention.
 */

import { useState } from 'react';
import type { ProductionDoc } from '@/remotion/utils';

type Row = ProductionDoc['rows'][number];

interface Props {
  row: Row;
  /** Commits the notes value via PATCH_ROW. Called on blur or
   *  Cmd/Ctrl+Enter — never on every keystroke. */
  onCommit: (notes: string) => void;
}

export function InspectorNotesPanel({ row, onCommit }: Props): React.ReactElement {
  const value = row.notes ?? '';
  const [local, setLocal] = useState(value);
  // External value changes (selection switch, undo/redo) win over the
  // local buffer unless the user is actively typing in this field.
  const externalChanged = value !== local && document.activeElement?.tagName !== 'TEXTAREA';
  if (externalChanged) {
    setLocal(value);
  }
  return (
    <div
      className="p-3 border-b space-y-2"
      style={{ borderColor: 'var(--card-border)' }}
    >
      <div className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>
        Notes
      </div>
      <textarea
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== value) onCommit(local);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (local !== value) onCommit(local);
          }
        }}
        rows={3}
        placeholder="Per-row notes (production thoughts, alt takes, things to revisit…). Distinct from the timeline NotesDock."
        className="w-full text-[11px] px-2 py-1.5 rounded border bg-transparent resize-y"
        style={{
          borderColor: 'var(--card-border)',
          color: 'var(--fg)',
          minHeight: 60,
        }}
      />
    </div>
  );
}
