'use client';

/**
 * React adapter for the shot-graph editor store.
 *
 * Wraps `applyCommand` (pure logic in `./store.ts`) in a `useReducer`
 * so consumers can dispatch commands ergonomically. Phase 1 uses
 * plain React; if Phase 2's cross-component access needs grow beyond
 * what context-via-hook gives us, swap the internals to Zustand
 * without changing the consumer surface. That's why callers should
 * always import this hook, never `useReducer` + `applyCommand`
 * directly.
 */
import { useCallback, useReducer } from 'react';
import { applyCommand, type EditorCommand, type EditorState } from './store';

export interface UseEditorStoreReturn {
  state: EditorState;
  apply: (cmd: EditorCommand) => void;
}

export function useEditorStore(initial: EditorState): UseEditorStoreReturn {
  const [state, dispatch] = useReducer(
    (s: EditorState, cmd: EditorCommand) => applyCommand(s, cmd),
    initial,
  );
  const apply = useCallback((cmd: EditorCommand) => {
    console.info('[editor store] command', { type: cmd.type });
    dispatch(cmd);
  }, []);
  return { state, apply };
}
