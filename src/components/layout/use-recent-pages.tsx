'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

import { findNavItem, HUBS } from './nav-catalog';

const STORAGE_KEY = 'palette_recent_v1';
const MAX_RECENT = 5;

export interface RecentEntry {
  /** Exact href of a NavItem the user navigated to. */
  href: string;
  /** Unix ms — purely for ordering, never displayed. */
  ts: number;
}

function readStorage(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentEntry =>
        e != null &&
        typeof e === 'object' &&
        typeof (e as RecentEntry).href === 'string' &&
        typeof (e as RecentEntry).ts === 'number'
    ).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function writeStorage(entries: RecentEntry[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch {}
}

/**
 * Push the current pathname into the recent-pages list whenever the
 * route changes. Mount this once at the layout level — calling it from
 * multiple places is harmless but wastes work.
 *
 * Tracking rule: only exact catalog matches are stored. Sub-routes
 * (e.g. `/projects/42`) are skipped so the Recent list stays a short,
 * trustworthy "recent destinations" rather than a noisy browser
 * history. Unknown routes (e.g. `/login`) are ignored.
 */
export function useRecentPagesTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    // Embed mode (iframed sub-page, e.g. inside /team-hub) shouldn't
    // pollute the parent's recent list with its sub-navigations.
    if (typeof window !== 'undefined') {
      try {
        if (window.top !== null && window.top !== window) return;
      } catch {
        // Cross-origin top — treat as iframe and skip.
        return;
      }
    }
    // Accept either a NavItem (tool destination) or a hub landing page.
    // Both have a label the palette can render. Unknown paths (login,
    // 404, deep sub-routes) are silently ignored.
    const known =
      findNavItem(pathname) !== undefined ||
      HUBS.some(h => h.href === pathname);
    if (!known) return;

    const current = readStorage();
    const filtered = current.filter(e => e.href !== pathname);
    const next: RecentEntry[] = [
      { href: pathname, ts: Date.now() },
      ...filtered,
    ].slice(0, MAX_RECENT);
    writeStorage(next);
    console.info('[palette recent]', 'push', { href: pathname });
  }, [pathname]);
}

/** Read the current recent-pages list. Returns most-recent-first. */
export function readRecentPages(): RecentEntry[] {
  if (typeof window === 'undefined') return [];
  return readStorage();
}
