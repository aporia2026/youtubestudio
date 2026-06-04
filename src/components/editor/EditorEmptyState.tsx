'use client';

/**
 * Editor empty-state overlay — shown when the canonical project
 * payload has no shots (or shots-with-no-assets), so the timeline /
 * preview / inspector would otherwise look blank.
 *
 * Three CTAs, in priority order:
 *
 *   1. Pull from production doc — refetches the canonical payload.
 *      Useful when the production-doc page just generated assets
 *      in another tab and the editor's local state is stale.
 *   2. Open in Production Doc — takes the user to where the actual
 *      generation happens. The editor edits; it doesn't generate
 *      docs from scratch.
 *   3. Pick another project — surfaces the history switcher so the
 *      user can load a different production doc into the editor.
 *
 * Renders as a centered card layered above the preview area so the
 * user can still see the chrome (header, left rail, inspector,
 * timeline) but can't miss what to do next.
 */

import Link from 'next/link';
import { useState } from 'react';
import { ExternalLink, FolderOpen, RefreshCcw, Sparkles } from 'lucide-react';

interface EditorEmptyStateProps {
  /** Variant — drives the headline + body copy. */
  kind: 'no-rows' | 'no-assets';
  /** Tracked counts so "no-assets" can show what's actually missing. */
  shotCount: number;
  imageCount: number;
  clipCount: number;
  hasVoiceover: boolean;
  /** Reload the canonical payload for the current project. */
  onReload: () => Promise<void> | void;
  /** Open the project switcher (history list). */
  onOpenSwitcher: () => void;
  /** Production-doc history-entry id for the project the editor is
   *  currently viewing. Threaded into the "Open in Production Doc"
   *  link as `?h=<id>` so the user lands back on the SAME doc instead
   *  of a blank production-doc page — the symptom that drove the
   *  "everything I did is gone" report. */
  projectId: string;
}

export function EditorEmptyState({
  kind,
  shotCount,
  imageCount,
  clipCount,
  hasVoiceover,
  onReload,
  onOpenSwitcher,
  projectId,
}: EditorEmptyStateProps): React.ReactElement {
  const [reloading, setReloading] = useState(false);

  async function handleReload() {
    if (reloading) return;
    setReloading(true);
    console.info('[editor empty-state] reload requested', { kind });
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  }

  const headline =
    kind === 'no-rows'
      ? "This project hasn't been generated yet"
      : 'No assets generated for this project yet';

  const body =
    kind === 'no-rows'
      ? 'The Production Doc page is where AI generates the shot list, images, voiceover, and B-roll. Run it there once, then come back here to edit.'
      : `${shotCount} shot${shotCount === 1 ? '' : 's'} planned, but no images${
          hasVoiceover ? '' : ', no voiceover'
        }${clipCount === 0 ? ', no B-roll' : ''}${
          imageCount === 0 ? '' : ` (${imageCount} stills ready)`
        }. The Production Doc page kicks off generation; you edit the result here.`;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center pointer-events-none"
      style={{ zIndex: 5 }}
    >
      <div
        className="editor-panel pointer-events-auto p-6 text-center max-w-md mx-4"
        style={{
          background: 'var(--editor-panel)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div
          className="inline-flex items-center justify-center rounded-full mb-3"
          style={{
            width: 48,
            height: 48,
            background: 'var(--editor-accent-soft)',
            color: 'var(--editor-accent)',
          }}
        >
          <Sparkles size={22} strokeWidth={2} />
        </div>
        <h2 className="text-base font-semibold" style={{ color: 'var(--fg)' }}>
          {headline}
        </h2>
        <p className="text-xs mt-2 mb-4" style={{ color: 'var(--fg-muted)' }}>
          {body}
        </p>

        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={handleReload}
            disabled={reloading}
            className="editor-btn justify-center disabled:opacity-50"
            style={{ width: '100%' }}
          >
            <RefreshCcw
              size={14}
              strokeWidth={2}
              className={reloading ? 'animate-spin' : ''}
            />
            <span>{reloading ? 'Reloading…' : 'Pull from production doc'}</span>
          </button>
          <Link
            href={`/production-doc?h=${encodeURIComponent(projectId)}`}
            className="editor-btn editor-btn-primary justify-center"
            style={{ width: '100%' }}
          >
            <ExternalLink size={14} strokeWidth={2} />
            <span>Open in Production Doc</span>
          </Link>
          <button
            type="button"
            onClick={onOpenSwitcher}
            className="editor-btn justify-center"
            style={{ width: '100%' }}
          >
            <FolderOpen size={14} strokeWidth={2} />
            <span>Pick a different project</span>
          </button>
        </div>
      </div>
    </div>
  );
}
