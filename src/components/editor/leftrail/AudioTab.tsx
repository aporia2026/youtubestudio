'use client';

/**
 * Audio tab — Phase 3 MVP of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Surfaces voiceover + music status with quick-action buttons.
 * Full VoiceoverPicker port from production-doc lands in a Phase 4
 * follow-up — that picker has its own state machinery (library
 * fetch, schedule-item matching, etc.) that's safer to migrate
 * incrementally.
 */

import { Mic, Music2, RefreshCw } from 'lucide-react';

interface AudioTabProps {
  voiceoverUrl?: string;
  alignmentReady: boolean;
  musicUrl?: string;
  onRegenVO: () => void;
}

export function AudioTab({
  voiceoverUrl,
  alignmentReady,
  musicUrl,
  onRegenVO,
}: AudioTabProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="rounded-md p-2.5 space-y-2"
        style={{ background: 'var(--editor-panel)', border: '1px solid var(--editor-edge)' }}
      >
        <div className="flex items-center gap-2">
          <Mic size={14} strokeWidth={2} style={{ color: 'var(--editor-accent)' }} />
          <span className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>
            Voiceover
          </span>
          {alignmentReady && (
            <span
              className="text-[9px] px-1.5 py-0.5 rounded ed-mono"
              style={{ background: 'rgba(34,197,94,0.14)', color: '#22c55e' }}
            >
              aligned
            </span>
          )}
        </div>
        <div className="text-[10px] truncate" style={{ color: 'var(--fg-muted)' }} title={voiceoverUrl}>
          {voiceoverUrl ?? 'No voiceover attached'}
        </div>
        <button
          type="button"
          onClick={onRegenVO}
          className="editor-btn"
          style={{ width: '100%' }}
          title="Regenerate the voiceover from the current scripts"
        >
          <RefreshCw size={12} strokeWidth={2} />
          <span>Regenerate voiceover</span>
        </button>
      </div>

      <div
        className="rounded-md p-2.5"
        style={{ background: 'var(--editor-panel)', border: '1px solid var(--editor-edge)' }}
      >
        <div className="flex items-center gap-2 mb-1">
          <Music2 size={14} strokeWidth={2} style={{ color: 'var(--fg-muted)' }} />
          <span className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>
            Music bed
          </span>
        </div>
        <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
          {musicUrl ?? 'No music attached. Add a music URL from the production-doc page.'}
        </div>
      </div>
    </div>
  );
}
