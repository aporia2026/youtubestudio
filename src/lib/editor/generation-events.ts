/**
 * Client wrapper around `/api/edit/[projectId]/generation-events`.
 *
 * The History tab in the editor's right Inspector is the only consumer.
 * Two hot paths:
 *
 *   - `recordGenerationKickoff(...)` — fires immediately after
 *     `POST /api/broll` returns, inserts a `status='generating'` row.
 *     Returns the new event id so the caller can later PATCH it.
 *
 *   - `markGenerationEventTerminal(...)` — fires from the editor's
 *     poll loop the moment a clip resolves to `ready` / `failed`.
 *
 * Failure-mode contract: both functions **swallow all errors** and log
 * to console. Generation history is observability; an audit-log write
 * failing must NEVER block the actual clip from rendering. The poll
 * loop's terminal-state commit through `setRowVideoClip(..., false)`
 * is the source of truth for the user-visible clip — these writes are
 * a parallel side effect.
 *
 * The `eventId` returned by `recordGenerationKickoff` is also held on
 * `state.rowVideoClips[i].generationEventId` so the PATCH knows which
 * row to update even after the user reloads mid-generation (the
 * project payload's transient-state save is the bridge).
 */

import type { GenerationEvent, GenerationEventType, GenerationStatus } from './generation-events-types';

export type { GenerationEvent, GenerationEventType, GenerationStatus };

/** Kickoff insert. Best-effort — returns `null` on any failure. */
export async function recordGenerationKickoff(args: {
  projectId: string;
  rowIndex: number;
  brollClipId: string;
  modelId: string;
  eventType: GenerationEventType;
  promptExcerpt?: string;
}): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/edit/${encodeURIComponent(args.projectId)}/generation-events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rowIndex: args.rowIndex,
          brollClipId: args.brollClipId,
          modelId: args.modelId,
          eventType: args.eventType,
          promptExcerpt: args.promptExcerpt,
        }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      console.warn('[generation-events insert] http not ok', {
        rowIndex: args.rowIndex,
        brollClipId: args.brollClipId,
        httpStatus: res.status,
      });
      return null;
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      console.warn('[generation-events insert] missing id in response', { data });
      return null;
    }
    console.info('[generation-events insert] ok', {
      rowIndex: args.rowIndex,
      eventId: data.id,
      eventType: args.eventType,
      brollClipId: args.brollClipId,
      modelId: args.modelId,
    });
    return data.id;
  } catch (err) {
    console.warn('[generation-events insert] failed', {
      rowIndex: args.rowIndex,
      brollClipId: args.brollClipId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Terminal-status PATCH. Best-effort — never throws. */
export async function markGenerationEventTerminal(args: {
  projectId: string;
  eventId: string;
  status: 'ready' | 'failed';
  errorMessage?: string;
}): Promise<void> {
  try {
    const res = await fetch(
      `/api/edit/${encodeURIComponent(args.projectId)}/generation-events/${encodeURIComponent(args.eventId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: args.status,
          errorMessage: args.errorMessage,
        }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      console.warn('[generation-events update] http not ok', {
        eventId: args.eventId,
        status: args.status,
        httpStatus: res.status,
      });
      return;
    }
    console.info('[generation-events update] ok', {
      eventId: args.eventId,
      status: args.status,
    });
  } catch (err) {
    console.warn('[generation-events update] failed', {
      eventId: args.eventId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** List the project's events, newest first. Used by the History panel. */
export async function listGenerationEvents(args: {
  projectId: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<GenerationEvent[]> {
  const qs = args.limit !== undefined ? `?limit=${encodeURIComponent(args.limit)}` : '';
  const res = await fetch(
    `/api/edit/${encodeURIComponent(args.projectId)}/generation-events${qs}`,
    { cache: 'no-store', signal: args.signal },
  );
  if (!res.ok) {
    throw new Error(`History fetch failed (${res.status})`);
  }
  const data = (await res.json()) as { events?: GenerationEvent[] };
  return data.events ?? [];
}
