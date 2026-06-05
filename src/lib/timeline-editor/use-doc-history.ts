/**
 * Thin React wrapper around the pure `reduceDocHistory` reducer in
 * `./doc-history.ts`. Exists so the timeline editor's parent
 * components can call `setDoc({ commit })`, `undo()`, `redo()`,
 * and `reset()` without thinking about the underlying state shape.
 *
 * The pure reducer is tested separately in
 * `tests/doc-history.test.ts`; the hook just glues it into React's
 * useReducer.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md (M5).
 */

import { useCallback, useReducer } from 'react';
import {
  DEFAULT_HISTORY_DEPTH,
  docHistoryCanRedo,
  docHistoryCanUndo,
  docHistoryCurrent,
  initDocHistory,
  reduceDocHistory,
  type DocHistoryAction,
  type DocHistoryState,
} from './doc-history';

export interface UseDocHistoryReturn<T> {
  current: T;
  pointer: number;
  size: number;
  canUndo: boolean;
  canRedo: boolean;
  setDoc: (next: T, opts?: { commit?: boolean }) => void;
  /** Snapshot the current head so a subsequent run of `live`
   *  updates (drag tick stream) can mutate the new head freely
   *  while the pre-drag state stays one undo away. Call once at
   *  drag-start. */
  beginBatch: () => void;
  undo: () => void;
  redo: () => void;
  reset: (next: T) => void;
}

export function useDocHistory<T>(initial: T, maxDepth: number = DEFAULT_HISTORY_DEPTH): UseDocHistoryReturn<T> {
  const [state, dispatch] = useReducer(
    reduceDocHistory as React.Reducer<DocHistoryState<T>, DocHistoryAction<T>>,
    initial,
    (init) => initDocHistory(init, maxDepth),
  );

  const setDoc = useCallback<UseDocHistoryReturn<T>['setDoc']>((next, opts) => {
    const commit = opts?.commit ?? true;
    dispatch({ kind: commit ? 'commit' : 'live', next });
  }, []);

  const beginBatch = useCallback(() => dispatch({ kind: 'beginBatch' }), []);
  const undo = useCallback(() => dispatch({ kind: 'undo' }), []);
  const redo = useCallback(() => dispatch({ kind: 'redo' }), []);
  const reset = useCallback((next: T) => dispatch({ kind: 'reset', next }), []);

  return {
    current: docHistoryCurrent(state),
    pointer: state.pointer,
    size: state.stack.length,
    canUndo: docHistoryCanUndo(state),
    canRedo: docHistoryCanRedo(state),
    setDoc,
    beginBatch,
    undo,
    redo,
    reset,
  };
}
