/**
 * In-memory presence store: "who has this video open right now?"
 *
 * Scope: process-local. On Vercel, every function instance has its own
 * Map — a heartbeat from instance A is not visible to a snapshot from
 * instance B. For a single-user workspace this is fine. For a small
 * team that gets sharded across instances it's best-effort.
 *
 * If multi-instance correctness becomes important, move to Upstash Redis
 * with the same API shape (no callers change) — see the QA hardening
 * plan's rule-8 note about pricing.
 *
 * Heartbeat contract:
 *   - Client POSTs to /api/workspace/presence/heartbeat every ~20s with
 *     { videoId } (or null when leaving a tool page). The endpoint records
 *     (workspaceId, videoId, userId, lastSeen=now).
 *   - Client GETs /api/workspace/presence/snapshot to fetch the current
 *     map for the whole workspace. The Command Center polls this.
 *   - Entries older than PRESENCE_TTL_MS are swept on every read.
 */

import { logger } from './logger';

export const PRESENCE_TTL_MS = 60_000; // 1 minute — heartbeat every 20s should easily refresh

export interface PresenceEntry {
  userId: string;
  name: string | null;
  color: string | null;
  lastSeen: number;
}

/** Map<workspaceId, Map<videoId, Map<userId, PresenceEntry>>> */
const store: Map<string, Map<string, Map<string, PresenceEntry>>> = new Map();

/**
 * Record a heartbeat. Replaces any prior entry for the same (workspace,
 * video, user) tuple — `lastSeen` is always the most recent ping.
 */
export function recordPresence(args: {
  workspaceId: string;
  videoId: string;
  userId: string;
  name: string | null;
  color: string | null;
}): void {
  const { workspaceId, videoId, userId, name, color } = args;
  let wsMap = store.get(workspaceId);
  if (!wsMap) {
    wsMap = new Map();
    store.set(workspaceId, wsMap);
  }
  let videoMap = wsMap.get(videoId);
  if (!videoMap) {
    videoMap = new Map();
    wsMap.set(videoId, videoMap);
  }
  videoMap.set(userId, { userId, name, color, lastSeen: Date.now() });
}

/**
 * Drop a user's presence from the previous video (called by the client
 * when it switches video or leaves the tool page). Idempotent.
 */
export function clearPresenceForUser(args: { workspaceId: string; userId: string }): void {
  const wsMap = store.get(args.workspaceId);
  if (!wsMap) return;
  for (const videoMap of wsMap.values()) {
    videoMap.delete(args.userId);
  }
}

/**
 * Snapshot of every active presence in the workspace, with expired
 * entries swept on the way out. Returns Map<videoId, PresenceEntry[]>.
 */
export function snapshotWorkspacePresence(workspaceId: string): Record<string, PresenceEntry[]> {
  const wsMap = store.get(workspaceId);
  if (!wsMap) return {};
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  const result: Record<string, PresenceEntry[]> = {};
  for (const [videoId, videoMap] of wsMap.entries()) {
    const fresh: PresenceEntry[] = [];
    for (const [userId, entry] of videoMap.entries()) {
      if (entry.lastSeen >= cutoff) {
        fresh.push(entry);
      } else {
        videoMap.delete(userId);
      }
    }
    if (fresh.length > 0) {
      result[videoId] = fresh;
    }
  }
  return result;
}

/** Snapshot for a single video — used by the VideoContextStrip's badge. */
export function presenceForVideo(workspaceId: string, videoId: string): PresenceEntry[] {
  const wsMap = store.get(workspaceId);
  if (!wsMap) return [];
  const videoMap = wsMap.get(videoId);
  if (!videoMap) return [];
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  const fresh: PresenceEntry[] = [];
  for (const [userId, entry] of videoMap.entries()) {
    if (entry.lastSeen >= cutoff) {
      fresh.push(entry);
    } else {
      videoMap.delete(userId);
    }
  }
  return fresh;
}

/**
 * Periodic sweep: removes the entire workspace bucket if it has no
 * fresh entries. Not strictly necessary (snapshots do per-video sweep)
 * but keeps the store from accumulating empty buckets over long uptimes.
 * Called on every heartbeat with throttling so we don't churn.
 */
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 min
export function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  const cutoff = now - PRESENCE_TTL_MS;
  let removed = 0;
  for (const [wsId, wsMap] of store.entries()) {
    for (const [videoId, videoMap] of wsMap.entries()) {
      for (const [userId, entry] of videoMap.entries()) {
        if (entry.lastSeen < cutoff) {
          videoMap.delete(userId);
          removed++;
        }
      }
      if (videoMap.size === 0) wsMap.delete(videoId);
    }
    if (wsMap.size === 0) store.delete(wsId);
  }
  if (removed > 0) {
    logger.info('[presence sweep]', { removed_entries: removed });
  }
}
