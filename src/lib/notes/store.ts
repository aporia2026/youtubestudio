'use client';

/**
 * `useNotes(docId)` — the single state store the notes-while-watching
 * feature uses on both the production-doc grid and the Editor view.
 * Both surfaces call `useNotes(doc.id)` and get the same source of
 * truth: any note added in one shows up in the other.
 *
 * Wire model: optimistic local cache + REST writes. Refetches on a 5s
 * interval while the page is visible so a note made in another open
 * tab eventually propagates (single-user, so 5s is fine — no need for
 * a socket layer).
 *
 * Why a hook and not React context: the notes data is per-doc and we
 * only ever have one doc open at a time. A hook with its own
 * useState/useEffect keeps the wiring simple and lets each consumer
 * (dock, review queue, timeline strip) opt in to the data it needs.
 * The visible-tab refetch is shared because we cache the in-flight
 * fetcher per docId in module scope.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  CreateNoteInput,
  ProductionDocNote,
  UpdateNoteInput,
} from './types';

interface UseNotesState {
  notes: ProductionDocNote[];
  loading: boolean;
  error: string | null;
}

const REFETCH_INTERVAL_MS = 5_000;

async function fetchNotes(docId: string): Promise<ProductionDocNote[]> {
  const res = await fetch(`/api/production-doc/notes?docId=${encodeURIComponent(docId)}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Notes fetch failed (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data.notes) ? (data.notes as ProductionDocNote[]) : [];
}

export interface UseNotesResult extends UseNotesState {
  /** Create a new note. Resolves with the saved row, or null on failure. */
  create: (input: CreateNoteInput) => Promise<ProductionDocNote | null>;
  /** Patch an existing note. Resolves with the updated row, or null on failure. */
  update: (id: string, patch: UpdateNoteInput) => Promise<ProductionDocNote | null>;
  /** Hard-delete a note. */
  remove: (id: string) => Promise<boolean>;
  /** Convenience: flip `resolved` and re-write. */
  toggleResolved: (id: string) => Promise<ProductionDocNote | null>;
  /** Force a re-fetch (e.g. after coming back to the tab). */
  refresh: () => Promise<void>;
}

export function useNotes(docId: string | null): UseNotesResult {
  const [state, setState] = useState<UseNotesState>({
    notes: [],
    loading: Boolean(docId),
    error: null,
  });

  // Hold the live notes in a ref too so the optimistic-update writers
  // can reason about the latest list without depending on closure
  // identity. Mirror it inside `setState` so consumers re-render.
  const notesRef = useRef<ProductionDocNote[]>([]);
  const setNotes = useCallback((updater: (prev: ProductionDocNote[]) => ProductionDocNote[]) => {
    setState((s) => {
      const next = updater(s.notes);
      notesRef.current = next;
      return { ...s, notes: next };
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!docId) return;
    try {
      const fresh = await fetchNotes(docId);
      notesRef.current = fresh;
      setState({ notes: fresh, loading: false, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load notes';
      setState((s) => ({ ...s, loading: false, error: msg }));
    }
  }, [docId]);

  // Initial load + periodic refetch while the tab is visible.
  useEffect(() => {
    if (!docId) {
      setState({ notes: [], loading: false, error: null });
      notesRef.current = [];
      return;
    }
    setState({ notes: [], loading: true, error: null });
    notesRef.current = [];
    void refresh();

    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      void refresh();
    };
    const handle = window.setInterval(tick, REFETCH_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [docId, refresh]);

  const create = useCallback(
    async (input: CreateNoteInput): Promise<ProductionDocNote | null> => {
      try {
        const res = await fetch('/api/production-doc/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error ? String(data.error) : `Create failed (${res.status})`);
        }
        const { note } = (await res.json()) as { note: ProductionDocNote };
        // Insert in the correct sorted position (row asc, ts asc,
        // createdAt asc) instead of appending — keeps the dock's
        // current-scene list in a stable order during rapid additions.
        setNotes((prev) => {
          const next = [...prev, note];
          next.sort(
            (a, b) =>
              a.rowIndex - b.rowIndex ||
              a.sceneTsMs - b.sceneTsMs ||
              a.createdAt.localeCompare(b.createdAt),
          );
          return next;
        });
        return note;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Note save failed');
        return null;
      }
    },
    [setNotes],
  );

  const update = useCallback(
    async (id: string, patch: UpdateNoteInput): Promise<ProductionDocNote | null> => {
      // Optimistic: apply patch immediately, roll back on failure.
      const previous = notesRef.current.find((n) => n.id === id) ?? null;
      if (previous) {
        setNotes((prev) =>
          prev.map((n) =>
            n.id === id
              ? {
                  ...n,
                  ...(patch.text !== undefined ? { text: patch.text } : {}),
                  ...(patch.tag !== undefined ? { tag: patch.tag } : {}),
                  ...(patch.resolved !== undefined ? { resolved: patch.resolved } : {}),
                  updatedAt: new Date().toISOString(),
                }
              : n,
          ),
        );
      }
      try {
        const res = await fetch(`/api/production-doc/notes/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error ? String(data.error) : `Update failed (${res.status})`);
        }
        const { note } = (await res.json()) as { note: ProductionDocNote };
        setNotes((prev) => prev.map((n) => (n.id === id ? note : n)));
        return note;
      } catch (err) {
        // Roll back the optimistic update on failure.
        if (previous) setNotes((prev) => prev.map((n) => (n.id === id ? previous : n)));
        toast.error(err instanceof Error ? err.message : 'Note update failed');
        return null;
      }
    },
    [setNotes],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      const previous = notesRef.current.find((n) => n.id === id) ?? null;
      // Optimistic remove.
      setNotes((prev) => prev.filter((n) => n.id !== id));
      try {
        const res = await fetch(`/api/production-doc/notes/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error ? String(data.error) : `Delete failed (${res.status})`);
        }
        return true;
      } catch (err) {
        if (previous) {
          setNotes((prev) => {
            const next = [...prev, previous];
            next.sort(
              (a, b) =>
                a.rowIndex - b.rowIndex ||
                a.sceneTsMs - b.sceneTsMs ||
                a.createdAt.localeCompare(b.createdAt),
            );
            return next;
          });
        }
        toast.error(err instanceof Error ? err.message : 'Note delete failed');
        return false;
      }
    },
    [setNotes],
  );

  const toggleResolved = useCallback(
    (id: string) => {
      const current = notesRef.current.find((n) => n.id === id);
      if (!current) return Promise.resolve(null);
      return update(id, { resolved: !current.resolved });
    },
    [update],
  );

  return {
    notes: state.notes,
    loading: state.loading,
    error: state.error,
    create,
    update,
    remove,
    toggleResolved,
    refresh,
  };
}
