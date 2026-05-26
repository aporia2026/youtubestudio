'use client';

/**
 * usePresenceHeartbeat — keeps the workspace's presence store fresh for
 * the current video. Pulse every ~20s while mounted; on unmount, send
 * a clear so the badge drops off other people's snapshots within a
 * heartbeat window.
 *
 * Returns the latest workspace snapshot so callers can render badges
 * for ANY video (the heartbeat response includes the full snapshot).
 */

import { useEffect, useState } from 'react';

const HEARTBEAT_MS = 20_000;

export interface PresenceEntry {
  userId: string;
  name: string | null;
  color: string | null;
  lastSeen: number;
}

export interface PresenceSnapshot {
  [videoId: string]: PresenceEntry[];
}

export function usePresenceHeartbeat(videoId: string | null): PresenceSnapshot {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot>({});

  useEffect(() => {
    // Immediate pulse + interval thereafter. We always send: when videoId
    // is null we send { videoId: null } which clears prior presence on
    // the server. That way navigating off a tool page drops the badge.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pulse() {
      try {
        const res = await fetch('/api/workspace/presence/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setSnapshot((data?.presence as PresenceSnapshot) ?? {});
        }
      } catch {
        // silent — best-effort
      }
    }

    void pulse();
    timer = setInterval(pulse, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      // Fire one final clear so other tabs see the badge drop fast.
      // Best-effort, no await on unmount.
      void fetch('/api/workspace/presence/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: null }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [videoId]);

  return snapshot;
}

/**
 * Read-only polling variant — used by surfaces that aren't on a tool
 * page (the Command Center kanban). Polls the snapshot endpoint at
 * the same cadence and DOES NOT register the caller's own presence.
 */
export function usePresenceSnapshot(): PresenceSnapshot {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot>({});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pull() {
      try {
        const res = await fetch('/api/workspace/presence/snapshot');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setSnapshot((data?.presence as PresenceSnapshot) ?? {});
        }
      } catch {
        // silent
      }
    }

    void pull();
    timer = setInterval(pull, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return snapshot;
}
