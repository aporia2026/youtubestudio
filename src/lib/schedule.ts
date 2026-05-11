export type ScheduleStatus = {
  key: string;
  label: string;
  color: string;
};

export type RecurrenceRule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval?: number;
  byday?: Array<'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'>;
  count?: number;
  until?: string;
};

export type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
  stage?: string; // the status this item was added for
};

export type ScheduleItem = {
  id: string;
  title: string;
  scheduled_for: string | null;
  status: string;
  notes: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  position: number;
  idea_id: string | null;
  project_id: string | null;
  script_id: string | null;
  recurrence: RecurrenceRule | null;
  recurrence_parent_id: string | null;
  created_at: string;
  updated_at: string;
  channels?: Array<{ id: string; name: string; account_color: string | null }>;
  // Extended
  stage_entered_at?: string;
  pillar?: string | null;
  checklist?: ChecklistItem[];
  thumbnail_a_url?: string | null;
  thumbnail_b_url?: string | null;
  thumbnail_winner?: 'a' | 'b' | null;
  yt_description?: string | null;
  yt_tags?: string[];
  // Series linkage — items belonging to the same narrative arc. The title
  // is denormalized onto the row so the UI can render badges without a join.
  series_id?: string | null;
  series_title?: string | null;
  part_number?: number | null;
  // Assigned editor (picked from one of the linked channels' rosters).
  // editor_name is denormalized onto the row so card chips don't need a join.
  editor_id?: string | null;
  editor_name?: string | null;
  editor_channel_id?: string | null;
  // Team-based picks (collaborators table, role=editor / role=narrator).
  // These reference /team people and are independent of the per-channel
  // editor_id roster.
  editor_collaborator_id?: string | null;
  editor_collaborator_name?: string | null;
  editor_collaborator_color?: string | null;
  editor_collaborator_token?: string | null;
  narrator_collaborator_id?: string | null;
  narrator_collaborator_name?: string | null;
  narrator_collaborator_color?: string | null;
  narrator_collaborator_token?: string | null;
  // Once published, the YouTube URL lets us pull title/description back.
  youtube_url?: string | null;
};

export type ChannelEditor = {
  id: string;
  channel_id: string;
  name: string;
  email: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** How long the item has been stuck in its current stage, or null if no stage_entered_at. */
export function daysInStage(item: ScheduleItem, now = new Date()): number | null {
  if (!item.stage_entered_at) return null;
  const entered = new Date(item.stage_entered_at);
  return Math.max(0, Math.floor((now.getTime() - entered.getTime()) / 86_400_000));
}

/** Default days-until-stuck per stage key. Tuned for a solo creator cadence. */
export const DEFAULT_STUCK_THRESHOLDS: Record<string, number> = {
  idea: 21,
  scripting: 10,
  recording: 7,
  editing: 14,
  ready: 7,
  // The upload queue is deliberately user-controlled — items sit here
  // in manual order until the creator decides to ship them — so a
  // stuck-stage warning would be noise.
  upload_queue: Infinity,
  published: Infinity,
};

export function isStuck(item: ScheduleItem, thresholds = DEFAULT_STUCK_THRESHOLDS): boolean {
  const d = daysInStage(item);
  if (d == null) return false;
  const limit = thresholds[item.status] ?? Infinity;
  return d > limit;
}

const DAY_INDEX: Record<NonNullable<RecurrenceRule['byday']>[number], number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

/** Expand a recurrence rule into concrete ISO timestamps, capped at `max` entries. */
export function expandRecurrence(
  start: Date,
  rule: RecurrenceRule,
  max = 52,
): string[] {
  const out: string[] = [];
  const interval = Math.max(1, rule.interval ?? 1);
  const untilDate = rule.until ? new Date(rule.until) : null;
  const limit = Math.min(max, rule.count ?? max);

  if (rule.freq === 'DAILY') {
    const cursor = new Date(start);
    while (out.length < limit) {
      if (untilDate && cursor > untilDate) break;
      out.push(cursor.toISOString());
      cursor.setDate(cursor.getDate() + interval);
    }
    return out;
  }

  if (rule.freq === 'WEEKLY') {
    const days = rule.byday && rule.byday.length > 0
      ? rule.byday.map(d => DAY_INDEX[d]).sort((a, b) => a - b)
      : [start.getDay()];
    // Walk week by week; within each week emit times for each chosen day at the start's time of day.
    const weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday-aligned
    const hours = start.getHours();
    const minutes = start.getMinutes();
    while (out.length < limit) {
      for (const d of days) {
        const dt = new Date(weekStart);
        dt.setDate(dt.getDate() + d);
        dt.setHours(hours, minutes, 0, 0);
        if (dt < start) continue;
        if (untilDate && dt > untilDate) return out;
        out.push(dt.toISOString());
        if (out.length >= limit) return out;
      }
      weekStart.setDate(weekStart.getDate() + 7 * interval);
    }
    return out;
  }

  if (rule.freq === 'MONTHLY') {
    const cursor = new Date(start);
    while (out.length < limit) {
      if (untilDate && cursor > untilDate) break;
      out.push(cursor.toISOString());
      cursor.setMonth(cursor.getMonth() + interval);
    }
    return out;
  }

  return out;
}

export function statusColor(statuses: ScheduleStatus[], key: string): string {
  return statuses.find(s => s.key === key)?.color || '#64748b';
}

export function statusLabel(statuses: ScheduleStatus[], key: string): string {
  return statuses.find(s => s.key === key)?.label || key;
}
