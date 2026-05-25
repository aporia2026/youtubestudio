'use client';

import React from 'react';
import type { RowImageStateView, RowVideoClipView } from './types';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';

/** Optional variant-group context for the card. Drives a left-border
 *  accent + a small chip in the top-left telling the user this card
 *  is either the BASE of a group (`kind: 'base'`) or one of the
 *  N variants (`kind: 'variant'`). Undefined ⇒ standalone row, no
 *  variant decoration. Phase 3.7d. */
export interface SectionCardVariantInfo {
  kind: 'base' | 'variant';
  /** 0 when `kind === 'base'`, otherwise the row's `variant_index`. */
  variantIndex: number;
  /** Total rows in this group, INCLUDING the base. So a 1-base + 2-variant
   *  group has `total === 3`. */
  total: number;
}

interface SectionCardProps {
  index: number;
  title: string;
  isActive: boolean;
  image: RowImageStateView | undefined;
  clip: RowVideoClipView | null | undefined;
  overlay: RowOverlayState | undefined;
  lockedAsStill: boolean;
  onClick: () => void;
  /** Phase 3.7d — when this row belongs to a variant group, surface
   *  that visually so the editor view stays consistent with the main
   *  grid view's left-border + chip convention. */
  variantInfo?: SectionCardVariantInfo;
}

/**
 * Single card in the editor's bottom section strip. Shows the section's
 * still thumbnail, a 1-indexed section number, status dots for the
 * media states, and the section's title text below. Click to set as
 * active section.
 *
 * Status dots (right side of the card):
 *  - 🎬 broll clip ready (green) / generating (yellow) / missing (gray)
 *  - 🖼 overlay ready (green) / loading (yellow) / missing (gray) / error (red)
 *  - 🔒 broll is locked as still (only when set)
 *  - ⚠ image is in an error state (only when set)
 *
 * The card is keyboard-focusable (it's a `<button>`) so screen readers
 * and tab-navigation work without extra ARIA wiring.
 */
export const SectionCard: React.FC<SectionCardProps> = ({
  index,
  title,
  isActive,
  image,
  clip,
  overlay,
  lockedAsStill,
  onClick,
  variantInfo,
}) => {
  const hasError = image?.status === 'error';
  const sourceBadge = image?.source === 'upload'
    ? '📷'
    : image?.source === 'edit'
    ? '✎'
    : image?.source === 'url'
    ? '🔗'
    : null;

  const clipState: 'ready' | 'busy' | 'missing' =
    clip?.videoUrl && clip.status === 'done'
      ? 'ready'
      : clip?.status === 'generating' || clip?.status === 'pending'
      ? 'busy'
      : 'missing';

  const overlayState: 'ready' | 'busy' | 'missing' | 'error' =
    overlay?.status === 'done'
      ? 'ready'
      : overlay?.status === 'loading'
      ? 'busy'
      : overlay?.status === 'error'
      ? 'error'
      : 'missing'; // 'idle' and 'skipped' both render as missing in v1

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative shrink-0 rounded-lg overflow-hidden text-left transition-all"
      style={{
        width: 152,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid',
        borderColor: isActive ? '#f87171' : 'var(--border)',
        outline: isActive ? '2px solid rgba(248,113,113,0.35)' : 'none',
        outlineOffset: 0,
        boxShadow: isActive
          ? '0 0 0 4px rgba(248,113,113,0.15), 0 4px 12px rgba(0,0,0,0.4)'
          : 'none',
        transform: isActive ? 'translateY(-2px)' : 'translateY(0)',
        // Phase 3.7d — cyan left-border accent for variant-group rows.
        // Brighter for the base (the anchor of the group), softer for
        // variants. Mirrors the main grid view's row accent so the
        // grouping is visually consistent across surfaces.
        ...(variantInfo ? {
          borderLeft: variantInfo.kind === 'variant'
            ? '3px solid rgba(34,211,238,0.45)'
            : '3px solid rgba(34,211,238,0.85)',
        } : {}),
      }}
      aria-current={isActive ? 'true' : undefined}
      aria-label={`Section ${index + 1}: ${title || 'Untitled'}`}
    >
      <div className="relative w-full" style={{ aspectRatio: '16 / 9', background: '#0a0a0a' }}>
        {image?.imageUrl && image.status === 'done' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.imageUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center text-xs"
            style={{
              background:
                'linear-gradient(135deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.05) 100%)',
              color: 'var(--text-muted)',
            }}
          >
            {image?.status === 'loading' || image?.status === 'pending' ? '…' : '—'}
          </div>
        )}

        <div
          className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums"
          style={{
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            fontFeatureSettings: '"tnum"',
          }}
        >
          {index + 1}
        </div>

        {/* Phase 3.7d — variant chip next to the section number. Only
            visible when this row is part of a variant group. */}
        {variantInfo && (
          <div
            className="absolute top-1 left-9 px-1.5 py-0.5 rounded text-[9px] font-semibold"
            style={{
              background: variantInfo.kind === 'base' ? 'rgba(34,211,238,0.7)' : 'rgba(34,211,238,0.45)',
              color: '#fff',
              border: '1px solid rgba(34,211,238,0.85)',
            }}
            title={
              variantInfo.kind === 'base'
                ? `Base of a ${variantInfo.total - 1}-variant group`
                : `Variant ${variantInfo.variantIndex} of ${variantInfo.total - 1} in this group`
            }
          >
            {variantInfo.kind === 'base'
              ? `⏺ base · ${variantInfo.total - 1}`
              : `⟜ v${variantInfo.variantIndex}/${variantInfo.total - 1}`}
          </div>
        )}

        <div className="absolute top-1 right-1 flex items-center gap-0.5">
          {sourceBadge && (
            <div
              className="px-1 py-0.5 rounded text-[9px]"
              style={{ background: 'rgba(0,0,0,0.7)', color: '#fff' }}
              title={`Image source: ${image?.source}`}
            >
              {sourceBadge}
            </div>
          )}
          {lockedAsStill && (
            <div
              className="px-1 py-0.5 rounded text-[9px]"
              style={{ background: 'rgba(0,0,0,0.7)', color: '#fbbf24' }}
              title="Locked as still"
            >
              🔒
            </div>
          )}
          {hasError && (
            <div
              className="px-1 py-0.5 rounded text-[9px]"
              style={{ background: 'rgba(220,38,38,0.85)', color: '#fff' }}
              title={image?.error || 'Image error'}
            >
              ⚠
            </div>
          )}
        </div>

        <div className="absolute bottom-1 right-1 flex items-center gap-1">
          <StatusDot state={clipState} title={`B-roll: ${clipState}`} kind="clip" />
          <StatusDot state={overlayState} title={`Overlay: ${overlayState}`} kind="overlay" />
        </div>
      </div>

      <div className="px-2 py-1.5">
        <div
          className="text-[11px] leading-tight truncate"
          style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          title={title}
        >
          {title || <span style={{ color: 'var(--text-muted)' }}>Untitled</span>}
        </div>
      </div>
    </button>
  );
};

interface StatusDotProps {
  state: 'ready' | 'busy' | 'missing' | 'error';
  title: string;
  kind: 'clip' | 'overlay';
}

const STATUS_COLORS: Record<StatusDotProps['state'], string> = {
  ready: '#10b981',
  busy: '#f59e0b',
  missing: '#64748b',
  error: '#ef4444',
};

const StatusDot: React.FC<StatusDotProps> = ({ state, title, kind }) => {
  const isBusy = state === 'busy';
  return (
    <div
      title={title}
      className="relative rounded-full"
      style={{
        width: 8,
        height: 8,
        background: STATUS_COLORS[state],
        boxShadow: '0 0 0 1.5px rgba(0,0,0,0.55)',
      }}
      data-kind={kind}
    >
      {isBusy && (
        <div
          className="absolute inset-[-3px] rounded-full animate-ping"
          style={{ background: STATUS_COLORS[state], opacity: 0.45 }}
        />
      )}
    </div>
  );
};
