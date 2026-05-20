'use client';

/**
 * Project switcher — picks another production-doc to load into the
 * editor. Mounted from the editor header.
 *
 * The list pulls from `/api/history` (production_doc kind) via the
 * existing `getProductionDocHistory()` helper. Clicking an entry
 * navigates to `/edit/[that-id]` — the editor's route loader is the
 * thing that authoritatively swaps the data, not the client.
 *
 * Includes a "Reload current project from server" action at the top
 * for the case where the project has stale local state (e.g. the
 * production-doc page just generated assets in another tab).
 *
 * No edits happen here — pure navigation + reload. The unsaved-changes
 * confirm prevents the user from clicking through with unsaved work.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, FolderOpen, RefreshCcw, Layers } from 'lucide-react';
import {
  getProductionDocHistory,
  getProductionDocHistoryCached,
  type ProductionDocHistoryEntry,
} from '@/lib/history';
import { Skeleton } from '@/components/editor/Skeleton';

interface ProjectSwitcherProps {
  /** The currently-loaded project's user_history.id. Highlighted in
   *  the list + skipped when computing the disabled state of the
   *  "Switch to this project" buttons. */
  currentProjectId: string;
  /** True when the editor has unsaved changes. The picker confirms
   *  before navigating away to avoid silently losing work. */
  isDirty: boolean;
  /** Force-reload the canonical payload for the CURRENT project from
   *  the server. Equivalent to the conflict banner's reload action
   *  but reachable as a deliberate "pull latest" affordance. */
  onReloadCurrent: () => Promise<void> | void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function ProjectSwitcher({
  currentProjectId,
  isDirty,
  onReloadCurrent,
}: ProjectSwitcherProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  // Seed from the localStorage cache so the popover paints instantly
  // when opened; the server fetch lands in the background.
  const [items, setItems] = useState<ProductionDocHistoryEntry[]>(() => getProductionDocHistoryCached());
  const [loading, setLoading] = useState(false);
  const [reloading, setReloading] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Fetch fresh entries on every popover open. Production-doc autosave
  // is the main writer of this table; opening the picker should always
  // reflect the latest state.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getProductionDocHistory()
      .then((list) => {
        setItems(list);
      })
      .catch(() => {
        /* keep cached list on failure */
      })
      .finally(() => setLoading(false));
  }, [open]);

  // Click-outside catcher closes the popover.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Listen for `editor:open-switcher` so the empty-state overlay can
  // open the picker without prop-drilling through the chrome slots.
  useEffect(() => {
    const onOpenEvt = () => setOpen(true);
    window.addEventListener('editor:open-switcher', onOpenEvt);
    return () => window.removeEventListener('editor:open-switcher', onOpenEvt);
  }, []);

  function confirmNavIfDirty(): boolean {
    if (!isDirty) return true;
    return window.confirm(
      'You have unsaved changes that haven\'t been saved to the server yet. ' +
        'Continue anyway? (Unsaved work will be lost.)',
    );
  }

  async function handleReload() {
    if (reloading) return;
    if (!confirmNavIfDirty()) return;
    setReloading(true);
    console.info('[editor switcher] reload current', { projectId: currentProjectId });
    try {
      await onReloadCurrent();
    } finally {
      setReloading(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="editor-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Open another production doc, or reload this one from the server"
      >
        <FolderOpen size={14} strokeWidth={2} />
        <span>Open</span>
        <ChevronDown size={12} strokeWidth={2} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }} />
      </button>

      {open && (
        <div
          className="editor-panel absolute right-0 mt-1"
          style={{
            width: 360,
            maxHeight: 480,
            display: 'flex',
            flexDirection: 'column',
            zIndex: 50,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
          role="menu"
        >
          {/* Reload current — sits at the top so users with a stale
              project (production-doc generated in another tab) can
              pull the latest without scrolling. */}
          <button
            type="button"
            onClick={handleReload}
            disabled={reloading}
            className="flex items-start gap-2.5 p-2.5 text-left transition-colors hover:bg-white/5"
            style={{ borderBottom: '1px solid var(--editor-edge)' }}
          >
            <div className="shrink-0 mt-0.5" style={{ color: 'var(--editor-accent)' }}>
              <RefreshCcw size={14} strokeWidth={2} className={reloading ? 'animate-spin' : ''} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>
                {reloading ? 'Reloading…' : 'Reload from server'}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                Pull the latest data for THIS project. Useful when the production
                doc was just regenerated in another tab.
              </div>
            </div>
          </button>

          {/* History list */}
          <div className="editor-scroll" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {loading && items.length === 0 && (
              <div className="flex flex-col gap-1 p-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-start gap-2.5 p-1.5">
                    <Skeleton width={14} height={14} radius={3} style={{ marginTop: 2 }} />
                    <div className="flex-1 space-y-1">
                      <Skeleton height={11} width="65%" />
                      <Skeleton height={9} width="45%" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!loading && items.length === 0 && (
              <div className="text-[10px] p-3 text-center" style={{ color: 'var(--fg-muted)' }}>
                No production docs in your workspace yet.
              </div>
            )}
            {items.map((entry) => {
              const isCurrent = entry.id === currentProjectId;
              return (
                <Link
                  key={entry.id}
                  href={`/edit/${entry.id}`}
                  onClick={(e) => {
                    if (isCurrent) {
                      e.preventDefault();
                      setOpen(false);
                      return;
                    }
                    if (!confirmNavIfDirty()) {
                      e.preventDefault();
                      return;
                    }
                    console.info('[editor switcher] navigate', {
                      from: currentProjectId,
                      to: entry.id,
                    });
                    setOpen(false);
                  }}
                  className="flex items-start gap-2.5 p-2.5 transition-colors hover:bg-white/5"
                  style={{
                    background: isCurrent ? 'var(--editor-accent-soft)' : 'transparent',
                    borderBottom: '1px solid var(--editor-edge)',
                    pointerEvents: isCurrent ? 'none' : 'auto',
                  }}
                >
                  <div className="shrink-0 mt-0.5" style={{ color: isCurrent ? 'var(--editor-accent)' : 'var(--fg-muted)' }}>
                    <Layers size={14} strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-[11px] font-medium truncate"
                      style={{ color: isCurrent ? 'var(--editor-accent)' : 'var(--fg)' }}
                      title={entry.title}
                    >
                      {entry.title || 'Untitled project'}
                      {isCurrent && (
                        <span
                          className="ml-1.5 text-[9px] px-1 py-0.5 rounded ed-mono align-middle"
                          style={{ background: 'var(--editor-accent-soft)', color: 'var(--editor-accent)' }}
                        >
                          current
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] tabular-nums" style={{ color: 'var(--fg-muted)' }}>
                      {entry.shotCount} shots · {entry.totalDuration} · {relativeTime(entry.timestamp)}
                    </div>
                    {entry.topic && (
                      <div className="text-[10px] truncate" style={{ color: 'var(--fg-muted)' }} title={entry.topic}>
                        {entry.topic}
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
