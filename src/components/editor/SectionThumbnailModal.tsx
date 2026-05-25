'use client';

/**
 * Section thumbnail modal for the editor — Batch B of
 * `_plans/2026-05-20-editor-prod-doc-parity-batches.md`.
 *
 * Mounts the same `SectionThumbnailCard` production-doc uses inside
 * a modal dialog so the editor can upload / replace the composite
 * section-divider thumbnail and draw labeled regions on it without
 * leaving the editor.
 *
 * Region marking + per-shot "zoom to region" wiring happens in the
 * inspector via the existing `thumbnailZoomTo` field on rows.
 */

import { X } from 'lucide-react';
import type { VideoThumbnail } from '@/remotion/types';
import { SectionThumbnailCard } from '@/components/production-doc/SectionThumbnailCard';

interface SectionThumbnailModalProps {
  value: VideoThumbnail | undefined;
  onChange: (next: VideoThumbnail | undefined) => void;
  onClose: () => void;
}

export function SectionThumbnailModal({
  value,
  onChange,
  onClose,
}: SectionThumbnailModalProps): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="editor-panel max-w-3xl w-full max-h-[90vh] overflow-auto"
        style={{ background: 'var(--editor-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--editor-edge)' }}
        >
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
              Section thumbnail
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>
              Composite image the renderer can zoom into for section transitions.
              Draw labeled regions and assign them to shots in the inspector.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="editor-icon-btn"
            aria-label="Close"
            title="Close"
            style={{ width: 28, height: 28 }}
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="p-4">
          <SectionThumbnailCard value={value} onChange={onChange} embedded />
        </div>
      </div>
    </div>
  );
}
