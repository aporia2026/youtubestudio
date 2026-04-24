'use client';

// Shared client-side helpers so every feature page can preload from a linked
// schedule item and write back its output. Keeps the URL-param name + fetch
// shape consistent across pages; any feature that adopts this stays wired
// end-to-end with the schedule.
//
// Contract:
//   1. Feature page reads `?scheduleItemId=xxx` from the URL.
//   2. Calls `fetchScheduleItem(id)` once to preload state.
//   3. On the user's "done" moment, calls `writeBackToSchedule(id, patch, opts)`
//      with whatever artifact was produced.
//
// Status auto-advance: only forward, only when the current status is strictly
// earlier in the pipeline than the target. Always toasts with an Undo action
// so a wrong auto-advance is one click away from being reverted.

import { toast } from 'sonner';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';

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

/** Return the position of a status key in the channel's pipeline, or -1 if missing. */
function statusIndex(statuses: ScheduleStatus[] | undefined, key: string): number {
  if (!statuses || statuses.length === 0) {
    // Fall back to the default global order if the caller didn't pass statuses.
    const defaults = ['idea', 'scripting', 'recording', 'editing', 'ready', 'published'];
    return defaults.indexOf(key);
  }
  return statuses.findIndex(s => s.key === key);
}

export interface WriteBackOptions {
  /** Status key to advance to, if the item's current status is strictly earlier. */
  autoAdvanceTo?: string;
  /** Known status pipeline for ordering decisions. If omitted, a default global order is assumed. */
  statuses?: ScheduleStatus[];
  /** Label for the toast on auto-advance. Defaults to "Moved to <label>". */
  advanceMessage?: string;
  /** Shallow-merged into `custom_fields` so features can stamp their artifacts
   *  (e.g. latest_qa, production_doc_id) without overwriting other features'
   *  keys. Merge is top-level only; nested objects are replaced. */
  customFieldsMerge?: Record<string, unknown>;
}

/** PATCH the schedule item with `patch`, then (optionally) auto-forward its
 *  status. Returns true on success. The undo path is best-effort — if the
 *  revert PATCH fails, the toast simply stays dismissed and the user can drag
 *  the card back manually. */
export async function writeBackToSchedule(
  itemId: string,
  patch: Record<string, unknown>,
  opts: WriteBackOptions = {},
): Promise<boolean> {
  try {
    // Fetch current status so we can decide on auto-advance without trusting
    // whatever stale copy the caller may have.
    const current = await fetchScheduleItem(itemId);
    if (!current) {
      // The item may have been deleted since the feature page opened. Warn
      // once rather than silently dropping the artifact.
      toast.warning('Linked schedule item is gone — not writing back');
      return false;
    }

    let nextPatch = { ...patch };
    if (opts.customFieldsMerge) {
      const existing = (current.custom_fields ?? {}) as Record<string, unknown>;
      nextPatch = { ...nextPatch, custom_fields: { ...existing, ...opts.customFieldsMerge } };
    }
    let advanced = false;
    let prevStatus: string | null = null;
    if (opts.autoAdvanceTo) {
      const fromIdx = statusIndex(opts.statuses, current.status);
      const toIdx = statusIndex(opts.statuses, opts.autoAdvanceTo);
      if (fromIdx >= 0 && toIdx > fromIdx) {
        nextPatch = { ...nextPatch, status: opts.autoAdvanceTo };
        advanced = true;
        prevStatus = current.status;
      }
    }

    const res = await fetch(`/api/schedule/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextPatch),
    });
    if (!res.ok) {
      toast.error('Could not update the linked schedule item');
      return false;
    }

    if (advanced && prevStatus) {
      const label = opts.advanceMessage ?? `Moved to ${opts.statuses?.find(s => s.key === opts.autoAdvanceTo)?.label ?? opts.autoAdvanceTo}`;
      toast.success(label, {
        action: {
          label: 'Undo',
          onClick: async () => {
            await fetch(`/api/schedule/${itemId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: prevStatus }),
            });
            toast.message('Undone');
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
