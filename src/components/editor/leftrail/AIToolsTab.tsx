'use client';

/**
 * AI Tools tab — Phase 3 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Hosts the global AI affordances that used to clutter the top
 * toolbar: drift report, doc-level text overlays, regen captions,
 * regen VO, regen doc. Each tool is a button with an icon,
 * label, and short subtitle so the user knows what they do
 * before clicking.
 *
 * Stateless — every action and disabled-state flag comes from
 * props.
 */

import {
  Activity,
  FileText,
  ImageIcon,
  Layers,
  Mic,
  Sparkles,
  Subtitles as SubtitlesIcon,
  type LucideIcon,
} from 'lucide-react';

interface AIToolsTabProps {
  onDriftReport: () => void;
  onOverlays: () => void;
  overlayCount: number;
  onRegenCaptions: () => void;
  regenCaptionsDisabled: boolean;
  regenCaptionsLabel: string;
  onRegenVO: () => void;
  onRegenDoc: () => void;
  // ─── Batch B: section thumbnail ─────────────────────────────────
  onOpenSectionThumbnail: () => void;
  sectionThumbnailRegionCount: number;
  hasSectionThumbnail: boolean;
}

export function AIToolsTab({
  onDriftReport,
  onOverlays,
  overlayCount,
  onRegenCaptions,
  regenCaptionsDisabled,
  regenCaptionsLabel,
  onRegenVO,
  onRegenDoc,
  onOpenSectionThumbnail,
  sectionThumbnailRegionCount,
  hasSectionThumbnail,
}: AIToolsTabProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <ToolRow
        icon={Activity}
        label="Drift report"
        subtitle="Narration vs shot durations"
        onClick={onDriftReport}
      />
      <ToolRow
        icon={ImageIcon}
        label="Section thumbnail"
        subtitle={
          !hasSectionThumbnail
            ? 'Upload a composite thumbnail for section transitions'
            : sectionThumbnailRegionCount === 0
              ? 'Uploaded — draw regions to enable per-shot zoom'
              : `${sectionThumbnailRegionCount} region${sectionThumbnailRegionCount === 1 ? '' : 's'} drawn`
        }
        onClick={onOpenSectionThumbnail}
      />
      <ToolRow
        icon={Layers}
        label="Text overlays"
        subtitle={
          overlayCount > 0
            ? `${overlayCount} overlay${overlayCount === 1 ? '' : 's'} on the doc`
            : 'Add a doc-level text overlay'
        }
        onClick={onOverlays}
      />
      <ToolRow
        icon={SubtitlesIcon}
        label={regenCaptionsLabel}
        subtitle="Transcribe via gpt-4o-mini-transcribe"
        onClick={onRegenCaptions}
        disabled={regenCaptionsDisabled}
      />
      <ToolRow
        icon={Mic}
        label="Regenerate voiceover"
        subtitle="ElevenLabs from the current scripts"
        onClick={onRegenVO}
      />
      <ToolRow
        icon={FileText}
        label="Regenerate from script"
        subtitle="Edit the script, rebuild the doc"
        onClick={onRegenDoc}
      />
    </div>
  );
}

function ToolRow({
  icon: Icon,
  label,
  subtitle,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  subtitle: string;
  onClick: () => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-left rounded-md transition-colors flex items-start gap-2.5 p-2"
      style={{
        background: 'var(--editor-panel)',
        border: '1px solid var(--editor-edge)',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <div
        className="shrink-0 mt-0.5"
        style={{ color: disabled ? 'var(--fg-muted)' : 'var(--editor-accent)' }}
      >
        <Icon size={14} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>
          {label}
        </div>
        <div className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
          {subtitle}
        </div>
      </div>
      <Sparkles
        size={11}
        strokeWidth={2}
        style={{ color: 'var(--fg-muted)', opacity: 0.4, flexShrink: 0, marginTop: 4 }}
      />
    </button>
  );
}
