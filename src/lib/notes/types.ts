/**
 * Public types for the notes-while-watching feature. Shared between the
 * REST endpoints (which produce these shapes) and every UI component
 * that consumes them. Keep this file free of React or DOM dependencies
 * so the server can import it too.
 */

export const NOTE_TAGS = ['R', 'T', 'S', 'I', 'P', 'Q'] as const;
export type NoteTag = (typeof NOTE_TAGS)[number];

/** One-letter tag → human label, used in tooltips, the review queue, and
 *  the Markdown export. The full list is intentionally short — six
 *  categories is what a single-creator workflow actually needs. */
export const NOTE_TAG_LABEL: Record<NoteTag, string> = {
  R: 'Regenerate',
  T: 'Timing',
  S: 'Script / VO',
  I: 'Idea',
  P: 'Polish',
  Q: 'Question',
};

/** Tag → color used by the dock chips + the timeline strip ticks. Picked
 *  so each tag stays distinguishable at the small sizes the UI uses. */
export const NOTE_TAG_COLOR: Record<NoteTag, string> = {
  R: '#f87171', // red — wants regeneration / fix
  T: '#fbbf24', // amber — timing
  S: '#60a5fa', // blue — script / VO
  I: '#a78bfa', // purple — idea
  P: '#34d399', // green — polish
  Q: '#9ca3af', // gray — question
};

export interface ProductionDocNote {
  id: string;
  docId: string;
  rowIndex: number;
  sceneTsMs: number;
  text: string;
  tag: NoteTag | null;
  resolved: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Payload accepted by `useNotes().create()`. The id, timestamps, and
 *  createdBy are filled in by the server. */
export interface CreateNoteInput {
  docId: string;
  rowIndex: number;
  sceneTsMs?: number;
  text: string;
  tag?: NoteTag | null;
}

/** Patch shape accepted by `useNotes().update()`. Every field optional —
 *  only the keys present in the call are written through to the server. */
export interface UpdateNoteInput {
  text?: string;
  tag?: NoteTag | null;
  resolved?: boolean;
}
