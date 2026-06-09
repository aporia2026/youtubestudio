'use client';

/**
 * Shared 3-up variant picker used by every thumbnail format that
 * generates multiple variants per "Generate" click. Free-form,
 * topic-card-grid, n-levels, flex-icon-grid, and doodle-explainer all
 * render this underneath their format-specific controls.
 *
 * Visual contract:
 *   - Desktop: 3 columns side-by-side (or N if variantCount !== 3).
 *   - Mobile: stacked column, full-width each.
 *   - Selected card: thick saturated-yellow border (#FBC02D ish) so the
 *     pick is unmistakable. Other cards: subtle muted border.
 *   - Failed slot (empty imageUrl): "Try again" button, dashed border,
 *     reduced opacity.
 *   - `conceptLabel` under each card when present.
 *
 * Plan: `_plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md`.
 */

import type { ThumbnailVariant } from '@/lib/thumbnail-variants';

export interface VariantPickerProps {
  variants: ThumbnailVariant[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  /** Fires when the user clicks "Try again" on a failed/empty slot.
   *  Optional — when omitted, failed slots show only an error state. */
  onRegenerate?: (index: number) => void;
  /** Set true while a regenerate-slot call is in flight. Disables all
   *  retry buttons + shows a spinner on the in-flight slot. */
  regeneratingIndex?: number | null;
  /** Optional label rendered above the grid (e.g. "Pick your variant"). */
  heading?: string;
  /** Optional sub-label rendered under the heading. */
  subheading?: string;
}

export function VariantPicker({
  variants,
  selectedIndex,
  onSelect,
  onRegenerate,
  regeneratingIndex,
  heading,
  subheading,
}: VariantPickerProps): React.ReactElement | null {
  if (!variants || variants.length === 0) return null;

  return (
    <div className="space-y-3">
      {(heading || subheading) ? (
        <div>
          {heading ? (
            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {heading}
            </div>
          ) : null}
          {subheading ? (
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {subheading}
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 220px), 1fr))`,
        }}
      >
        {variants.map((v, idx) => {
          const isSelected = idx === selectedIndex;
          const isFailed = !v.imageUrl;
          const isRegenerating = regeneratingIndex === idx;
          return (
            <VariantCard
              key={v.id}
              variant={v}
              index={idx}
              isSelected={isSelected}
              isFailed={isFailed}
              isRegenerating={isRegenerating}
              regeneratingIndex={regeneratingIndex}
              onSelect={onSelect}
              onRegenerate={onRegenerate}
            />
          );
        })}
      </div>
    </div>
  );
}

interface VariantCardProps {
  variant: ThumbnailVariant;
  index: number;
  isSelected: boolean;
  isFailed: boolean;
  isRegenerating: boolean;
  regeneratingIndex?: number | null;
  onSelect: (index: number) => void;
  onRegenerate?: (index: number) => void;
}

function VariantCard({
  variant,
  index,
  isSelected,
  isFailed,
  isRegenerating,
  regeneratingIndex,
  onSelect,
  onRegenerate,
}: VariantCardProps): React.ReactElement {
  const borderColor = isSelected
    ? '#FBC02D'
    : isFailed
      ? 'rgba(239, 68, 68, 0.5)'
      : 'var(--border-subtle, rgba(255,255,255,0.1))';
  const borderWidth = isSelected ? 4 : isFailed ? 2 : 1;
  const borderStyle: 'solid' | 'dashed' = isFailed ? 'dashed' : 'solid';

  return (
    <div
      className="relative rounded-lg overflow-hidden transition-all"
      style={{
        borderColor,
        borderWidth,
        borderStyle,
        opacity: isFailed ? 0.7 : 1,
        cursor: isFailed ? 'default' : 'pointer',
        background: 'var(--surface-1, rgba(255,255,255,0.02))',
      }}
      onClick={() => {
        if (isFailed) return;
        onSelect(index);
      }}
      role={isFailed ? undefined : 'button'}
      aria-pressed={isFailed ? undefined : isSelected}
      aria-label={`Variant ${index + 1}${isSelected ? ' (selected)' : ''}`}
      tabIndex={isFailed ? -1 : 0}
      onKeyDown={(e) => {
        if (isFailed) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(index);
        }
      }}
    >
      <div
        className="relative w-full"
        style={{ aspectRatio: '16 / 9', background: 'rgba(0,0,0,0.2)' }}
      >
        {isFailed ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center"
            style={{ color: 'var(--text-muted)' }}
          >
            <div className="text-xs">Variant {index + 1} failed</div>
            {onRegenerate ? (
              <button
                type="button"
                className="px-3 py-1.5 rounded text-xs"
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: 'rgb(248, 113, 113)',
                  borderColor: 'rgba(239, 68, 68, 0.4)',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  opacity: regeneratingIndex !== null && regeneratingIndex !== undefined ? 0.5 : 1,
                }}
                disabled={regeneratingIndex !== null && regeneratingIndex !== undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onRegenerate(index);
                }}
              >
                {isRegenerating ? 'Generating…' : 'Try again'}
              </button>
            ) : null}
          </div>
        ) : (
          <img
            src={variant.imageUrl}
            alt={variant.conceptLabel || `Variant ${index + 1}`}
            loading="lazy"
            decoding="async"
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        )}
        {isSelected ? (
          <div
            className="absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-bold"
            style={{
              background: '#FBC02D',
              color: '#000',
            }}
          >
            SELECTED
          </div>
        ) : null}
        {!isFailed && onRegenerate ? (
          <button
            type="button"
            className="absolute top-2 right-2 px-2 py-1 rounded text-[10px]"
            style={{
              background: 'rgba(0,0,0,0.65)',
              color: '#fff',
              backdropFilter: 'blur(4px)',
              opacity: isRegenerating ? 0.5 : 1,
            }}
            disabled={isRegenerating || (regeneratingIndex !== null && regeneratingIndex !== undefined && regeneratingIndex !== index)}
            onClick={(e) => {
              e.stopPropagation();
              onRegenerate(index);
            }}
            title="Regenerate this variant"
            aria-label={`Regenerate variant ${index + 1}`}
          >
            {isRegenerating ? '…' : '↻'}
          </button>
        ) : null}
      </div>
      {variant.conceptLabel ? (
        <div
          className="px-2.5 py-1.5 text-[11px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {variant.conceptLabel}
        </div>
      ) : null}
    </div>
  );
}
