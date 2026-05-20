'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { findNavItem, type NavItem } from './nav-catalog';
import type { UseFavoritesReturn } from './use-favorites';

function isActiveRoute(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard' || pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

// dnd-kit modifier: zero out horizontal drag so the items only move
// vertically. The sidebar is a fixed-width column — sideways drift
// would feel broken.
function restrictToVerticalAxis({ transform }: { transform: { x: number; y: number; scaleX: number; scaleY: number } }) {
  return { ...transform, x: 0 };
}

interface SortableRowProps {
  item: NavItem;
  collapsed: boolean;
  onUnpin: (href: string) => void;
}

function SortableRow({ item, collapsed, onUnpin }: SortableRowProps) {
  const pathname = usePathname();
  const active = isActiveRoute(pathname, item.href);
  const [hovered, setHovered] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.href });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    background: active ? 'rgba(124,58,237,0.15)' : 'transparent',
    color: active ? 'var(--accent-purple-bright)' : 'var(--text-secondary)',
    border: active ? '1px solid rgba(124,58,237,0.25)' : '1px solid transparent',
    cursor: isDragging ? 'grabbing' : 'grab',
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : 'auto',
    position: 'relative',
    touchAction: 'none',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors"
    >
      {active && (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full"
          style={{ background: 'var(--accent-purple-bright)' }}
        />
      )}

      {/* Link is wrapped around icon+label so the visible label stays a
          navigable target. The wrapping div above owns the drag listeners,
          so clicking still navigates (drag starts only when the pointer
          actually moves past dnd-kit's activation distance). */}
      <Link
        href={item.href}
        onClick={e => e.stopPropagation()}
        draggable={false}
        className="flex items-center gap-3 flex-1 min-w-0"
        style={{ color: 'inherit', textDecoration: 'none' }}
      >
        <span className="shrink-0">{item.icon}</span>
        {!collapsed && (
          <span className="text-sm font-medium whitespace-nowrap overflow-hidden">
            {item.label}
          </span>
        )}
      </Link>

      {/* Unpin button — hover-revealed, expanded mode only. */}
      {!collapsed && hovered && !isDragging && (
        <button
          type="button"
          onClick={e => {
            e.preventDefault();
            e.stopPropagation();
            onUnpin(item.href);
          }}
          onPointerDown={e => e.stopPropagation()}
          aria-label={`Unpin ${item.label}`}
          title="Unpin"
          className="ml-auto shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        </button>
      )}
    </div>
  );
}

interface SidebarFavoritesProps {
  collapsed: boolean;
  favorites: UseFavoritesReturn;
}

/**
 * Pinned-shortcuts band between the workspace top-nav and the workflow
 * hubs. Items are drag-reorderable (vertical only) and each has a
 * hover-revealed unpin star. Empty list → component renders nothing.
 */
export function SidebarFavorites({ collapsed, favorites }: SidebarFavoritesProps) {
  // Resolve hrefs → NavItems. Stale hrefs (e.g. a tool that was removed
  // from the catalog) are silently dropped.
  const items: NavItem[] = [];
  for (const href of favorites.hrefs) {
    const item = findNavItem(href);
    if (item) items.push(item);
  }

  const sensors = useSensors(
    // 5px activation distance: short clicks still navigate, only an
    // actual drag-gesture starts a sort.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = favorites.hrefs.indexOf(String(active.id));
    const to = favorites.hrefs.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    favorites.reorder(from, to);
  }

  if (items.length === 0) return null;

  return (
    <div className="pt-3">
      {!collapsed && (
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-widest font-bold"
          style={{ color: 'var(--text-muted)' }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
          <span>Favorites</span>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={favorites.hrefs} strategy={verticalListSortingStrategy}>
          <div className={collapsed ? 'space-y-0.5 mt-1' : 'space-y-0.5 mt-1'}>
            {items.map(item => (
              <SortableRow
                key={item.href}
                item={item}
                collapsed={collapsed}
                onUnpin={favorites.unpin}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
