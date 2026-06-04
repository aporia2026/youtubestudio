'use client';

import React, { useMemo, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ProductionDoc } from '@/remotion/utils';
import type { RowImageStateView } from '@/components/production-doc/editor/types';
import {
  SceneCard,
  type SceneCardOrientation,
  type SceneCardVideoState,
} from './SceneCard';

export type SceneStripOrientation = SceneCardOrientation;

/**
 * SceneStrip — horizontal or vertical scene-card surface in Studio
 * Mode. Phase R4 of `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Drag-to-reorder: when `onReorderRow` is provided and no search
 * filter is active, cards become sortable via `@dnd-kit/sortable`
 * (pointer drag + keyboard navigation, accessible by default). The
 * SceneStrip fires `onReorderRow(fromIndex, toIndex)` with ABSOLUTE
 * row indices on drop; page.tsx atomically reorders every
 * row-indexed state slice via `reorderProductionDocState`.
 *
 * Dragging is intentionally disabled while a search query is active
 * — moving a card to an "absolute" position from a filtered view
 * produces surprising reorderings. Clearing the search restores
 * draggability.
 */
export interface SceneStripProps {
  doc: ProductionDoc;
  rowImagesByIndex?: ReadonlyArray<RowImageStateView | undefined>;
  /** Per-row video clip state. Drives the V badge on each card. */
  rowVideoClipsByIndex?: Readonly<Record<number, SceneCardVideoState | null>>;
  /** 0-based selected row index, or `null` when nothing is selected. */
  selectedRowIndex?: number | null;
  /** Called with the 0-based index when the user activates a card. */
  onSelectRow?: (rowIndex: number) => void;
  /** Called with absolute (0-based) from/to indices on drag-end.
   *  When omitted the strip renders without dnd wiring. */
  onReorderRow?: (fromIndex: number, toIndex: number) => void;
  /** Layout direction. Default `'horizontal'`. R4 PR2. */
  orientation?: SceneStripOrientation;
}

interface SortableSceneCardProps {
  id: string;
  rowIndex: number;
  row: ProductionDoc['rows'][number];
  imageState?: RowImageStateView;
  videoState?: SceneCardVideoState | null;
  selected: boolean;
  onSelect?: (rowIndex: number) => void;
  orientation: SceneStripOrientation;
}

const SortableSceneCard: React.FC<SortableSceneCardProps> = ({
  id,
  rowIndex,
  row,
  imageState,
  videoState,
  selected,
  onSelect,
  orientation,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
    cursor: 'grab',
    touchAction: 'none',
  };
  // QA fix: `useSortable` applies `role="button"` + aria-roledescription
  // via `attributes`. Spreading that onto the wrapper here would
  // (a) create a button-inside-button (the SceneCard itself is a
  // <button>), which is invalid HTML and confuses screen readers,
  // and (b) drop the `role="listitem"` we need to keep the parent
  // `role="list"` semantic intact.
  //
  // Resolution: spread `attributes` minus its `role`/`tabIndex`
  // (the inner button already owns those) and apply `role="listitem"`
  // ourselves. `listeners` carry the pointer/keyboard wiring and stay
  // intact. The inner SceneCard remains the single focusable
  // affordance.
  const {
    role: _dropRole,
    tabIndex: _dropTabIndex,
    ...wrapperAttrs
  } = attributes;
  void _dropRole;
  void _dropTabIndex;
  return (
    <div
      ref={setNodeRef}
      role="listitem"
      {...wrapperAttrs}
      {...listeners}
      style={
        orientation === 'horizontal'
          ? { ...style, scrollSnapAlign: 'start' }
          : style
      }
    >
      <SceneCard
        rowIndex={rowIndex}
        row={row}
        imageState={imageState}
        videoState={videoState}
        selected={selected}
        onSelect={onSelect}
        orientation={orientation}
      />
    </div>
  );
};

export const SceneStrip: React.FC<SceneStripProps> = ({
  doc,
  rowImagesByIndex,
  rowVideoClipsByIndex,
  selectedRowIndex = null,
  onSelectRow,
  onReorderRow,
  orientation = 'horizontal',
}) => {
  const rows = doc.rows ?? [];
  const [searchQuery, setSearchQuery] = useState('');
  const filteredIndices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows.map((_, idx) => idx);
    return rows
      .map((row, idx) => {
        const haystack = [
          String(idx + 1),
          row.timecode ?? '',
          row.script_text ?? '',
          row.visual_description ?? '',
          row.section_title ?? '',
          row.visual_type ?? '',
        ]
          .join('  ')
          .toLowerCase();
        return haystack.includes(q) ? idx : -1;
      })
      .filter((idx) => idx >= 0);
  }, [rows, searchQuery]);
  const showSearch = rows.length >= 6;
  const hiddenCount = rows.length - filteredIndices.length;
  const isFiltered = searchQuery.trim().length > 0;
  const canReorder = !!onReorderRow && !isFiltered;

  // dnd-kit sensors: pointer requires a 6px drag distance so a click
  // on the card (to select the row) doesn't accidentally fire a
  // drag. Keyboard sensor wires the standard arrow-key / space-bar
  // ARIA pattern.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    if (!onReorderRow) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = Number(active.id);
    const toIndex = Number(over.id);
    if (Number.isNaN(fromIndex) || Number.isNaN(toIndex)) return;
    onReorderRow(fromIndex, toIndex);
  };

  if (rows.length === 0) {
    return (
      <div
        className="text-xs px-3 py-6 text-center rounded"
        style={{
          color: 'var(--text-muted)',
          background: 'rgba(255,255,255,0.02)',
          border: '1px dashed rgba(255,255,255,0.08)',
        }}
      >
        No scenes yet. Generate a production doc to see scene cards here.
      </div>
    );
  }

  const renderCard = (idx: number) => {
    const row = rows[idx];
    const cardProps = {
      rowIndex: idx,
      row,
      imageState: rowImagesByIndex?.[idx],
      videoState: rowVideoClipsByIndex?.[idx] ?? null,
      selected: selectedRowIndex === idx,
      onSelect: onSelectRow,
      orientation,
    };
    if (canReorder) {
      return (
        <SortableSceneCard
          key={idx}
          id={String(idx)}
          {...cardProps}
        />
      );
    }
    return (
      <div
        key={idx}
        role="listitem"
        style={
          orientation === 'horizontal' ? { scrollSnapAlign: 'start' } : undefined
        }
      >
        <SceneCard {...cardProps} />
      </div>
    );
  };

  const listContent = (
    <div
      role="list"
      aria-label="Scene cards"
      data-orientation={orientation}
      className={
        orientation === 'vertical'
          ? 'px-3 pb-3 flex flex-col gap-1.5 max-h-[480px] overflow-y-auto'
          : 'px-3 pb-3 flex items-stretch gap-2 overflow-x-auto'
      }
      style={
        orientation === 'vertical'
          ? { scrollbarWidth: 'thin' }
          : {
              scrollSnapType: 'x mandatory',
              scrollbarWidth: 'thin',
            }
      }
    >
      {filteredIndices.map(renderCard)}
      {filteredIndices.length === 0 && searchQuery && (
        <div
          className="text-xs px-3 py-4 italic"
          style={{ color: 'var(--text-muted)' }}
        >
          No scenes match &ldquo;{searchQuery}&rdquo;.
        </div>
      )}
    </div>
  );

  return (
    <section
      aria-label="Scene strip"
      className="rounded"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <header className="px-3 py-2 flex items-baseline justify-between gap-3">
        <h2
          className="text-[10px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--text-muted)' }}
        >
          Scenes
        </h2>
        {showSearch && (
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Jump to scene…"
            aria-label="Search scenes"
            className="text-[11px] rounded px-2 py-0.5 flex-1 max-w-[200px]"
            style={{
              background: 'rgba(0,0,0,0.25)',
              color: 'var(--text-primary)',
              border: '1px solid rgba(255,255,255,0.10)',
            }}
          />
        )}
        <span
          className="text-[10px]"
          style={{ color: 'var(--text-muted)' }}
        >
          {hiddenCount > 0
            ? `${filteredIndices.length} of ${rows.length}`
            : `${rows.length} ${rows.length === 1 ? 'scene' : 'scenes'}`}
        </span>
      </header>
      {canReorder ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={filteredIndices.map(String)}
            strategy={
              orientation === 'vertical'
                ? verticalListSortingStrategy
                : horizontalListSortingStrategy
            }
          >
            {listContent}
          </SortableContext>
        </DndContext>
      ) : (
        listContent
      )}
    </section>
  );
};
