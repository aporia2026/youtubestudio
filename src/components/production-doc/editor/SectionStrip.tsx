'use client';

import React, { useEffect, useRef } from 'react';
import { SectionCard, type SectionCardVariantInfo } from './SectionCard';
import { getVariantGroup, isVariantRow } from '@/remotion/utils';
import type { EditorViewProps } from './types';

interface SectionStripProps
  extends Pick<EditorViewProps, 'doc' | 'rowImages' | 'rowVideoClips' | 'rowOverlays' | 'rowLockedAsStill'> {
  activeSection: number;
  onSelectSection: (index: number) => void;
}

/**
 * The editor's bottom section strip. Horizontal-scroll row of
 * `SectionCard`s, one per `doc.rows[i]`. The active card auto-scrolls
 * into view whenever the active section changes from elsewhere (arrow
 * keys, stage interactions). Clicking a card selects it.
 *
 * Scroll-into-view uses `behavior: 'smooth'` and `inline: 'center'` so
 * the active card animates to the centre — a small but high-leverage
 * UX cue that the rest of the editor is now showing this section.
 */
export const SectionStrip: React.FC<SectionStripProps> = ({
  doc,
  rowImages,
  rowVideoClips,
  rowOverlays,
  rowLockedAsStill,
  activeSection,
  onSelectSection,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeRef.current || !containerRef.current) return;
    activeRef.current.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
  }, [activeSection]);

  const rows = doc.rows ?? [];

  if (rows.length === 0) {
    return (
      <div
        className="rounded-xl p-6 text-center text-sm"
        style={{
          background: 'rgba(255,255,255,0.03)',
          color: 'var(--text-muted)',
          border: '1px solid var(--border)',
        }}
      >
        No sections yet. Generate a production doc to start editing.
      </div>
    );
  }

  return (
    <div
      className="relative rounded-xl"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        ref={containerRef}
        className="flex items-stretch gap-2 overflow-x-auto py-3 px-3"
        style={{
          scrollbarWidth: 'thin',
          scrollSnapType: 'x proximity',
        }}
      >
        {rows.map((row, i) => {
          const isActive = i === activeSection;
          const title =
            row.section_title?.trim() ||
            row.visual_description?.trim().slice(0, 40) ||
            row.script_text?.trim().slice(0, 40) ||
            '';
          // Phase 3.7d — compute variant-group context for this card.
          // Standalone rows (no group_id) get `undefined`, suppressing
          // the chip and left-border accent. Base rows (variant_index
          // === 0) get kind='base'. Other indexes get kind='variant'.
          let variantInfo: SectionCardVariantInfo | undefined;
          if (isVariantRow(row) && row.group_id) {
            const group = getVariantGroup(doc, row.group_id);
            const variantIdx = row.variant_index ?? 0;
            variantInfo = {
              kind: variantIdx === 0 ? 'base' : 'variant',
              variantIndex: variantIdx,
              total: group.length,
            };
          }
          return (
            <div
              key={i}
              ref={isActive ? activeRef : undefined}
              style={{ scrollSnapAlign: 'center' }}
            >
              <SectionCard
                index={i}
                title={title}
                isActive={isActive}
                image={rowImages[i]}
                clip={rowVideoClips[i]}
                overlay={rowOverlays[i]}
                lockedAsStill={Boolean(rowLockedAsStill[i])}
                onClick={() => onSelectSection(i)}
                variantInfo={variantInfo}
              />
            </div>
          );
        })}
      </div>

      {/* Soft fade-out on the right edge to hint at horizontal scroll */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 right-0 h-full"
        style={{
          width: 32,
          background:
            'linear-gradient(to left, rgba(15,15,15,0.85), rgba(15,15,15,0))',
          borderTopRightRadius: 'inherit',
          borderBottomRightRadius: 'inherit',
        }}
      />
    </div>
  );
};
