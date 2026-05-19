'use client';

/**
 * Inspector → Audio tab — Phase 4 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Shown when the user clicks the audio lane in the timeline (or
 * manually switches to this tab). Surfaces voiceover URL, alignment
 * status, music URL, and a regenerate button.
 *
 * The full VoiceoverPicker port from production-doc is still
 * deferred; for now this tab is read-only with a CTA to the regen
 * modal.
 */

import { Mic2, Music2, RefreshCw } from 'lucide-react';
import { VoiceoverPicker } from '@/components/voiceover/VoiceoverPicker';

interface InspectorAudioTabProps {
  voiceoverUrl?: string;
  alignmentReady: boolean;
  musicUrl?: string;
  onRegenVO: () => void;
  /** Batch A: callback fires when the picker auto-matches or the
   *  user manually selects a voiceover. The parent dispatches an
   *  appropriate store command (PATCH_ROW-style for voiceoverUrl;
   *  pass null/empty to clear). */
  onPickVoiceover: (url: string, source: 'auto' | 'manual' | 'clear') => void;
  /** Linked `projects.id` for the picker's auto-match. */
  linkedProjectId?: string;
  /** Linked `schedule_items.id` — strongest match signal. */
  linkedScheduleItemId?: string;
  /** Title candidates the picker uses for fuzzy match (doc title,
   *  schedule item title, etc.). */
  titleCandidates: Array<string | null | undefined>;
}

export function InspectorAudioTab({
  voiceoverUrl,
  alignmentReady,
  musicUrl,
  onRegenVO,
  onPickVoiceover,
  linkedProjectId,
  linkedScheduleItemId,
  titleCandidates,
}: InspectorAudioTabProps): React.ReactElement {
  return (
    <div className="p-3 flex flex-col gap-3">
      {/* Voiceover card ────────────────────────────────────── */}
      <div
        className="rounded-md p-3 space-y-2"
        style={{ background: 'var(--editor-panel)', border: '1px solid var(--editor-edge)' }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Mic2 size={14} strokeWidth={2} style={{ color: 'var(--editor-accent)' }} />
            <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>
              Voiceover
            </span>
          </div>
          {alignmentReady && (
            <span
              className="text-[9px] px-1.5 py-0.5 rounded ed-mono"
              style={{ background: 'rgba(34,197,94,0.14)', color: '#22c55e' }}
            >
              aligned
            </span>
          )}
        </div>

        {/* Picker — same component production-doc uses. Auto-detects
            the relevant narrator stitched / full upload by
            schedule-item / project / title match. */}
        <VoiceoverPicker
          value={voiceoverUrl ?? ''}
          onChange={onPickVoiceover}
          scheduleItemId={linkedScheduleItemId}
          projectId={linkedProjectId}
          titleCandidates={titleCandidates}
          logNamespace="editor voiceover"
        />

        {voiceoverUrl && (
          <audio
            src={voiceoverUrl}
            controls
            preload="metadata"
            className="w-full"
            style={{ height: 32 }}
          />
        )}

        <button
          type="button"
          onClick={onRegenVO}
          className="editor-btn"
          style={{ width: '100%' }}
          title="Regenerate the voiceover from the current scripts via ElevenLabs"
        >
          <RefreshCw size={12} strokeWidth={2} />
          <span>Generate new voiceover</span>
        </button>
      </div>

      {/* Music card ─────────────────────────────────────────── */}
      <div
        className="rounded-md p-3"
        style={{ background: 'var(--editor-panel)', border: '1px solid var(--editor-edge)' }}
      >
        <div className="flex items-center gap-2 mb-1">
          <Music2 size={14} strokeWidth={2} style={{ color: 'var(--fg-muted)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>
            Music bed
          </span>
        </div>
        <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
          {musicUrl ?? 'No music attached. Add a music URL from the production-doc page.'}
        </div>
      </div>

      <p className="text-[10px] px-1" style={{ color: 'var(--fg-muted)' }}>
        Full voiceover picker (browse the workspace library) lands in a
        Phase 4 follow-up. For now, regenerate from this panel or pick
        on /production-doc.
      </p>
    </div>
  );
}
