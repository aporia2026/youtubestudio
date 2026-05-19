'use client';

/**
 * Editor chrome — the top-level layout shell for `/edit/[projectId]`.
 *
 * Phase 1 of `_plans/2026-05-19-editor-real-nle-look.md`. Replaces
 * the centered max-width container the editor used to render in
 * with a full-bleed CSS grid that has dedicated regions for:
 *
 *   ┌──────────────────────────────────────────┐
 *   │  header                                  │
 *   ├──────┬────────────────────┬──────────────┤
 *   │ rail │  preview           │  inspector   │
 *   │      │  + transport       │              │
 *   ├──────┴────────────────────┴──────────────┤
 *   │  timeline                                │
 *   └──────────────────────────────────────────┘
 *
 * The shell is intentionally dumb — it only handles layout and the
 * left-rail open/closed toggle. Content for each region comes in
 * as `slots`, so the existing `EditorClient` can render its
 * existing nodes into them while Phases 2-5 incrementally replace
 * those nodes with the new CapCut-style components.
 *
 * Classes are defined in `src/app/(app)/edit/[projectId]/editor-theme.css`.
 * The `editor-root` wrapper scopes every CSS override to inside the
 * editor; nothing leaks to the rest of the app.
 */

import { useCallback, useEffect, useState } from 'react';
// Import the editor's CSS overrides side-effect. Next.js picks up
// the `.css` side-effect import and includes it in the editor route's
// CSS bundle without bleeding into other routes.
import '@/app/(app)/edit/[projectId]/editor-theme.css';

export interface EditorChromeSlots {
  /** Top header — 48 px tall. Title, save status, export, help, back. */
  header: React.ReactNode;
  /** Left vertical icon rail. Collapsed by default (64 px), expands
   *  to a 240 px drawer when the user clicks an icon. */
  leftRail: React.ReactNode;
  /** Center preview + transport bar. The preview should fill the
   *  vertical space; the transport bar is its own row underneath. */
  preview: React.ReactNode;
  /** Right inspector. 320 px wide. Contextual tabs handled inside. */
  inspector: React.ReactNode;
  /** Bottom timeline region — 280 px tall. Multi-lane in Phase 5. */
  timeline: React.ReactNode;
}

interface EditorChromeProps {
  slots: EditorChromeSlots;
  /** Whether the left rail starts in drawer mode. Defaults to
   *  collapsed; the user opens what they need (per the plan's
   *  resolved open-questions list). */
  initialRailOpen?: boolean;
}

export function EditorChrome({ slots, initialRailOpen = false }: EditorChromeProps): React.ReactElement {
  const [railOpen, setRailOpen] = useState(initialRailOpen);

  // Allow the left-rail subcomponent to toggle itself open / closed
  // by listening for a custom event. Avoids prop-drilling a callback
  // through every render — the rail just fires `editor:rail-toggle`.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ open?: boolean }>).detail;
      if (typeof detail?.open === 'boolean') {
        setRailOpen(detail.open);
      } else {
        setRailOpen((v) => !v);
      }
    };
    window.addEventListener('editor:rail-toggle', handler);
    return () => window.removeEventListener('editor:rail-toggle', handler);
  }, []);

  const handleKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Mark the root focusable for keyboard shortcuts to work even
    // when no specific element is focused. Cmd/Ctrl+B toggles the
    // left rail — a common shortcut across modern editors.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      setRailOpen((v) => !v);
    }
  }, []);

  console.info('[editor chrome] render', { railOpen });

  return (
    <div className="editor-root" tabIndex={-1} onKeyDown={handleKey}>
      <div className="editor-grid" data-rail-open={railOpen ? 'true' : 'false'}>
        <header className="editor-area-header editor-panel-flat">
          {slots.header}
        </header>
        <aside className="editor-area-rail editor-panel">
          {slots.leftRail}
        </aside>
        <main className="editor-area-preview">
          {slots.preview}
        </main>
        <aside className="editor-area-inspector editor-panel">
          {slots.inspector}
        </aside>
        <section className="editor-area-timeline editor-panel">
          {slots.timeline}
        </section>
      </div>
    </div>
  );
}
