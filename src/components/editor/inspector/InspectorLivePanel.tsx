'use client';

/**
 * "Live" tab in the right inspector — live view of every shot's
 * generation status across the doc, with per-row controls.
 *
 * User report (2026-06-02): "I want a tab in the side panel that shows
 * live which shot is being generated with full control like stop and
 * regenerate."
 *
 * Aggregates the in-flight state the editor already tracks across
 * multiple slots:
 *   - rowImages[i]: image generation lifecycle
 *   - rowVideoClips[i]: Kling clip generation lifecycle
 *   - rowOverlays[i]: stock-overlay fetch lifecycle
 *   - motion_collage_panel_urls presence: motion-collage panels ready
 *   - fillProgress: bulk fill-blanks worker progress (global)
 *
 * Per-row affordances:
 *   - "→ Jump" selects the row in the editor (so the user can click
 *     Regenerate in the Shot tab without scrolling the timeline)
 *   - "↻ Retry" triggers a single-shot regenerate for failed / blank
 *     rows. Reuses the existing per-row regenerate path.
 *   - "✕ Stop" surfaces the global fill-blanks abort when a bulk run
 *     is in flight. Per-row aborts for ad-hoc fetches are deferred to
 *     a follow-up (requires controller-per-fetch refactor).
 *
 * Read-only otherwise — the panel doesn't mutate doc state itself.
 * Every action dispatches through callbacks the parent (EditorClient)
 * wires from its existing handlers.
 */

import { useMemo } from 'react';
import type { ProductionDoc, RowImageState } from '@/remotion/utils';

/** Per-row status the live tab renders. Resolved purely from the
 *  inputs the parent threads in — no async calls inside the panel. */
type RowStatus = 'done' | 'loading' | 'error' | 'blank' | 'pending-clip' | 'pending-overlay';

interface RowSnapshot {
  rowIndex: number;
  label: string;
  status: RowStatus;
  detail?: string;
  /** When set, the row has a failing state the user can retry. */
  errorMessage?: string;
}

interface InspectorLivePanelProps {
  doc: ProductionDoc;
  rowImages: (RowImageState | null)[];
  /** Per-row clip status keyed by index. Sparse. */
  clipStatuses: Record<number, string | undefined>;
  /** Per-row overlay status keyed by index. Sparse. */
  overlayStatuses: Record<number, string | undefined>;
  /** Global fill-blanks progress (the only bulk operation tracked at
   *  the editor level today). When fillState !== 'running' it shows
   *  the idle hint. */
  fillState: 'idle' | 'running';
  fillProgress: { done: number; total: number; failed: number };
  /** Stop the in-flight fill-blanks worker. The parent's controller
   *  fires AbortController.abort(); a no-op when nothing is running. */
  onStopFill: () => void;
  /** Jump the editor's selection to a shot. Same as clicking it in
   *  the left rail. */
  onJumpToShot: (shotIndex: number) => void;
  /** Retry a single-shot regenerate for a row. Parent maps this to its
   *  existing per-row regenerate path (the same one the Shot tab's ↻
   *  Regenerate button fires). */
  onRetryShot: (shotIndex: number) => void;
}

/** Resolve a row's status from the editor's lifecycle state. Highest
 *  precedence: explicit error → loading → blank/done → pending-clip /
 *  pending-overlay (lower priority because the row itself can still
 *  render with the still image). */
function resolveRowStatus(args: {
  image: RowImageState | null;
  clipStatus: string | undefined;
  overlayStatus: string | undefined;
}): { status: RowStatus; detail?: string; errorMessage?: string } {
  if (args.image?.status === 'error') {
    // RowImageState is a structural type with only status + imageUrl;
    // the error-message field rides on a wider runtime shape used by
    // production-doc's local state (see ImageStateError in
    // production-doc/page.tsx). Read defensively without widening the
    // imported type — the message is best-effort only.
    const maybeError = (args.image as unknown as { error?: string }).error;
    return {
      status: 'error',
      errorMessage: typeof maybeError === 'string' ? maybeError : 'image gen failed',
      detail: 'image',
    };
  }
  if (args.image?.status === 'loading') {
    return { status: 'loading', detail: 'image' };
  }
  if (args.clipStatus === 'generating') {
    return { status: 'loading', detail: 'clip' };
  }
  if (args.overlayStatus === 'loading') {
    return { status: 'loading', detail: 'overlay' };
  }
  if (args.clipStatus === 'failed') {
    return { status: 'error', errorMessage: 'clip gen failed', detail: 'clip' };
  }
  if (args.image?.status === 'done') {
    if (args.clipStatus === 'ready') return { status: 'done', detail: 'clip ready' };
    return { status: 'done', detail: 'still' };
  }
  return { status: 'blank' };
}

const STATUS_META: Record<RowStatus, { glyph: string; color: string; label: string }> = {
  done:               { glyph: '✓', color: '#34d399', label: 'Done' },
  loading:            { glyph: '⟳', color: '#a78bfa', label: 'Generating' },
  error:              { glyph: '✕', color: '#f87171', label: 'Failed' },
  blank:              { glyph: '◌', color: '#9ca3af', label: 'Blank' },
  'pending-clip':     { glyph: '◍', color: '#fbbf24', label: 'Clip pending' },
  'pending-overlay':  { glyph: '◍', color: '#fbbf24', label: 'Overlay pending' },
};

export function InspectorLivePanel({
  doc,
  rowImages,
  clipStatuses,
  overlayStatuses,
  fillState,
  fillProgress,
  onStopFill,
  onJumpToShot,
  onRetryShot,
}: InspectorLivePanelProps): React.ReactElement {
  const snapshots = useMemo<RowSnapshot[]>(() => {
    return doc.rows.map((row, rowIndex) => {
      const image = rowImages[rowIndex] ?? null;
      const clipStatus = clipStatuses[rowIndex];
      const overlayStatus = overlayStatuses[rowIndex];
      const resolved = resolveRowStatus({ image, clipStatus, overlayStatus });
      const labelText =
        row.on_screen_text?.trim() ||
        row.section_title?.trim() ||
        row.script_text?.trim() ||
        row.visual_description?.trim() ||
        `Shot ${rowIndex + 1}`;
      return {
        rowIndex,
        label: labelText.slice(0, 80),
        status: resolved.status,
        detail: resolved.detail,
        errorMessage: resolved.errorMessage,
      };
    });
  }, [doc.rows, rowImages, clipStatuses, overlayStatuses]);

  // Aggregate counts — at-a-glance summary header.
  const totals = useMemo(() => {
    const counts = { done: 0, loading: 0, error: 0, blank: 0 };
    for (const s of snapshots) {
      if (s.status === 'done') counts.done += 1;
      else if (s.status === 'loading') counts.loading += 1;
      else if (s.status === 'error') counts.error += 1;
      else counts.blank += 1;
    }
    return counts;
  }, [snapshots]);

  // Show rows currently doing something at the top; errors next;
  // blanks after; done last. Within each group preserve doc order.
  const sortedSnapshots = useMemo(() => {
    const priority: Record<RowStatus, number> = {
      loading: 0,
      error: 1,
      blank: 2,
      'pending-clip': 3,
      'pending-overlay': 3,
      done: 4,
    };
    return [...snapshots].sort((a, b) => {
      const pa = priority[a.status];
      const pb = priority[b.status];
      if (pa !== pb) return pa - pb;
      return a.rowIndex - b.rowIndex;
    });
  }, [snapshots]);

  return (
    <div className="p-4 space-y-3" style={{ fontSize: 12 }}>
      {/* Bulk fill-blanks status — surfaces the global worker the
          existing bottom-bar already shows, but co-located here with a
          single Stop control. */}
      <div
        style={{
          padding: 10,
          borderRadius: 6,
          background: fillState === 'running'
            ? 'rgba(124,58,237,0.10)'
            : 'rgba(255,255,255,0.03)',
          border: `1px solid ${
            fillState === 'running' ? 'rgba(124,58,237,0.40)' : 'var(--card-border)'
          }`,
        }}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>
            Bulk fill-blanks
          </span>
          <span className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
            {fillState === 'running' ? 'Running' : 'Idle'}
          </span>
        </div>
        {fillState === 'running' ? (
          <>
            <div
              className="text-[11px] tabular-nums"
              style={{ color: 'var(--fg)' }}
            >
              {fillProgress.done} / {fillProgress.total} done
              {fillProgress.failed > 0 && (
                <span style={{ color: '#f87171', marginLeft: 6 }}>
                  · {fillProgress.failed} failed
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onStopFill}
              className="text-[10px] px-2 py-0.5 rounded mt-1.5"
              style={{
                background: 'rgba(239,68,68,0.12)',
                color: '#f87171',
                border: '1px solid rgba(239,68,68,0.40)',
                cursor: 'pointer',
              }}
              title="Abort the in-flight bulk worker. Already-completed shots are kept."
            >
              ✕ Stop bulk
            </button>
          </>
        ) : (
          <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
            No bulk operation in flight. Use the Settings tab&apos;s &quot;Fill blank shots&quot; or
            inspector kebab actions to start one.
          </div>
        )}
      </div>

      {/* Aggregate counts */}
      <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--fg-muted)' }}>
        <span><span style={{ color: '#34d399' }}>✓</span> {totals.done}</span>
        <span><span style={{ color: '#a78bfa' }}>⟳</span> {totals.loading}</span>
        <span><span style={{ color: '#f87171' }}>✕</span> {totals.error}</span>
        <span><span style={{ color: '#9ca3af' }}>◌</span> {totals.blank}</span>
        <span style={{ marginLeft: 'auto' }}>{doc.rows.length} shots</span>
      </div>

      {/* Per-row list */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          maxHeight: 'calc(100vh - 360px)',
          overflowY: 'auto',
        }}
      >
        {sortedSnapshots.map((s) => {
          const meta = STATUS_META[s.status];
          return (
            <div
              key={s.rowIndex}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 8px',
                borderRadius: 4,
                background: s.status === 'loading'
                  ? 'rgba(124,58,237,0.08)'
                  : s.status === 'error'
                  ? 'rgba(239,68,68,0.06)'
                  : 'rgba(255,255,255,0.02)',
                border: '1px solid var(--card-border)',
                fontSize: 11,
                lineHeight: 1.3,
              }}
            >
              <span
                style={{ width: 14, color: meta.color, fontWeight: 700, textAlign: 'center' }}
                aria-label={meta.label}
                title={meta.label + (s.detail ? ` · ${s.detail}` : '')}
              >
                {meta.glyph}
              </span>
              <span
                style={{
                  width: 28,
                  color: 'var(--fg-muted)',
                  fontFamily: 'ui-monospace, monospace',
                  tabSize: 1,
                }}
              >
                #{s.rowIndex + 1}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  color: 'var(--fg)',
                }}
                title={s.errorMessage ? `${s.label} — ${s.errorMessage}` : s.label}
              >
                {s.label}
              </span>
              <button
                type="button"
                onClick={() => {
                  console.info('[editor live-tab] jump-to-shot', { shotIndex: s.rowIndex });
                  onJumpToShot(s.rowIndex);
                }}
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  background: 'transparent',
                  color: 'var(--fg-muted)',
                  border: '1px solid var(--card-border)',
                  cursor: 'pointer',
                }}
                title="Jump to this shot in the editor"
              >
                →
              </button>
              {(s.status === 'error' || s.status === 'blank') && (
                <button
                  type="button"
                  onClick={() => {
                    console.info('[editor live-tab] retry-shot', { shotIndex: s.rowIndex });
                    onRetryShot(s.rowIndex);
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'rgba(124,58,237,0.15)',
                    color: '#a78bfa',
                    border: '1px solid rgba(124,58,237,0.40)',
                    cursor: 'pointer',
                  }}
                  title={s.status === 'error' ? `Retry — ${s.errorMessage ?? 'unknown error'}` : 'Generate this shot'}
                >
                  ↻
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
