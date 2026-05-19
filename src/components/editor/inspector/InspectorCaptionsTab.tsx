'use client';

/**
 * Inspector → Captions tab — Phase 4 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Shown when the user clicks a caption pill in the timeline. For
 * Phase 4, surfaces the captions bundle summary + jump-to-segment
 * affordances. Inline per-segment editing lands with Phase 5's
 * captions lane (double-click pill → editable text).
 */

import { Subtitles, RefreshCw } from 'lucide-react';
import type { CaptionsBundle } from '@/lib/editor/captions';

interface InspectorCaptionsTabProps {
  captions: CaptionsBundle | undefined;
  playheadMs: number;
  onSeek: (ms: number) => void;
  onRegen: () => void;
  regenDisabled: boolean;
  regenLabel: string;
}

export function InspectorCaptionsTab({
  captions,
  playheadMs,
  onSeek,
  onRegen,
  regenDisabled,
  regenLabel,
}: InspectorCaptionsTabProps): React.ReactElement {
  if (!captions || captions.segments.length === 0) {
    return (
      <div className="p-3">
        <div
          className="rounded-md p-3 text-center space-y-3"
          style={{ background: 'var(--editor-panel)', border: '1px solid var(--editor-edge)' }}
        >
          <Subtitles size={20} strokeWidth={1.5} style={{ color: 'var(--fg-muted)', margin: '0 auto' }} />
          <div className="text-xs" style={{ color: 'var(--fg)' }}>
            No captions yet
          </div>
          <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
            Transcribe the voiceover via gpt-4o-mini-transcribe
            (~$0.003 / min) to add a caption track.
          </div>
          <button
            type="button"
            onClick={onRegen}
            disabled={regenDisabled}
            className="editor-btn editor-btn-primary"
          >
            <RefreshCw size={12} strokeWidth={2} />
            <span>{regenLabel}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Subtitles size={14} strokeWidth={2} style={{ color: 'var(--editor-accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>
            Captions
          </span>
          <span className="text-[10px] ed-mono tabular-nums" style={{ color: 'var(--fg-muted)' }}>
            {captions.segments.length} segments
          </span>
        </div>
        <button
          type="button"
          onClick={onRegen}
          disabled={regenDisabled}
          className="editor-icon-btn"
          title="Regenerate"
        >
          <RefreshCw size={12} strokeWidth={2} />
        </button>
      </div>

      <div className="flex flex-col gap-1" style={{ minHeight: 0 }}>
        {captions.segments.map((seg, i) => {
          const active = playheadMs >= seg.start * 1000 && playheadMs < seg.end * 1000;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSeek(Math.round(seg.start * 1000))}
              className="text-left rounded-md p-2 transition-colors"
              style={{
                background: active ? 'var(--editor-accent-soft)' : 'var(--editor-panel)',
                border: '1px solid',
                borderColor: active ? 'var(--editor-accent)' : 'var(--editor-edge)',
              }}
            >
              <div className="text-[10px] ed-mono tabular-nums" style={{ color: active ? 'var(--editor-accent)' : 'var(--fg-muted)' }}>
                {fmtSec(seg.start)} → {fmtSec(seg.end)}
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--fg)' }}>
                {seg.text}
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-[10px] mt-2 px-1" style={{ color: 'var(--fg-muted)' }}>
        Inline caption editing in the timeline lane lands in Phase 5
        (double-click a pill).
      </p>
    </div>
  );
}

function fmtSec(s: number): string {
  const total = Math.floor(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
