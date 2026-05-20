'use client';

/**
 * BrandKitModal — wraps production-doc's `VisualBrandKitOverridePanel`
 * in a centered modal so the editor can expose per-doc brand-kit
 * overrides (fonts / colors / logo / channel name) without rebuilding
 * the panel.
 *
 * 2026-05-20 brand-kit panel port. The underlying panel takes
 * `channelKit + override + onChange` so the page can show channel
 * defaults as placeholders and the user's override on top. Channel
 * id is required for logo uploads (the presigned URL is scoped to
 * `/api/channels/[id]/logo`) — when null, the panel hides the logo
 * dropzone with a "pin a channel first" hint.
 */

import { X } from 'lucide-react';
import type { ChannelVisualBrandKit } from '@/lib/channel-visual-brand-kit';
import { VisualBrandKitOverridePanel } from '@/components/production-doc/VisualBrandKitOverridePanel';

interface BrandKitModalProps {
  channelId: string | null;
  channelKit: ChannelVisualBrandKit | null;
  override: ChannelVisualBrandKit;
  onChange: (next: ChannelVisualBrandKit) => void;
  onClose: () => void;
}

export function BrandKitModal({
  channelId,
  channelKit,
  override,
  onChange,
  onClose,
}: BrandKitModalProps): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="editor-panel max-w-2xl w-full max-h-[90vh] overflow-auto"
        style={{
          background: 'var(--editor-panel)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="brand-kit-modal-title"
      >
        <div
          className="flex items-center justify-between px-4 py-3 sticky top-0"
          style={{
            borderBottom: '1px solid var(--editor-edge)',
            background: 'var(--editor-panel)',
            zIndex: 1,
          }}
        >
          <div>
            <div
              id="brand-kit-modal-title"
              className="text-sm font-semibold"
              style={{ color: 'var(--fg)' }}
            >
              Visual brand kit
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>
              Per-doc override of the channel's fonts, colors, and logo. Channel
              defaults show as placeholders; leave a field blank to inherit.
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
          <VisualBrandKitOverridePanel
            channelId={channelId}
            channelKit={channelKit}
            override={override}
            onChange={onChange}
          />
        </div>
      </div>
    </div>
  );
}
