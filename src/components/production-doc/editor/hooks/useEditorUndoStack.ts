'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import type { EditorWriters } from '../types';

/**
 * In-memory undo / redo stack for editor field changes. Wraps every
 * writer call that mutates a row through `updateRow` so we can later
 * pop the inverse and re-apply it. Operates on the per-row patch level
 * — coarser than per-field, but covers the most common edits cleanly.
 *
 * Bulk operations (apply-to-range, apply-to-all, clear-overrides) are
 * intentionally **not undoable** in v1: they mutate many rows at once
 * and reconstructing the prior state across all of them is a much
 * bigger surface to get right. The user can re-apply manually if they
 * change their mind.
 *
 * Async media generations (broll regens, image generations) are not
 * undoable either — they have side effects (R2 storage, API spend)
 * that can't be cleanly rolled back. The clip history dropdown
 * (Phase 4) is the visible answer to "restore a previous clip".
 *
 * Stack capped at 100 entries so a long editing session doesn't grow
 * unbounded memory. Oldest entries fall off the bottom when full.
 */

const UNDO_CAP = 100;

interface UndoEntry {
  rowIndex: number;
  /** The patch the user applied. Used to redo. */
  patch: Partial<ProductionRow>;
  /** The values those keys held on the row before the patch. Used to
   *  undo. Always includes the same keys as `patch`. */
  prev: Partial<ProductionRow>;
}

export function useEditorUndoStack({
  writers,
  doc,
  setActiveSection,
}: {
  writers: EditorWriters | undefined;
  doc: ProductionDoc;
  setActiveSection: (index: number) => void;
}) {
  const undoStackRef = useRef<UndoEntry[]>([]);
  const redoStackRef = useRef<UndoEntry[]>([]);
  // When true, the wrapped updateRow skips stack tracking — used during
  // undo/redo so we don't record the inverse of an undo as a new edit.
  const replayingRef = useRef(false);
  // We re-read `doc` in handlers via a ref to avoid stale captures
  // without forcing handlers to be re-created on every doc change.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  // ─── Counters surface to the top bar for "Undo / Redo" affordances ─
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const syncCounts = useCallback(() => {
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
  }, []);

  // ─── Wrapped writers ─────────────────────────────────────────────────
  const wrappedWriters: EditorWriters | undefined = useMemo(() => {
    if (!writers) return undefined;
    return {
      ...writers,
      updateRow: (rowIndex, patch) => {
        if (replayingRef.current) {
          writers.updateRow(rowIndex, patch);
          return;
        }
        const row = docRef.current.rows?.[rowIndex];
        if (row) {
          const rowAsRecord = row as unknown as Record<string, unknown>;
          const prevRecord: Record<string, unknown> = {};
          for (const key of Object.keys(patch)) {
            prevRecord[key] = rowAsRecord[key];
          }
          const prev = prevRecord as unknown as Partial<ProductionRow>;
          undoStackRef.current.push({ rowIndex, patch, prev });
          if (undoStackRef.current.length > UNDO_CAP) {
            undoStackRef.current.shift();
          }
          redoStackRef.current = [];
          syncCounts();
        }
        writers.updateRow(rowIndex, patch);
      },
    };
  }, [writers, syncCounts]);

  // ─── Undo / Redo ─────────────────────────────────────────────────────
  const undo = useCallback(() => {
    if (!writers) return;
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    redoStackRef.current.push(entry);
    syncCounts();
    replayingRef.current = true;
    try {
      writers.updateRow(entry.rowIndex, entry.prev);
      // Jump the editor to the section that was just rolled back so the
      // user sees what changed — silent undos in unseen places are a
      // common UX bug we avoid by surfacing the location of every undo.
      setActiveSection(entry.rowIndex);
    } finally {
      replayingRef.current = false;
    }
  }, [writers, setActiveSection, syncCounts]);

  const redo = useCallback(() => {
    if (!writers) return;
    const entry = redoStackRef.current.pop();
    if (!entry) return;
    undoStackRef.current.push(entry);
    syncCounts();
    replayingRef.current = true;
    try {
      writers.updateRow(entry.rowIndex, entry.patch);
      setActiveSection(entry.rowIndex);
    } finally {
      replayingRef.current = false;
    }
  }, [writers, setActiveSection, syncCounts]);

  // ─── Keyboard ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;
      // We allow undo/redo from inside editable fields (matches browser
      // expectation), but only when the user explicitly uses the
      // modifier combo. The browser's native Cmd+Z for text inputs
      // still fires first via beforeInput — only when there's no native
      // history to undo does our handler take effect.
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'z' || e.key === 'Z') {
        if (e.shiftKey) {
          e.preventDefault();
          redo();
          return;
        }
        // Plain Cmd/Ctrl+Z. Skip when inside a text field so the browser's
        // own text-undo wins for typed characters.
        if (inEditable) return;
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === 'y' || e.key === 'Y') {
        // Windows-convention redo. Skip in editable fields for parity
        // with Cmd+Z behaviour.
        if (inEditable) return;
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return {
    writers: wrappedWriters,
    undo,
    redo,
    undoCount,
    redoCount,
    canUndo: undoCount > 0,
    canRedo: redoCount > 0,
  };
}
