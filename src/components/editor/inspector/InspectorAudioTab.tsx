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

import { Mic2, Music2, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { VoiceoverPicker } from '@/components/voiceover/VoiceoverPicker';
import { AlignmentBadge } from '@/components/editor/AlignmentBadge';
import { deriveAlignmentStatus } from '@/lib/editor/alignment-status';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';
import {
  VOICEOVER_FADE_MS_MAX,
  VOICEOVER_VOLUME_DB_MAX,
  VOICEOVER_VOLUME_DB_MIN,
} from '@/remotion/utils';

interface InspectorAudioTabProps {
  voiceoverUrl?: string;
  /** Full alignment response when present — drives the status badge.
   *  Falsy means no alignment data is persisted for this VO. */
  voiceoverAlignment?: ForcedAlignmentResponse;
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
  /** Doc-level voiceover gain / fade knobs (Phase 1 of the timeline-
   *  and-shots overhaul plan). Defaults preserve current behavior so
   *  legacy docs render identically to before. */
  voiceoverMuted: boolean;
  voiceoverVolumeDb: number;
  voiceoverFadeInMs: number;
  voiceoverFadeOutMs: number;
  /** Patches one or more of the four knobs above onto the doc. The
   *  parent dispatches a PATCH_DOC command so undo / redo work. */
  onPatchAudio: (patch: {
    voiceover_muted?: boolean;
    voiceover_volume_db?: number;
    voiceover_fade_in_ms?: number;
    voiceover_fade_out_ms?: number;
  }) => void;
}

export function InspectorAudioTab({
  voiceoverUrl,
  voiceoverAlignment,
  musicUrl,
  onRegenVO,
  onPickVoiceover,
  linkedProjectId,
  linkedScheduleItemId,
  titleCandidates,
  voiceoverMuted,
  voiceoverVolumeDb,
  voiceoverFadeInMs,
  voiceoverFadeOutMs,
  onPatchAudio,
}: InspectorAudioTabProps): React.ReactElement {
  const alignment = deriveAlignmentStatus({ voiceoverUrl, voiceoverAlignment });
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
        </div>
        {/* Full-width alignment badge — replaces the tiny "aligned"
            chip. Mirrors the prod-doc AlignmentPill so the user gets
            the same "Synced to voiceover" confirmation surface here. */}
        <AlignmentBadge status={alignment.status} detail={alignment.detail} />

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

      {/* Mix card — Phase 1 of
          `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
          Doc-level voiceover gain knobs. All four fields default to
          values that preserve the historical render (mute off, unity
          gain, no fades) so legacy docs are unaffected unless the
          user explicitly changes one. */}
      <div
        className="rounded-md p-3 space-y-3"
        style={{ background: 'var(--editor-panel)', border: '1px solid var(--editor-edge)' }}
      >
        <div className="flex items-center gap-2">
          {voiceoverMuted ? (
            <VolumeX size={14} strokeWidth={2} style={{ color: 'var(--fg-muted)' }} />
          ) : (
            <Volume2 size={14} strokeWidth={2} style={{ color: 'var(--editor-accent)' }} />
          )}
          <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>
            Mix
          </span>
        </div>

        {/* Mute toggle ─ silences the VO without removing it; the
            `<Audio>` element still mounts so timeline + buffering
            stay identical between mute on/off. */}
        <button
          type="button"
          className="editor-btn w-full justify-between"
          onClick={() => {
            const next = !voiceoverMuted;
            console.info('[editor audio-mix] mute', { next });
            onPatchAudio({ voiceover_muted: next });
          }}
          title={voiceoverMuted ? 'Unmute the voiceover' : 'Mute the voiceover'}
        >
          <span>Mute voiceover</span>
          <span
            style={{
              color: voiceoverMuted ? 'var(--editor-accent)' : 'var(--fg-muted)',
            }}
          >
            {voiceoverMuted ? 'On' : 'Off'}
          </span>
        </button>

        {/* Volume slider — dB scale. Range -60..+12, step 1. The
            current value is shown to the right of the label so a
            change is visible without dragging. Reset-to-zero on
            double-click for a one-action "back to unity". */}
        <label className="block space-y-1">
          <div
            className="flex items-center justify-between text-[10px]"
            style={{ color: 'var(--fg-muted)' }}
          >
            <span>Volume</span>
            <span className="tabular-nums ed-mono" style={{ color: 'var(--fg)' }}>
              {voiceoverVolumeDb > 0 ? '+' : ''}
              {voiceoverVolumeDb} dB
            </span>
          </div>
          <input
            type="range"
            min={VOICEOVER_VOLUME_DB_MIN}
            max={VOICEOVER_VOLUME_DB_MAX}
            step={1}
            value={voiceoverVolumeDb}
            onChange={(e) => {
              const next = Number(e.target.value);
              onPatchAudio({ voiceover_volume_db: next });
            }}
            onDoubleClick={() => {
              console.info('[editor audio-mix] volume-reset', { prev: voiceoverVolumeDb });
              onPatchAudio({ voiceover_volume_db: 0 });
            }}
            className="w-full"
            aria-label="Voiceover volume in decibels"
            disabled={voiceoverMuted}
            title={
              voiceoverMuted
                ? 'Unmute to adjust volume'
                : 'Drag to set voiceover volume in dB (double-click to reset to 0)'
            }
          />
        </label>

        {/* Fade in / Fade out — ms inputs paired with a slider each.
            Capped at VOICEOVER_FADE_MS_MAX (10 s) by the clamp in
            `productionDocToVideoConfig`. */}
        <div className="grid grid-cols-2 gap-2">
          <FadeControl
            label="Fade in"
            valueMs={voiceoverFadeInMs}
            onChange={(ms) => onPatchAudio({ voiceover_fade_in_ms: ms })}
            disabled={voiceoverMuted}
          />
          <FadeControl
            label="Fade out"
            valueMs={voiceoverFadeOutMs}
            onChange={(ms) => onPatchAudio({ voiceover_fade_out_ms: ms })}
            disabled={voiceoverMuted}
          />
        </div>
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

/** Compact fade duration control — slider + numeric (ms) input wired
 *  to the same value. Drag for fast adjust, type for precision. Per
 *  the Phase 1 plan §12 ("set duration UI = both"). */
function FadeControl({
  label,
  valueMs,
  onChange,
  disabled,
}: {
  label: string;
  valueMs: number;
  onChange: (ms: number) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <div
        className="flex items-center justify-between text-[10px]"
        style={{ color: 'var(--fg-muted)' }}
      >
        <span>{label}</span>
        <span className="tabular-nums ed-mono" style={{ color: 'var(--fg)' }}>
          {valueMs} ms
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={VOICEOVER_FADE_MS_MAX}
        step={50}
        value={valueMs}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        aria-label={`${label} duration in milliseconds`}
        disabled={disabled}
      />
      <input
        type="number"
        min={0}
        max={VOICEOVER_FADE_MS_MAX}
        step={50}
        value={valueMs}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(0, Math.min(VOICEOVER_FADE_MS_MAX, n)));
        }}
        className="editor-input w-full text-[11px]"
        aria-label={`${label} duration in milliseconds (numeric input)`}
        disabled={disabled}
      />
    </div>
  );
}
