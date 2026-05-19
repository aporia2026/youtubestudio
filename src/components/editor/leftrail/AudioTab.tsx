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
import { VoiceoverPicker } from '@/components/voiceover/VoiceoverPicker';

interface AudioTabProps {
  voiceoverUrl?: string;
  alignmentReady: boolean;
  musicUrl?: string;
  onRegenVO: () => void;
  onPickVoiceover: (url: string, source: 'auto' | 'manual' | 'clear') => void;
  linkedProjectId?: string;
  linkedScheduleItemId?: string;
  titleCandidates: Array<string | null | undefined>;
}

export function AudioTab({
  voiceoverUrl,
  alignmentReady,
  musicUrl,
  onRegenVO,
  onPickVoiceover,
  linkedProjectId,
  linkedScheduleItemId,
  titleCandidates,
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
        <VoiceoverPicker
          value={voiceoverUrl ?? ''}
          onChange={onPickVoiceover}
          scheduleItemId={linkedScheduleItemId}
          projectId={linkedProjectId}
          titleCandidates={titleCandidates}
          logNamespace="editor voiceover-rail"
        />
        <button
          type="button"
          onClick={onRegenVO}
          className="editor-btn"
          style={{ width: '100%' }}
          title="Generate a new voiceover from the current scripts via ElevenLabs"
        >
          <RefreshCw size={12} strokeWidth={2} />
          <span>Generate new voiceover</span>
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
