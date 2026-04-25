'use client';

// Shared client-side helpers so every feature page can preload from a linked
// schedule item and write back its output. Keeps the URL-param name + fetch
// shape consistent across pages.
//
// Contract:
//   1. Feature page reads `?scheduleItemId=xxx` from the URL.
//   2. Calls `fetchScheduleItem(id)` once to preload state.
//   3. On the user's "done" moment, calls `writeBackToSchedule(id, patch, opts)`
//      with whatever artifact was produced.
//
// The server does the heavy lifting for two formerly-fragile paths:
//   - `custom_fields_merge` on PATCH shallow-merges server-side, so two
//     concurrent write-backs can't clobber each other's keys.
//   - `auto_advance_to` on PATCH evaluates the item's channel pipeline + its
//     current status in one round-trip, so the client doesn't need pipeline
//     knowledge and there's no TOCTOU.

import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';

export const SCHEDULE_LINK_PARAM = 'scheduleItemId';

export async function fetchScheduleItem(id: string): Promise<ScheduleItem | null> {
  try {
    const res = await fetch(`/api/schedule/${id}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.item as ScheduleItem) ?? null;
  } catch {
    return null;
  }
}

export interface WriteBackOptions {
  /** Status key to advance to. Server compares against the item's channel
   *  pipeline and only advances if the target is strictly later than the
   *  current status. No-op if the pipeline doesn't contain the target. */
  autoAdvanceTo?: string;
  /** Human-readable label used in the Undo toast. Defaults to the status key. */
  advanceLabel?: string;
  /** Shallow-merged into `custom_fields` server-side so features can stamp
   *  their artifacts without a read-modify-write race. */
  customFieldsMerge?: Record<string, unknown>;
}

/** PATCH the schedule item. Returns true on success. */
export async function writeBackToSchedule(
  itemId: string,
  patch: Record<string, unknown>,
  opts: WriteBackOptions = {},
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { ...patch };
    if (opts.customFieldsMerge) body.custom_fields_merge = opts.customFieldsMerge;
    if (opts.autoAdvanceTo) body.auto_advance_to = opts.autoAdvanceTo;

    const res = await fetch(`/api/schedule/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 404) {
        toast.warning('Linked schedule item is gone — not writing back');
      } else {
        toast.error('Could not update the linked schedule item');
      }
      return false;
    }

    const data: { advanced?: { prev_status: string; new_status: string } | null } = await res.json().catch(() => ({}));
    if (data.advanced) {
      const { prev_status, new_status } = data.advanced;
      const label = opts.advanceLabel ?? new_status;
      toast.success(`Moved to ${label}`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            // Re-fetch current status so a manual move between advance and
            // undo isn't silently reverted by a stale closure.
            const fresh = await fetchScheduleItem(itemId);
            if (!fresh) { toast.error('Item is gone'); return; }
            if (fresh.status !== new_status) {
              toast.message('Status already changed — nothing to undo');
              return;
            }
            const r = await fetch(`/api/schedule/${itemId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: prev_status }),
            });
            if (r.ok) toast.message('Undone');
            else toast.error('Undo failed');
          },
        },
      });
    }
    return true;
  } catch (err) {
    console.error('writeBackToSchedule', err);
    return false;
  }
}

/** Read `?scheduleItemId=…` from URLSearchParams. Centralised so typos don't
 *  silently diverge per page. */
export function getScheduleLinkId(search: URLSearchParams | null | undefined): string | null {
  const v = search?.get(SCHEDULE_LINK_PARAM);
  return v && v.length > 0 ? v : null;
}

/** Resolve the best script content associated with a schedule item:
 *  - its pinned `script_id` if present,
 *  - else the project's currently-active script,
 *  - else the first script,
 *  - else null.
 *
 *  Returns null (not throws) on any failure so callers can fall through to
 *  their own defaults. Used by QA / SEO / Production Doc preload flows so
 *  they don't each reinvent the same fetch + narrow logic. */
export async function loadActiveScriptForItem(item: ScheduleItem): Promise<string | null> {
  if (!item.project_id) return null;
  try {
    const res = await fetch(`/api/projects/${item.project_id}/scripts`);
    if (!res.ok) return null;
    const data = await res.json();
    type ScriptRow = { id: string; content: string; is_active?: boolean };
    const list: ScriptRow[] = Array.isArray(data.scripts) ? data.scripts : [];
    const active = list.find(s => s.id === item.script_id)
                ?? list.find(s => s.is_active)
                ?? list[0];
    return active?.content ?? null;
  } catch {
    return null;
  }
}
