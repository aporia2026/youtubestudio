'use client';

import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { VideoShot } from '@/remotion/types';
import { formatSceneTs } from '@/lib/notes/scene-math';
import {
  NOTE_TAGS,
  NOTE_TAG_COLOR,
  NOTE_TAG_LABEL,
  type NoteTag,
  type ProductionDocNote,
} from '@/lib/notes/types';
import { useNotes } from '@/lib/notes/store';

/**
 * Full-doc review queue. Modal-style panel that opens from the dock or
 * via Shift+N. Shows every unresolved note grouped by scene, with
 * filters by tag type. Click any note to jump to that exact moment.
 *
 * Why a modal and not a sidebar:
 *   - The dock is the active-scene view; the queue is the "step back
 *     and see everything" view. Different mode → different surface.
 *   - The host pages have wildly different layouts (grid table vs.
 *     three-pane editor). A modal docked to the player is the only
 *     position that works the same on both.
 *
 * Markdown export (Phase 5 folded in): one-click copy of every note,
 * grouped by scene, with tag + timestamp prefixes. Lets the user
 * paste the list into a regeneration prompt or send to a collaborator.
 */
interface Props {
  docId: string;
  shots: VideoShot[];
  fps: number;
  /** Notes are passed in by the dock to avoid double-subscribing to the
   *  same store. We only need the writers from `useNotes()` here. */
  notes: ProductionDocNote[];
  onSeekToNote: (note: ProductionDocNote) => void;
  onClose: () => void;
}

type TagFilter = 'all' | NoteTag;

export const ReviewQueue: React.FC<Props> = ({
  docId,
  shots,
  fps,
  notes,
  onSeekToNote,
  onClose,
}) => {
  // We still call useNotes() here just to get the writers; the rendered
  // list comes from the prop so the dock and queue stay in lockstep
  // even during optimistic edits.
  const { remove, toggleResolved } = useNotes(docId);
  const [tagFilter, setTagFilter] = useState<TagFilter>('all');
  const [showResolved, setShowResolved] = useState(false);

  const filtered = useMemo(() => {
    return notes.filter((n) => {
      if (!showResolved && n.resolved) return false;
      if (tagFilter !== 'all' && n.tag !== tagFilter) return false;
      return true;
    });
  }, [notes, tagFilter, showResolved]);

  // Group by row_index for the "by scene" header structure. Already
  // sorted by the store. fps + shots aren't used here directly but
  // we keep them as props so the click handler stays in the host
  // (it already has the controller).
  void fps;
  const groups = useMemo(() => {
    const m = new Map<number, ProductionDocNote[]>();
    for (const n of filtered) {
      const bucket = m.get(n.rowIndex) ?? [];
      bucket.push(n);
      m.set(n.rowIndex, bucket);
    }
    return Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  }, [filtered]);

  const counts = useMemo(() => {
    const open = notes.filter((n) => !n.resolved).length;
    const resolved = notes.length - open;
    const byTag: Record<NoteTag, number> = { R: 0, T: 0, S: 0, I: 0, P: 0, Q: 0 };
    for (const n of notes) {
      if (n.resolved) continue;
      if (n.tag) byTag[n.tag]++;
    }
    return { open, resolved, byTag };
  }, [notes]);

  function buildMarkdown(): string {
    const lines: string[] = [];
    lines.push(`# Production-doc notes`);
    lines.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
    lines.push('');
    const open = notes.filter((n) => !n.resolved);
    const resolved = notes.filter((n) => n.resolved);
    if (open.length > 0) {
      lines.push(`## Open (${open.length})`);
      const byScene = new Map<number, ProductionDocNote[]>();
      for (const n of open.sort(
        (a, b) =>
          a.rowIndex - b.rowIndex ||
          a.sceneTsMs - b.sceneTsMs ||
          a.createdAt.localeCompare(b.createdAt),
      )) {
        const bucket = byScene.get(n.rowIndex) ?? [];
        bucket.push(n);
        byScene.set(n.rowIndex, bucket);
      }
      for (const [rowIndex, list] of Array.from(byScene.entries()).sort((a, b) => a[0] - b[0])) {
        lines.push('');
        lines.push(`### Scene ${rowIndex + 1}`);
        for (const n of list) {
          const tag = n.tag ? `[${n.tag} ${NOTE_TAG_LABEL[n.tag]}] ` : '';
          lines.push(`- ${tag}(@ ${formatSceneTs(n.sceneTsMs)}) ${n.text.replace(/\n/g, ' / ')}`);
        }
      }
    }
    if (resolved.length > 0) {
      lines.push('');
      lines.push(`## Resolved (${resolved.length})`);
      lines.push('<details>');
      for (const n of resolved) {
        const tag = n.tag ? `[${n.tag} ${NOTE_TAG_LABEL[n.tag]}] ` : '';
        lines.push(
          `- scene ${n.rowIndex + 1} · ${tag}(@ ${formatSceneTs(n.sceneTsMs)}) ${n.text.replace(/\n/g, ' / ')}`,
        );
      }
      lines.push('</details>');
    }
    return lines.join('\n');
  }

  async function handleCopyMarkdown() {
    const md = buildMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      toast.success('Notes copied as Markdown');
    } catch {
      toast.error('Clipboard write failed — try the Download button instead.');
    }
  }

  function handleDownloadMarkdown() {
    const md = buildMarkdown();
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `production-doc-notes-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Markdown downloaded');
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 90,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-xl"
        style={{
          background: 'var(--bg-elevated, #181818)',
          border: '1px solid var(--border)',
          width: 'min(720px, 92vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
        }}
      >
        <div
          className="flex items-center justify-between"
          style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}
        >
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Review queue
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {counts.open} open · {counts.resolved} resolved · click any note to jump
            </div>
          </div>
          <div className="flex items-center" style={{ gap: 6 }}>
            <button
              type="button"
              onClick={handleCopyMarkdown}
              className="text-xs px-2 py-1 rounded"
              title="Copy all notes to clipboard as Markdown"
              style={{
                background: 'rgba(255,255,255,0.04)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              📋 Copy MD
            </button>
            <button
              type="button"
              onClick={handleDownloadMarkdown}
              className="text-xs px-2 py-1 rounded"
              title="Download a .md file with all notes"
              style={{
                background: 'rgba(255,255,255,0.04)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              ⬇ .md
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-2 py-1 rounded"
              title="Close (Esc)"
              style={{
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Tag filters */}
        <div
          className="flex items-center"
          style={{ padding: '10px 18px', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}
        >
          <FilterChip
            label={`All · ${counts.open}`}
            active={tagFilter === 'all'}
            color="#a78bfa"
            onClick={() => setTagFilter('all')}
          />
          {NOTE_TAGS.map((t) => (
            <FilterChip
              key={t}
              label={`${t} ${NOTE_TAG_LABEL[t]}${counts.byTag[t] > 0 ? ` · ${counts.byTag[t]}` : ''}`}
              active={tagFilter === t}
              color={NOTE_TAG_COLOR[t]}
              onClick={() => setTagFilter(t)}
            />
          ))}
          <span style={{ flex: 1 }} />
          <label
            className="text-[11px] flex items-center"
            style={{ color: 'var(--text-muted)', gap: 4, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
            />
            show resolved
          </label>
        </div>

        {/* Grouped list */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
          {groups.length === 0 ? (
            <div
              className="text-xs text-center"
              style={{ color: 'var(--text-muted)', padding: '24px 18px' }}
            >
              No notes match this filter.
            </div>
          ) : (
            groups.map(([rowIndex, list]) => {
              const sceneTitle = shots[rowIndex]?.onScreenText
                || shots[rowIndex]?.scriptText?.slice(0, 60)
                || shots[rowIndex]?.title
                || `Scene ${rowIndex + 1}`;
              return (
                <div key={rowIndex} style={{ padding: '8px 18px' }}>
                  <div
                    className="text-[11px] uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)', marginBottom: 6 }}
                  >
                    Scene {rowIndex + 1} · {sceneTitle.slice(0, 80)}
                  </div>
                  <div className="flex flex-col" style={{ gap: 6 }}>
                    {list.map((note) => {
                      const color = note.tag ? NOTE_TAG_COLOR[note.tag] : 'var(--text-muted)';
                      return (
                        <div
                          key={note.id}
                          className="flex items-start gap-2 rounded"
                          style={{
                            padding: '6px 8px',
                            background: note.resolved
                              ? 'rgba(255,255,255,0.02)'
                              : 'rgba(255,255,255,0.05)',
                            opacity: note.resolved ? 0.6 : 1,
                            border: '1px solid var(--border)',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => onSeekToNote(note)}
                            className="text-[10px] px-1.5 py-0.5 rounded"
                            style={{
                              background: 'rgba(0,0,0,0.30)',
                              color: 'var(--text-secondary)',
                              border: '1px solid var(--border)',
                              cursor: 'pointer',
                              flexShrink: 0,
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            }}
                          >
                            {formatSceneTs(note.sceneTsMs)}
                          </button>
                          {note.tag && (
                            <span
                              className="text-[10px] px-1 py-0.5 rounded"
                              title={NOTE_TAG_LABEL[note.tag]}
                              style={{
                                background: `${color}22`,
                                color,
                                border: `1px solid ${color}66`,
                                flexShrink: 0,
                                fontWeight: 600,
                              }}
                            >
                              {note.tag}
                            </span>
                          )}
                          <div
                            className="text-xs"
                            style={{
                              color: 'var(--text-primary)',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              flex: 1,
                              minWidth: 0,
                              textDecoration: note.resolved ? 'line-through' : 'none',
                            }}
                          >
                            {note.text}
                          </div>
                          <div className="flex items-center" style={{ gap: 4, flexShrink: 0 }}>
                            <button
                              type="button"
                              onClick={() => void toggleResolved(note.id)}
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              title={note.resolved ? 'Re-open' : 'Mark resolved'}
                              style={{
                                background: 'transparent',
                                color: 'var(--text-muted)',
                                border: '1px solid var(--border)',
                                cursor: 'pointer',
                              }}
                            >
                              {note.resolved ? '↺' : '✓'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void remove(note.id)}
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              title="Delete"
                              style={{
                                background: 'transparent',
                                color: 'var(--text-muted)',
                                border: '1px solid var(--border)',
                                cursor: 'pointer',
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

const FilterChip: React.FC<{
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}> = ({ label, active, color, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="text-[10px] px-1.5 py-1 rounded"
    style={{
      background: active ? `${color}33` : 'rgba(255,255,255,0.04)',
      color: active ? color : 'var(--text-secondary)',
      border: `1px solid ${active ? color : 'var(--border)'}`,
      cursor: 'pointer',
      fontWeight: active ? 600 : 400,
    }}
  >
    {label}
  </button>
);
