/**
 * localStorage-backed draft storage for the editor.
 *
 * When the editor crashes (React error, unexpected throw, browser
 * tab killed) BEFORE the 800ms autosave debounce can fire its PATCH,
 * the user loses every edit they made since the last successful save.
 * The right backstop is a synchronous mirror of the dirty state into
 * localStorage on every dispatch, so a fresh mount can detect a
 * stale draft and offer to restore it.
 *
 * Why localStorage and not IndexedDB:
 *   - Writes are synchronous. We need the mirror to land BEFORE the
 *     potentially-throwing render cycle continues.
 *   - The serialized state for a typical project is well under 1 MB
 *     (the 5 MB cap most browsers expose is plenty).
 *   - The recovery API is read-once, no transactions / queries.
 *
 * Storage shape — per-project keyed string under
 * `editor:draft:<projectId>`. Value is JSON with a thin envelope so
 * future versions can migrate the payload without leaking format
 * details to callers.
 *
 *   {
 *     "v": 1,
 *     "savedAt": <epoch ms>,
 *     "baseVersion": <state.version snapshot was taken from>,
 *     "payload": <persistableFromState output>
 *   }
 *
 * Pure module — every function takes / returns plain data; the
 * caller is responsible for SSR-guarding the localStorage access.
 */

import type { ProductionDoc, RowOverlayRenderState, RowVideoClipState } from '@/remotion/utils';

/** Persistable payload — same shape `persistableFromState` returns,
 *  re-stated here so this module doesn't depend on the store. */
export interface DraftPayload {
  doc: ProductionDoc;
  rowImages: Record<number, string>;
  voiceoverUrl?: string;
  captions?: unknown;
  rowOverlays?: Record<number, RowOverlayRenderState>;
  rowVideoClips?: Record<number, RowVideoClipState>;
  musicUrl?: string;
  brandKitOverride?: unknown;
  channelId?: string;
  voiceoverAlignment?: unknown;
  flags?: unknown;
  linkedProjectId?: string;
  linkedScheduleItemId?: string;
  visualKitOverride?: unknown;
}

export interface DraftEnvelope {
  /** Schema version — bump when the payload shape evolves. */
  v: 1;
  /** Epoch ms when this draft was written. */
  savedAt: number;
  /** The doc's server-version the unsaved edits sit on top of. The
   *  recovery decision compares this against the freshly-loaded
   *  version: stale (server moved past it) means we can't safely
   *  restore. */
  baseVersion: number;
  payload: DraftPayload;
}

const STORAGE_PREFIX = 'editor:draft:';

/** Stable storage key — exported so tests + the optional discard
 *  UI can target it without recreating the prefix. */
export function draftStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

/** Serialise + write. Catches QuotaExceededError so a too-large doc
 *  doesn't crash the editor — returns false instead. Caller can log
 *  + degrade gracefully (the in-memory state is still intact; only
 *  crash-survival is lost). */
export function writeDraft(
  projectId: string,
  envelope: DraftEnvelope,
): { ok: true } | { ok: false; reason: 'no-storage' | 'serialise-failed' | 'quota' } {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return { ok: false, reason: 'no-storage' };
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(envelope);
  } catch {
    return { ok: false, reason: 'serialise-failed' };
  }
  try {
    localStorage.setItem(draftStorageKey(projectId), serialised);
    return { ok: true };
  } catch {
    // QuotaExceededError or a private-mode block — same outcome.
    return { ok: false, reason: 'quota' };
  }
}

/** Read + parse + validate. Returns null when no draft exists, the
 *  stored value is malformed, or the envelope's schema version is
 *  unrecognised. */
export function readDraft(projectId: string): DraftEnvelope | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return null;
  }
  const raw = localStorage.getItem(draftStorageKey(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const env = parsed as Partial<DraftEnvelope>;
    if (env.v !== 1) return null;
    if (typeof env.savedAt !== 'number' || !Number.isFinite(env.savedAt)) return null;
    if (typeof env.baseVersion !== 'number' || !Number.isFinite(env.baseVersion)) return null;
    if (!env.payload || typeof env.payload !== 'object') return null;
    const payload = env.payload as Partial<DraftPayload>;
    if (!payload.doc || typeof payload.doc !== 'object') return null;
    return env as DraftEnvelope;
  } catch {
    return null;
  }
}

/** Drop the draft. Called after a successful server save (the draft
 *  has been superseded) or when the user explicitly discards on
 *  recovery prompt. */
export function clearDraft(projectId: string): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(draftStorageKey(projectId));
  } catch {
    // localStorage write quirks shouldn't break the editor.
  }
}

/** Decide whether a draft should be offered for recovery, given the
 *  draft envelope and the version of the freshly-loaded server state.
 *
 *  Outcomes:
 *    - 'restore' — the draft sits on the same baseVersion the server
 *      just gave us; restoring is safe (no merging conflicts).
 *    - 'stale'   — the server moved past the draft's baseVersion
 *      while we were away. Auto-restoring would silently discard the
 *      newer server state. The caller should surface a "discard
 *      stale draft" toast instead of restoring.
 *    - 'none'    — no draft, or the draft predates the server version
 *      (shouldn't normally happen but covered for completeness).
 *
 *  Pure function — testable without touching localStorage. */
export function decideRecovery(
  draft: DraftEnvelope | null,
  serverVersion: number,
): 'restore' | 'stale' | 'none' {
  if (!draft) return 'none';
  if (draft.baseVersion === serverVersion) return 'restore';
  if (draft.baseVersion < serverVersion) return 'stale';
  // draft.baseVersion > serverVersion — should not happen, but if it
  // does (clock skew, replicated DB rollback) treat as stale: the
  // server is the source of truth.
  return 'stale';
}
