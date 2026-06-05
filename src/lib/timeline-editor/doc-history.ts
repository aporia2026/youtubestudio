/**
 * Pure reducer for the timeline editor's undo/redo stack. The hook
 * in `./use-doc-history.ts` wraps this in `useState`; the tests
 * exercise the reducer directly so we don't need a React renderer.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md (M5).
 */

export const DEFAULT_HISTORY_DEPTH = 50;

export interface DocHistoryState<T> {
  /** Past + present + future, in chronological order. */
  stack: T[];
  /** Index of the entry currently shown to the user. */
  pointer: number;
  /** Cap on stack length. Older entries get dropped from the
   *  front when this is exceeded. */
  maxDepth: number;
}

export type DocHistoryAction<T> =
  /** Replace the head WITHOUT advancing the pointer. Used during
   *  a drag so the preview can update on every tick without
   *  pushing one entry per pixel of movement. */
  | { kind: 'live'; next: T }
  /** Truncate everything ahead of the pointer, push the new
   *  value, advance. Stack is clipped to maxDepth. */
  | { kind: 'commit'; next: T }
  /** Push the CURRENT head as a duplicate entry and advance the
   *  pointer. Used at the start of a drag so the pre-drag state
   *  is preserved in history while subsequent 'live' actions
   *  mutate the new head. Without this, drag-resize would lose
   *  the pre-drag state because every live tick replaces the
   *  head in place. */
  | { kind: 'beginBatch' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  /** Throw the entire stack away and start over at `next`. */
  | { kind: 'reset'; next: T };

/** Build the initial reducer state for a single-element stack. */
export function initDocHistory<T>(initial: T, maxDepth: number = DEFAULT_HISTORY_DEPTH): DocHistoryState<T> {
  return { stack: [initial], pointer: 0, maxDepth };
}

/** Pure reducer — same value in, same value out, no side effects. */
export function reduceDocHistory<T>(state: DocHistoryState<T>, action: DocHistoryAction<T>): DocHistoryState<T> {
  switch (action.kind) {
    case 'live': {
      const head = state.stack[state.pointer];
      if (head === action.next) return state;
      const stack = state.stack.slice();
      stack[state.pointer] = action.next;
      return { ...state, stack };
    }
    case 'commit': {
      const head = state.stack[state.pointer];
      if (head === action.next) return state;
      // Drop anything ahead of the pointer (the redo branch is
      // invalidated by a new commit) and push the new value.
      const truncated = state.stack.slice(0, state.pointer + 1);
      truncated.push(action.next);
      // Clip from the front if we've exceeded the depth cap. We
      // keep the most recent N entries, which means the pointer
      // shifts left when we drop something.
      let stack = truncated;
      let pointer = state.pointer + 1;
      if (truncated.length > state.maxDepth) {
        const drop = truncated.length - state.maxDepth;
        stack = truncated.slice(drop);
        pointer = Math.max(0, pointer - drop);
      }
      return { ...state, stack, pointer };
    }
    case 'beginBatch': {
      // Duplicate the head and advance the pointer. The new head
      // is what subsequent `live` actions will mutate; the old
      // head remains one entry behind so undo lands the user at
      // the pre-batch state. Truncate the redo branch first
      // (any forward history is invalidated by starting a new
      // batch). Then clip from the front if we've exceeded depth.
      const truncated = state.stack.slice(0, state.pointer + 1);
      truncated.push(truncated[truncated.length - 1]);
      let stack = truncated;
      let pointer = state.pointer + 1;
      if (truncated.length > state.maxDepth) {
        const drop = truncated.length - state.maxDepth;
        stack = truncated.slice(drop);
        pointer = Math.max(0, pointer - drop);
      }
      return { ...state, stack, pointer };
    }
    case 'undo': {
      if (state.pointer <= 0) return state;
      return { ...state, pointer: state.pointer - 1 };
    }
    case 'redo': {
      if (state.pointer >= state.stack.length - 1) return state;
      return { ...state, pointer: state.pointer + 1 };
    }
    case 'reset': {
      return { ...state, stack: [action.next], pointer: 0 };
    }
  }
}

/** Convenience: current visible value at the pointer. */
export function docHistoryCurrent<T>(state: DocHistoryState<T>): T {
  return state.stack[state.pointer];
}

export function docHistoryCanUndo<T>(state: DocHistoryState<T>): boolean {
  return state.pointer > 0;
}

export function docHistoryCanRedo<T>(state: DocHistoryState<T>): boolean {
  return state.pointer < state.stack.length - 1;
}
