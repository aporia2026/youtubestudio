/**
 * Same-browser instant sync for project payloads.
 *
 * Phase 2 of `_plans/2026-06-05-strengthen-doc-editor-sync.md`.
 *
 * When the user has the production-doc page open in one tab and the
 * editor open in another tab of the same browser, the cross-tab
 * version poll (`use-project.ts`) takes up to 8 s to surface a change.
 * `BroadcastChannel` collapses that to <50 ms: the saving tab posts a
 * one-line message after each successful PATCH; receiving tabs read
 * it on their event loop and pull the fresh payload immediately.
 *
 * This file owns the message shape, channel naming, and the decision
 * function that maps an incoming message → an action the hook should
 * take. Pure logic — no DOM, no React, no `BroadcastChannel` API
 * references — so it's vitest-testable in node without jsdom plumbing.
 *
 * Security note (rule 13): `BroadcastChannel` is same-origin only —
 * browsers enforce this at the channel boundary. A page on another
 * origin cannot subscribe to `project:<id>` from `youtubestudio.app`.
 * The hook still validates every incoming message via the decision
 * function below, so a buggy or malicious in-process script cannot
 * sneak an unexpected shape past the consumer.
 */

/** One-line message the saving tab posts after each successful PATCH. */
export interface ProjectPatchedBroadcast {
  type: 'patched';
  /** Per-tab id (random, stable for the tab's lifetime). The receiving
   *  handler ignores messages where `tabId` matches its own so the
   *  sender doesn't process its own broadcast. */
  tabId: string;
  /** The version the server returned on PATCH success. The receiver
   *  compares against its own `versionRef.current` to skip stale
   *  broadcasts that arrived after a more recent reload. */
  version: number;
}

/** Decision the consumer should take after observing a broadcast. */
export type BroadcastDecision =
  | { kind: 'ignore'; reason: 'self' | 'stale' | 'malformed' }
  | { kind: 'reload' }
  | { kind: 'conflict' };

/** Stable channel name. Keyed by projectId so two unrelated projects
 *  open in the same browser don't cross-talk. */
export function broadcastChannelName(projectId: string): string {
  return `project:${projectId}`;
}

/** Mint a fresh tab id. Caller stores it in a ref for the tab's life. */
export function newTabId(): string {
  return `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/**
 * Map an incoming `BroadcastChannel` message → an action.
 *
 * Pure function — the hook wires it into the channel's `onmessage`,
 * the test suite calls it directly. No DOM dependency.
 *
 * @param data           The raw `event.data` payload (unknown shape).
 * @param myTabId        This tab's id; messages with a matching `tabId`
 *                       are silently ignored (self-broadcasts).
 * @param localVersion   The hook's `versionRef.current` at the moment
 *                       the message lands. `null` means the initial
 *                       load hasn't finished — treat any patched
 *                       broadcast as fresh.
 * @param isDirty        Whether the receiving tab has unsaved local
 *                       edits. When true and the message indicates a
 *                       newer remote version, the action is
 *                       `'conflict'` instead of `'reload'`.
 */
export function decideBroadcastAction(
  data: unknown,
  myTabId: string,
  localVersion: number | null,
  isDirty: boolean,
): BroadcastDecision {
  if (!data || typeof data !== 'object') {
    return { kind: 'ignore', reason: 'malformed' };
  }
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'patched') {
    return { kind: 'ignore', reason: 'malformed' };
  }
  if (obj.tabId === myTabId) {
    return { kind: 'ignore', reason: 'self' };
  }
  if (typeof obj.version !== 'number' || !Number.isFinite(obj.version)) {
    return { kind: 'ignore', reason: 'malformed' };
  }
  if (typeof obj.tabId !== 'string' || obj.tabId.length === 0) {
    return { kind: 'ignore', reason: 'malformed' };
  }
  // A broadcast we've already caught up past (e.g., we reloaded before
  // the broadcast handler ran). Skip the redundant fetch.
  if (localVersion !== null && obj.version <= localVersion) {
    return { kind: 'ignore', reason: 'stale' };
  }
  // Fresh remote version + local dirty edits: same UX as the 8s poll's
  // "different AND dirty" path — flip to conflict so the consumer can
  // surface a banner. Phase 3 narrows this to real overlaps.
  if (isDirty) {
    return { kind: 'conflict' };
  }
  return { kind: 'reload' };
}
