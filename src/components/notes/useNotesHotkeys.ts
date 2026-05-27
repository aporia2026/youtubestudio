'use client';

import { useEffect } from 'react';

/**
 * Wire the global N / Shift+N hotkeys that drive the notes dock.
 *
 *   - `N`          → pause the player + open the note input. Skipped
 *                    whenever focus is inside an input / textarea /
 *                    contentEditable — otherwise it would steal the
 *                    key while the user is typing a title.
 *   - `Shift+N`    → open the Review queue (cross-doc unresolved list).
 *
 * Both are no-ops if `enabled` is false, so the host can disable the
 * shortcut globally (e.g. when a modal owns the screen).
 *
 * Tag shortcuts (R/T/S/I/P/Q) are owned by the NoteInput itself when
 * the textarea is focused — they don't need a global listener.
 */
export interface UseNotesHotkeysParams {
  enabled: boolean;
  onTakeNote: () => void;
  onOpenReviewQueue: () => void;
}

export function useNotesHotkeys({
  enabled,
  onTakeNote,
  onOpenReviewQueue,
}: UseNotesHotkeysParams): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // Skip when the user is typing into a form field. We don't
      // capture modifier-loaded combos either, except the Shift+N
      // review-queue shortcut. Cmd/Ctrl+N is a browser-level keep-out
      // (new window in most browsers); we explicitly let it through.
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;
      if (inEditable) return;

      if (e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault();
        onOpenReviewQueue();
        return;
      }
      if (!e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        onTakeNote();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onTakeNote, onOpenReviewQueue]);
}
