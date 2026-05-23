/**
 * Shared types between the History API (`/api/edit/[projectId]/generation-events`)
 * and the editor client. Kept in a separate file from `generation-events.ts`
 * so server-side code can import the types without pulling in the
 * `fetch` wrapper (which would force a client bundle inclusion).
 */

export type GenerationEventType = 'generate' | 'regenerate';
export type GenerationStatus = 'generating' | 'ready' | 'failed';

export interface GenerationEvent {
  id: string;
  rowIndex: number;
  brollClipId: string;
  modelId: string;
  eventType: GenerationEventType;
  status: GenerationStatus;
  errorMessage: string | null;
  promptExcerpt: string | null;
  createdAt: string;        // ISO timestamp
  completedAt: string | null;
  /** True when the GET endpoint reconciled a stuck `generating` entry
   *  by reading the underlying broll_clips row. The History panel may
   *  surface a small "(reconciled)" marker so the user knows the
   *  status didn't come from a live PATCH. */
  reconciled: boolean;
}
