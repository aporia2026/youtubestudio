"use client";

/**
 * Right-click context menu for an overlay cell. Phase 5 of the
 * overlay-system overhaul plan — the council asked for ✎ Edit to be
 * reachable via right-click AS WELL AS the inline button and the
 * position-editor header, so power users can hit any common overlay
 * action without opening a dialog first.
 *
 * The menu is portal-rendered at a fixed position (the cursor) and
 * auto-closes on:
 *   - click outside the menu
 *   - Escape
 *   - any item click (consumed via onClose)
 *
 * Items are passed in by the parent so the same component works for
 * different cell variants (table view, list view, etc). Disabled items
 * render greyed-out — used for "Undo last edit" when there's nothing
 * to undo.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface OverlayContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Optional one-line title shown as a native tooltip on hover. */
  title?: string;
  /** Optional separator above this item — used to group destructive
   *  actions away from the safe ones. */
  separatorAbove?: boolean;
  /** When true, the item renders in red to flag a destructive action
   *  (e.g. "Remove overlay"). The parent is responsible for any
   *  confirm prompt before mutating state. */
  destructive?: boolean;
}

interface OverlayContextMenuProps {
  /** Viewport coords from the contextmenu event. Menu's top-left is
   *  positioned here; the menu shifts itself up/left if the resulting
   *  rect would overflow the viewport. */
  x: number;
  y: number;
  items: OverlayContextMenuItem[];
  onClose: () => void;
}

/** Estimated menu dimensions for viewport-edge clamping. The exact
 *  height varies with item count; this is a conservative upper bound. */
const MENU_W_PX = 220;
const MENU_H_PER_ITEM_PX = 32;
const MENU_PAD_PX = 8;

export function OverlayContextMenu({ x, y, items, onClose }: OverlayContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside. We listen on document-level mousedown so
  // the click can be detected before the next React render commits —
  // a `click` listener fires after `mouseup`, which races with native
  // selection state and feels laggy.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp to viewport — shift up if there's not enough room below,
  // shift left if not enough room to the right.
  const estHeight = items.length * MENU_H_PER_ITEM_PX + MENU_PAD_PX * 2;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const left = x + MENU_W_PX > vw ? Math.max(8, vw - MENU_W_PX - 8) : x;
  const top = y + estHeight > vh ? Math.max(8, vh - estHeight - 8) : y;

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 1200,
        minWidth: MENU_W_PX,
        background: '#0f1115',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 6,
        boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
        padding: MENU_PAD_PX / 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {items.map((item, idx) => (
        <div key={`${item.label}-${idx}`} style={{ display: 'flex', flexDirection: 'column' }}>
          {item.separatorAbove && idx > 0 && (
            <div
              aria-hidden
              style={{
                height: 1,
                background: 'rgba(255,255,255,0.08)',
                margin: '4px 6px',
              }}
            />
          )}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
            title={item.title}
            style={{
              textAlign: 'left',
              fontSize: 12,
              padding: '6px 10px',
              borderRadius: 4,
              background: 'transparent',
              color: item.disabled
                ? 'rgba(255,255,255,0.30)'
                : item.destructive
                  ? '#f87171'
                  : 'var(--text)',
              border: 'none',
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              transition: 'background 80ms',
            }}
            onMouseEnter={(e) => {
              if (item.disabled) return;
              e.currentTarget.style.background = item.destructive
                ? 'rgba(239,68,68,0.12)'
                : 'rgba(255,255,255,0.06)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(menu, document.body);
}
