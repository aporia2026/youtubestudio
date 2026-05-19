'use client';

/**
 * Editor top header — Phase 2 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Sits in the 48 px header slot of `EditorChrome`. Left side is the
 * project title block (title · shot count · duration · version).
 * Right side is the action cluster: save status pill, undo / redo,
 * save button, export menu, help, ← back link.
 *
 * Everything else (AI tools, doc-level flag toggles, mute, etc.)
 * moves out of the top toolbar and into the left rail / inspector
 * in Phases 3-4. The header stays focused on global project
 * navigation actions only.
 */

import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  HelpCircle,
  Redo2,
  Save as SaveIcon,
  Undo2,
} from 'lucide-react';

interface EditorHeaderProps {
  title: string;
  shotCount: number;
  totalDuration: string;
  version: number;
  saveStatusLabel: string;
  saveStatusColor: string;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  /** Endpoint for the export download (no Next router involvement —
   *  we want the browser to download the .otio file natively). */
  exportHref: string;
  onHelp: () => void;
}

export function EditorHeader({
  title,
  shotCount,
  totalDuration,
  version,
  saveStatusLabel,
  saveStatusColor,
  isDirty,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  exportHref,
  onHelp,
}: EditorHeaderProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between h-full px-3 gap-3">
      {/* Title block ─────────────────────────────────────── */}
      <div className="min-w-0 flex items-baseline gap-3">
        <h1
          className="text-sm font-semibold truncate"
          style={{ color: 'var(--fg)', maxWidth: '40ch' }}
          title={title}
        >
          {title || 'Untitled project'}
        </h1>
        <span className="text-[11px] shrink-0 tabular-nums ed-mono" style={{ color: 'var(--fg-muted)' }}>
          {shotCount} shots · {totalDuration} · v{version}
        </span>
      </div>

      {/* Action cluster ──────────────────────────────────── */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span
          className="text-[11px] tabular-nums px-2 py-1 rounded-md"
          style={{ color: saveStatusColor, background: 'transparent' }}
          aria-live="polite"
        >
          {saveStatusLabel}
        </span>

        <span className="editor-divider" aria-hidden />

        <button
          type="button"
          className="editor-icon-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Cmd/Ctrl+Z)"
          aria-label="Undo"
        >
          <Undo2 size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="editor-icon-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Cmd/Ctrl+Shift+Z)"
          aria-label="Redo"
        >
          <Redo2 size={16} strokeWidth={2} />
        </button>

        <button
          type="button"
          className={isDirty ? 'editor-btn editor-btn-primary' : 'editor-btn'}
          onClick={onSave}
          disabled={!isDirty}
          title="Save now (Cmd/Ctrl+S)"
        >
          <SaveIcon size={14} strokeWidth={2} />
          <span>Save</span>
        </button>

        <a
          href={exportHref}
          className="editor-btn"
          title="Download timeline as OpenTimelineIO JSON. Importable into DaVinci Resolve, Premiere, and Final Cut via otioconvert."
        >
          <Download size={14} strokeWidth={2} />
          <span>Export</span>
        </a>

        <button
          type="button"
          className="editor-icon-btn"
          onClick={onHelp}
          title="Keyboard shortcuts"
          aria-label="Help"
        >
          <HelpCircle size={16} strokeWidth={2} />
        </button>

        <span className="editor-divider" aria-hidden />

        <Link
          href="/production-doc"
          className="editor-btn"
          title="Back to Production Doc"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          <span>Doc</span>
        </Link>
      </div>
    </div>
  );
}
