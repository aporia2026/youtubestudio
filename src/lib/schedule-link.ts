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
import type { ChecklistItem, ScheduleItem } from '@/lib/schedule';

export const SCHEDULE_LINK_PARAM = 'scheduleItemId';

/** Everything a downstream feature page might want to prefill from a linked
 *  schedule item, derived in one place so each page doesn't reinvent its own
 *  field-picking logic. All entries are nullable/empty-default so callers can
 *  pass `(curr) => curr || ctx.x` and never overwrite user-typed input. */
export interface ScheduleItemContext {
  item: ScheduleItem;
  topic: string;
  niche: string;
  notes: string;
  script: string | null;
  prevDescription: string;
  prevTags: string[];
  freeformTags: string[];
  series: { id: string; title: string; partNumber: number } | null;
  editor: { id: string; name: string; channelId: string | null } | null;
  youtubeUrl: string;
  thumbnails: { aUrl: string | null; bUrl: string | null; winner: 'a' | 'b' | null };
  checklist: ChecklistItem[];
  /** Most recent recorded voiceover duration for this item's project, in
   *  seconds. Null when the project has no voiceover, has only voiceovers
   *  saved before duration capture was wired (older ElevenLabs path), or
   *  the item has no project at all. Consumers format as mm:ss themselves. */
  voiceoverDurationSeconds: number | null;
}

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
 *  If the item has no `project_id` but does carry a pinned `script_id`
 *  (rare orphan state — scripts normally auto-create a project on first
 *  save), fall back to `/api/scripts/[id]` so the script still loads.
 *
 *  Returns null (not throws) on any failure so callers can fall through to
 *  their own defaults. Used by QA / SEO / Production Doc preload flows so
 *  they don't each reinvent the same fetch + narrow logic. */
export async function loadActiveScriptForItem(item: ScheduleItem): Promise<string | null> {
  if (item.project_id) {
    try {
      const res = await fetch(`/api/projects/${item.project_id}/scripts`);
      if (res.ok) {
        const data = await res.json();
        type ScriptRow = { id: string; content: string; is_active?: boolean };
        const list: ScriptRow[] = Array.isArray(data.scripts) ? data.scripts : [];
        const active = list.find(s => s.id === item.script_id)
                    ?? list.find(s => s.is_active)
                    ?? list[0];
        if (active?.content) return active.content;
      }
    } catch {
      // fall through to the direct-script path
    }
  }
  if (item.script_id) {
    try {
      const res = await fetch(`/api/scripts/${item.script_id}`);
      if (!res.ok) return null;
      const data = await res.json();
      return (data?.script?.content as string | undefined) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Find the most recent voiceover asset's duration (seconds) for a project.
 *  Used by Production Doc to seed the "actual duration" speaking-pace input
 *  so the user doesn't retype what we already recorded. Returns null when
 *  there's no voiceover, when none of the rows have a duration_seconds (the
 *  legacy ElevenLabs save path didn't persist it), or on any fetch failure. */
async function loadLatestVoiceoverDuration(projectId: string): Promise<number | null> {
  try {
    const res = await fetch(`/api/projects/${projectId}/media`);
    if (!res.ok) return null;
    const data = await res.json();
    type MediaRow = { type?: string; duration_seconds?: number | null; created_at?: string };
    const assets: MediaRow[] = Array.isArray(data?.assets) ? data.assets : [];
    // The endpoint returns DESC by created_at, so the first row with a real
    // duration is the most recent recording we can use. Avoid Number(null)
    // (which yields 0 — would render a misleading "0:00 actual").
    for (const a of assets) {
      if (a?.type !== 'voiceover') continue;
      const d = a?.duration_seconds;
      if (typeof d === 'number' && d > 0) return Math.round(d);
    }
    return null;
  } catch {
    return null;
  }
}

export interface LoadContextOptions {
  /** Pull the project's active script (one extra GET). Defaults to true.
   *  Pages that won't display the script (Ideas) should pass false to avoid
   *  the wasted round-trip. */
  withScript?: boolean;
  /** Pull the project's most recent voiceover duration (one extra GET).
   *  Defaults to false because only Production Doc displays a speaking-pace
   *  readout; other pages would pay for the round-trip and discard it. */
  withVoiceoverDuration?: boolean;
}

/** Build the full prefill context for a schedule item: optionally pulls the
 *  linked script and projects every relevant item field into a predictable
 *  shape. Returns empty strings/null rather than throwing so callers can
 *  `setX(curr => curr || ctx.x)` without conditional guards. */
export async function loadFullContextForItem(
  item: ScheduleItem,
  opts: LoadContextOptions = {},
): Promise<ScheduleItemContext> {
  const withScript = opts.withScript !== false;
  const withVoiceoverDuration = opts.withVoiceoverDuration === true;
  // Both side-channel fetches are independent of each other and of the item
  // payload that's already in hand — fire them in parallel so the preload
  // round-trip stays one wave deep.
  const [script, voiceoverDurationSeconds] = await Promise.all([
    withScript ? loadActiveScriptForItem(item) : Promise.resolve(null),
    withVoiceoverDuration && item.project_id
      ? loadLatestVoiceoverDuration(item.project_id)
      : Promise.resolve(null),
  ]);
  // Niche resolution: item.pillar is the per-item override the user typed on
  // the schedule item; the linked channel's niche is the workspace-level
  // fallback. Pillar wins when set so per-item overrides aren't silently
  // replaced by the channel default.
  const pillar = item.pillar?.trim();
  const channelNiche = item.channels?.find(c => c.niche && c.niche.trim())?.niche?.trim();
  return {
    item,
    topic: item.title,
    niche: pillar || channelNiche || '',
    notes: item.notes ?? '',
    script,
    prevDescription: item.yt_description ?? '',
    prevTags: Array.isArray(item.yt_tags) ? item.yt_tags : [],
    freeformTags: Array.isArray(item.tags) ? item.tags : [],
    series: item.series_id
      ? {
          id: item.series_id,
          title: item.series_title ?? '',
          partNumber: item.part_number ?? 1,
        }
      : null,
    editor: item.editor_id
      ? {
          id: item.editor_id,
          name: item.editor_name ?? '',
          channelId: item.editor_channel_id ?? null,
        }
      : null,
    youtubeUrl: item.youtube_url ?? '',
    thumbnails: {
      aUrl: item.thumbnail_a_url ?? null,
      bUrl: item.thumbnail_b_url ?? null,
      winner: item.thumbnail_winner ?? null,
    },
    checklist: Array.isArray(item.checklist) ? item.checklist : [],
    voiceoverDurationSeconds,
  };
}

/** Compose a single "background context" string from the schedule item — used
 *  by features that take freeform text (Generator's `context`, Production
 *  Doc's brief input). Only includes fields that are actually present. */
export function buildContextNotesFromItem(ctx: ScheduleItemContext): string {
  const parts: string[] = [];
  if (ctx.notes) parts.push(ctx.notes);
  if (ctx.series) parts.push(`Series: ${ctx.series.title} (Part ${ctx.series.partNumber})`);
  if (ctx.freeformTags.length) parts.push(`Tags: ${ctx.freeformTags.join(', ')}`);
  if (ctx.youtubeUrl) parts.push(`Published video: ${ctx.youtubeUrl}`);
  if (ctx.editor?.name) parts.push(`Editor: ${ctx.editor.name}`);
  if (ctx.checklist.length) {
    const open = ctx.checklist.filter(c => !c.done).map(c => `• ${c.text}`);
    if (open.length) parts.push(`Open checklist:\n${open.join('\n')}`);
  }
  return parts.join('\n\n');
}
