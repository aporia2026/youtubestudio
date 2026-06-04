'use client';

/**
 * Lightbox modal for Shorts frame assets. Opens centered with a dimmed
 * backdrop; closes on ESC, on backdrop click, or via the × button.
 *
 * Renders the still image; when an i2v animation is available the
 * <video> takes precedence and autoplays muted. Collage panel grids
 * are shown via the parent's composed image — per-panel preview can
 * land later if needed.
 *
 * Plan: `_plans/2026-06-04-shorts-editor-redesign-split-tabs.md`
 * (extension after the first ship — user wanted clickable assets +
 * jump-to-frame controls).
 */

import { useEffect } from 'react';

export interface AssetPreviewModalProps {
  /** Headline shown above the preview, e.g. "Variant 3 · 0:13". */
  title: string;
  /** Still image URL. Always present. */
  imageUrl: string;
  /** Optional animation mp4 URL. When set, the video takes priority. */
  animationUrl?: string;
  /** Optional alt text for accessibility. Falls back to the title. */
  alt?: string;
  /** Fired when the user dismisses the modal. */
  onClose: () => void;
}

export function AssetPreviewModal({
  title,
  imageUrl,
  animationUrl,
  alt,
  onClose,
}: AssetPreviewModalProps) {
  // ESC closes. We attach to window so the listener fires even when
  // focus is on the embedded video element rather than the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.78)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <div
        // Stop propagation so clicking the image / chrome doesn't close.
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          maxWidth: '90vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          alignItems: 'center',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
            color: '#fff',
            fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 600, flex: 1 }}>{title}</span>
          <a
            href={animationUrl ?? imageUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 12,
              color: 'rgba(255,255,255,0.7)',
              textDecoration: 'underline',
            }}
          >
            Open raw
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              fontSize: 16,
              lineHeight: 1,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </header>

        <div
          style={{
            maxWidth: '90vw',
            maxHeight: 'calc(90vh - 60px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#000',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {animationUrl ? (
            <video
              src={animationUrl}
              poster={imageUrl}
              controls
              autoPlay
              muted
              loop
              playsInline
              style={{
                maxWidth: '90vw',
                maxHeight: 'calc(90vh - 60px)',
                display: 'block',
              }}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={alt ?? title}
              style={{
                maxWidth: '90vw',
                maxHeight: 'calc(90vh - 60px)',
                display: 'block',
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
