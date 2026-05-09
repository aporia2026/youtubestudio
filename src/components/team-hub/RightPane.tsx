'use client';

import { AnimatePresence, motion } from 'framer-motion';
import type { SurfaceDescriptor } from '@/lib/team-hub-types';

/**
 * Right pane of /team-hub. Slides in from the right when a surface is
 * active (e.g. user clicked "Open take comments" on a task row); slides
 * out when `surface` is null.
 *
 * Heavy embedded surfaces (TakeReview, ReviewPage, EditorTab, script
 * editor iframe) get mounted inside `children`. The orchestrator decides
 * what to render based on `surface.kind`.
 *
 * Width: 60% of the parent on viewports ≥ 1366px, 80% on smaller. The
 * left rail + a slice of the middle pane stay visible behind it so the
 * user never loses their place in the roster.
 *
 * Animation: full Framer Motion (per the plan's "no reduced-motion
 * fallback" decision).
 */

interface RightPaneProps {
  surface: SurfaceDescriptor | null;
  onClose: () => void;
  children?: React.ReactNode;
}

export function RightPane({ surface, onClose, children }: RightPaneProps) {
  return (
    <AnimatePresence>
      {surface && (
        <>
          {/* Backdrop. Click-to-close, low opacity so the middle pane
              still bleeds through visually — we want the owner to feel
              the rail is present, not modal-locked. */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="absolute inset-0 z-10"
            style={{ background: 'rgba(0,0,0,0.35)' }}
          />
          <motion.aside
            key="pane"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="absolute top-0 right-0 bottom-0 z-20 flex flex-col shadow-2xl"
            style={{
              width: 'min(80%, 1080px)',
              background: 'var(--bg-primary)',
              borderLeft: '1px solid var(--border)',
            }}
          >
            <header
              className="flex items-center justify-between px-4 py-3 border-b shrink-0"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded"
                  style={{ background: 'rgba(124,58,237,0.18)', color: '#a78bfa' }}
                >
                  {surfaceLabel(surface.kind)}
                </span>
                <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                  {surface.id}
                </span>
              </div>
              <button
                onClick={onClose}
                className="p-1 rounded-md hover:bg-white/5 transition-colors"
                aria-label="Close panel"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </header>
            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function surfaceLabel(kind: SurfaceDescriptor['kind']): string {
  switch (kind) {
    case 'script':
      return 'Script';
    case 'takes':
      return 'Take comments';
    case 'review':
      return 'Review session';
    case 'editor-tab':
      return 'Editor workspace';
  }
}
