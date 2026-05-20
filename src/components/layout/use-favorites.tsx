'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import { DEFAULT_FAVORITES, findNavItem } from './nav-catalog';

const STORAGE_KEY = 'sidebar_favorites_v1';

export interface UseFavoritesReturn {
  /** Ordered list of pinned hrefs. Drives the Favorites band. */
  hrefs: string[];
  /** True once localStorage has been read on mount. Lets consumers
   *  suppress drag-and-drop animations until hydration to avoid jank. */
  hydrated: boolean;
  isPinned: (href: string) => boolean;
  pin: (href: string) => void;
  unpin: (href: string) => void;
  togglePin: (href: string) => void;
  reorder: (from: number, to: number) => void;
}

function loadFromStorage(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((h): h is string => typeof h === 'string');
  } catch {
    return null;
  }
}

function saveToStorage(hrefs: string[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(hrefs)); } catch {}
}

/**
 * Internal hook that owns the favorites state. Wired into a Context so
 * that the Sidebar and any hub page that toggle pins share one source of
 * truth — pinning from a hub card immediately updates the sidebar band.
 *
 * Storage model — localStorage-backed for v1. A future phase can swap
 * the read/write helpers for an API call without changing the public
 * shape of the hook. The default seed (DEFAULT_FAVORITES) is only
 * applied when storage is empty; once a user has interacted, their list
 * is authoritative — even if that list is empty.
 */
function useFavoritesState(): UseFavoritesReturn {
  const [hrefs, setHrefs] = useState<string[]>(() => [...DEFAULT_FAVORITES]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = loadFromStorage();
    if (saved !== null) {
      // Drop hrefs that no longer resolve in the catalog (a tool that
      // was renamed or removed). Keeps the reorder math consistent with
      // the rendered list, and quietly heals stale storage.
      const pruned = saved.filter(href => findNavItem(href) !== undefined);
      setHrefs(pruned);
      if (pruned.length !== saved.length) saveToStorage(pruned);
    }
    setHydrated(true);
  }, []);

  const isPinned = useCallback((href: string) => hrefs.includes(href), [hrefs]);

  const pin = useCallback((href: string) => {
    setHrefs(prev => {
      if (prev.includes(href)) return prev;
      const next = [...prev, href];
      saveToStorage(next);
      console.info('[nav favorite]', 'pin', { href });
      return next;
    });
  }, []);

  const unpin = useCallback((href: string) => {
    setHrefs(prev => {
      if (!prev.includes(href)) return prev;
      const next = prev.filter(h => h !== href);
      saveToStorage(next);
      console.info('[nav favorite]', 'unpin', { href });
      return next;
    });
  }, []);

  const togglePin = useCallback((href: string) => {
    setHrefs(prev => {
      const wasPinned = prev.includes(href);
      const next = wasPinned ? prev.filter(h => h !== href) : [...prev, href];
      saveToStorage(next);
      console.info('[nav favorite]', wasPinned ? 'unpin' : 'pin', { href });
      return next;
    });
  }, []);

  const reorder = useCallback((from: number, to: number) => {
    if (from === to) return;
    setHrefs(prev => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      saveToStorage(next);
      console.info('[nav favorite]', 'reorder', { from, to, hrefs: next });
      return next;
    });
  }, []);

  return { hrefs, hydrated, isPinned, pin, unpin, togglePin, reorder };
}

const FavoritesContext = createContext<UseFavoritesReturn | null>(null);

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const value = useFavoritesState();
  return (
    <FavoritesContext.Provider value={value}>
      {children}
    </FavoritesContext.Provider>
  );
}

export function useFavorites(): UseFavoritesReturn {
  const ctx = useContext(FavoritesContext);
  if (!ctx) {
    throw new Error('useFavorites must be used within a <FavoritesProvider>');
  }
  return ctx;
}
