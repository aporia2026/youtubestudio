'use client';

/**
 * Captions tab — Phase 3 MVP of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Summary view of the project's captions: bundle status, segment
 * count, model used, generated-at timestamp, and a regenerate
 * button. Inline per-segment editing lands in Phase 5's captions
 * lane (the timeline track).
 */

import { Subtitles as SubtitlesIcon, RefreshCw } from 'lucide-react';
import type { CaptionsBundle } from '@/lib/editor/captions';

interface CaptionsTabProps {
  captions: CaptionsBundle | undefined;
  onRegen: () => void;
  regenDisabled: boolean;
  regenLabel: string;
}

export function CaptionsTab({ captions, onRegen, regenDisabled, regenLabel }: CaptionsTabProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="rounded-md p-2.5"
        style={{ background: 'var(--editor-panel)', border: '1px solid var(--editor-edge)' }}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <SubtitlesIcon size={14} strokeWidth={2} style={{ color: 'var(--editor-accent)' }} />
          <span className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>
            Captions
          </span>
        </div>

        {captions ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
            <dt style={{ color: 'var(--fg-muted)' }}>Segments</dt>
            <dd className="tabular-nums" style={{ color: 'var(--fg)' }}>
              {captions.segments.length}
            </dd>
            <dt style={{ color: 'var(--fg-muted)' }}>Model</dt>
            <dd className="ed-mono" style={{ color: 'var(--fg)' }}>
              {captions.modelId}
            </dd>
            <dt style={{ color: 'var(--fg-muted)' }}>Generated</dt>
            <dd className="ed-mono" style={{ color: 'var(--fg)' }}>
              {new Date(captions.generatedAt).toLocaleString()}
            </dd>
          </dl>
        ) : (
          <p className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
            No captions yet. Generate from the voiceover via gpt-4o-mini-transcribe
            (~$0.003 / min).
          </p>
        )}

        <button
          type="button"
          onClick={onRegen}
          disabled={regenDisabled}
          className="editor-btn mt-2.5"
          style={{ width: '100%' }}
          title={
            regenDisabled
              ? 'Assign a voiceover first'
              : 'Transcribe the voiceover into caption segments'
          }
        >
          <RefreshCw size={12} strokeWidth={2} />
          <span>{regenLabel}</span>
        </button>
      </div>

      {captions && captions.segments.length > 0 && (
        <p className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
          Double-click a caption pill in the timeline to edit its text inline
          (Phase 5).
        </p>
      )}
    </div>
  );
}
