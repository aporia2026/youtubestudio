'use client';

/**
 * Media tab — Phase 3 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Shows the project's generated assets at a glance: how many shots
 * have a still, how many have a ready B-roll clip, whether a
 * voiceover is attached, and whether captions are present. Each
 * section links to where the user can edit / regenerate.
 *
 * This is read-only in Phase 3 — drag-from-here-to-a-shot lands in
 * a later phase. The point of the MVP is "the user can see what's
 * in the project without digging through the production-doc page."
 */

import { ImageIcon, Film, Mic2, FileAudio2, Subtitles } from 'lucide-react';

interface MediaTabProps {
  shotCount: number;
  imageCount: number;
  clipCount: number;
  hasVoiceover: boolean;
  voiceoverUrl?: string;
  hasMusic: boolean;
  musicUrl?: string;
  hasCaptions: boolean;
  captionSegmentCount: number;
}

export function MediaTab({
  shotCount,
  imageCount,
  clipCount,
  hasVoiceover,
  voiceoverUrl,
  hasMusic,
  musicUrl,
  hasCaptions,
  captionSegmentCount,
}: MediaTabProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <SectionRow
        icon={ImageIcon}
        label="Generated stills"
        primary={`${imageCount} / ${shotCount} shots`}
        secondary="Tap a tile in the timeline to regenerate or replace its still."
        complete={imageCount === shotCount && shotCount > 0}
      />
      <SectionRow
        icon={Film}
        label="B-roll animations"
        primary={`${clipCount} ready`}
        secondary={
          clipCount > 0
            ? 'Animations play in the preview. Toggle Animate Scenes in Settings to disable.'
            : 'Generate from the inspector or the production-doc page.'
        }
        complete={clipCount > 0}
      />
      <SectionRow
        icon={Mic2}
        label="Voiceover"
        primary={hasVoiceover ? 'Attached' : 'None'}
        secondary={
          hasVoiceover
            ? voiceoverUrl?.startsWith('/api/voiceovers/')
              ? 'Proxy path — alignment supported.'
              : 'External URL — alignment may be unavailable.'
            : 'Pick or generate a voiceover from the Audio tab.'
        }
        complete={hasVoiceover}
      />
      <SectionRow
        icon={FileAudio2}
        label="Music bed"
        primary={hasMusic ? 'Attached' : 'None'}
        secondary={
          hasMusic
            ? musicUrl ?? ''
            : 'Background music is optional. Add from the Audio tab when needed.'
        }
        complete={hasMusic}
      />
      <SectionRow
        icon={Subtitles}
        label="Captions"
        primary={hasCaptions ? `${captionSegmentCount} segments` : 'None'}
        secondary={
          hasCaptions
            ? 'Click a caption pill in the timeline to edit it.'
            : 'Generate from AI Tools → Generate captions.'
        }
        complete={hasCaptions}
      />
    </div>
  );
}

function SectionRow({
  icon: Icon,
  label,
  primary,
  secondary,
  complete,
}: {
  icon: typeof ImageIcon;
  label: string;
  primary: string;
  secondary: string;
  complete: boolean;
}) {
  return (
    <div
      className="rounded-md p-2.5 flex items-start gap-2.5"
      style={{ background: 'var(--editor-panel)', border: '1px solid var(--editor-edge)' }}
    >
      <div
        className="shrink-0 mt-0.5 rounded-md flex items-center justify-center"
        style={{
          width: 28,
          height: 28,
          background: complete ? 'rgba(34, 197, 94, 0.14)' : 'var(--editor-panel-hover)',
          color: complete ? '#22c55e' : 'var(--fg-muted)',
        }}
      >
        <Icon size={14} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>
          {label}
        </div>
        <div className="text-[10px] tabular-nums" style={{ color: complete ? 'var(--fg)' : 'var(--fg-muted)' }}>
          {primary}
        </div>
        <div className="text-[10px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>
          {secondary}
        </div>
      </div>
    </div>
  );
}
