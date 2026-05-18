/**
 * Save-client for the shot-graph editor.
 *
 * Phase 2 of `_plans/2026-05-18-shot-graph-editor.md`. Wraps the
 * PATCH /api/editor/:projectId call with a discriminated result
 * union so the caller can branch on success / conflict / failure
 * without parsing strings.
 *
 * Decoupled from React deliberately — this module is testable
 * standalone and the React adapter (`use-editor-store.tsx`) just
 * sequences calls into the store.
 */
import type { ProductionDoc } from '@/remotion/utils';

export interface EditorSavePayload {
  doc: ProductionDoc;
  rowImages: Record<number, string>;
  voiceoverUrl?: string;
}

export type SaveResult =
  | { kind: 'saved'; version: number }
  | { kind: 'conflict'; currentVersion: number; currentPayload: unknown }
  | { kind: 'gone' }
  | { kind: 'error'; message: string };

/**
 * PATCH the editor's payload to the server. Optimistic-locked: the
 * caller passes the version it read from the load. Server bumps
 * version + 1 on success and returns the new value; on a stale
 * version it returns 409 + the current row.
 *
 * Network/JSON failures collapse to `{ kind: 'error' }`. The store
 * branches on the result and never throws into the React tree —
 * a failed save is a status indicator, not a crash.
 */
export async function saveEditorPayload(args: {
  projectId: string;
  version: number;
  payload: EditorSavePayload;
  signal?: AbortSignal;
}): Promise<SaveResult> {
  const { projectId, version, payload, signal } = args;
  try {
    const res = await fetch(`/api/edit/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, payload }),
      signal,
    });

    if (res.status === 200) {
      const data = (await res.json()) as { version?: unknown };
      if (typeof data.version === 'number' && Number.isFinite(data.version)) {
        return { kind: 'saved', version: data.version };
      }
      return { kind: 'error', message: 'Server response missing version' };
    }

    if (res.status === 409) {
      const data = (await res.json()) as { currentVersion?: unknown; currentPayload?: unknown };
      const currentVersion =
        typeof data.currentVersion === 'number' && Number.isFinite(data.currentVersion)
          ? data.currentVersion
          : version + 1;
      return {
        kind: 'conflict',
        currentVersion,
        currentPayload: data.currentPayload ?? null,
      };
    }

    if (res.status === 404) {
      return { kind: 'gone' };
    }

    const text = await res.text().catch(() => '');
    return { kind: 'error', message: text || `Save failed: HTTP ${res.status}` };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { kind: 'error', message: 'aborted' };
    }
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
