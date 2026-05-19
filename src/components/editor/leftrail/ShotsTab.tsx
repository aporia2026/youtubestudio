'use client';

/**
 * Shots tab — Phase 3 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Lists every shot in the doc with its thumbnail, script preview,
 * and duration. Click jumps the selection to that shot (which the
 * inspector and timeline both observe and react to).
 *
 * Thin presentation layer — all data comes from props; no fetches,
 * no state.
 */

import type { ProductionDoc } from '@/remotion/utils';

interface ShotsTabProps {
  rows: ProductionDoc['rows'];
  rowImages: Record<number, string>;
  selection: number | null;
  onSelect: (shotIndex: number) => void;
}

export function ShotsTab({ rows, rowImages, selection, onSelect }: ShotsTabProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, i) => {
        const thumb = rowImages[i];
        const isActive = selection === i;
        return (
          <button
            key={i}
            type="button"
            onClick={() => {
              onSelect(i);
              console.info('[editor leftrail shots] select', { shotIndex: i });
            }}
            className="text-left rounded-md overflow-hidden transition-colors"
            style={{
              background: isActive ? 'var(--editor-accent-soft)' : 'var(--editor-panel)',
              border: '1px solid',
              borderColor: isActive ? 'var(--editor-accent)' : 'var(--editor-edge)',
            }}
          >
            <div className="flex items-center gap-2 p-1.5">
              <div
                className="shrink-0 rounded overflow-hidden"
                style={{ width: 56, height: 32, background: '#000' }}
              >
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center text-[9px] ed-mono"
                    style={{ color: 'var(--fg-muted)' }}
                  >
                    no img
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className="text-[10px] tabular-nums ed-mono"
                  style={{ color: isActive ? 'var(--editor-accent)' : 'var(--fg-muted)' }}
                >
                  {i + 1}. {row.timecode || '—'}
                </div>
                <div
                  className="text-[11px] truncate"
                  style={{ color: 'var(--fg)' }}
                  title={row.script_text || ''}
                >
                  {row.script_text || row.visual_description || '—'}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
