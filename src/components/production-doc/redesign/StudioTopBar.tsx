'use client';

import React from 'react';
import type { ProductionDoc } from '@/remotion/utils';

/**
 * StudioTopBar — the top chrome of Studio Mode. See
 * `_plans/2026-06-04-production-doc-redesign.md` §4.2 for the target.
 *
 * Phase R2 first PR: ships the project title + condensed meta
 * (scene count, word count, target duration) + the New session
 * button. The richer top-bar controls from the mock (Brief return,
 * Bulk grid toggle, Open in editor, Export, shortcuts, overflow
 * menu, primary Render CTA) land in subsequent R2 / R5 PRs as their
 * backing surfaces and drawers are built. Per rule 10, no dead
 * buttons.
 *
 * The legacy header above the page is hidden whenever the redesign
 * flag is on (see the conditional in `page.tsx`), so this top bar
 * is the only header users see in Studio Mode.
 */
export interface StudioTopBarProps {
  doc: ProductionDoc;
  /** Same callback the BriefHeader uses — wired to today's
   *  `resetSession`. Optional so the bar stays renderable in tests. */
  onNewSession?: () => void;
}

export const StudioTopBar: React.FC<StudioTopBarProps> = ({ doc, onNewSession }) => {
  const sceneCount = doc.rows?.length ?? 0;
  const wordCount = doc.total_words ?? 0;
  const duration = doc.total_duration ?? '';

  return (
    <header
      className="mb-6 flex items-start justify-between gap-4 flex-wrap"
      aria-label="Studio top bar"
    >
      <div className="min-w-0">
        <h1
          className="text-2xl font-semibold tracking-tight truncate"
          style={{ color: 'var(--text-primary)' }}
          title={doc.title}
        >
          {doc.title || 'Untitled production'}
        </h1>
        <p
          className="text-xs mt-1 flex flex-wrap items-center gap-x-3 gap-y-1"
          style={{ color: 'var(--text-muted)' }}
        >
          <span>
            {sceneCount} {sceneCount === 1 ? 'scene' : 'scenes'}
          </span>
          {wordCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{wordCount.toLocaleString()} words</span>
            </>
          )}
          {duration && (
            <>
              <span aria-hidden="true">·</span>
              <span>{duration}</span>
            </>
          )}
        </p>
      </div>
      {onNewSession && (
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <button
            type="button"
            onClick={onNewSession}
            className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
            style={{
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-secondary)',
              border: '1px solid rgba(255,255,255,0.10)',
              cursor: 'pointer',
            }}
            title="Clear the current doc to start fresh. Previous generations stay in the history."
          >
            New session
          </button>
        </div>
      )}
    </header>
  );
};
