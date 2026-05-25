/**
 * Data loaders for the Command Center page.
 *
 * Returns workspace-scoped "in-flight video" cards plus the per-channel-week
 * summary used by the left rail and the stuck-videos panel.
 *
 * One round-trip per render via LATERAL joins. Same shape as
 * loadVideoContext() in src/lib/video-context.ts but plural — every project
 * in the workspace that's not terminal gets a card, with the same
 * canonical stage resolution logic baked into the query.
 *
 * Filtering is done in two layers:
 *   - SQL: workspace_id + non-terminal projects (drops `cancelled` /
 *     `archived` rows so they don't pollute the kanban).
 *   - JS: the page applies the user-selected channel + week + stage
 *     filters on top of the snapshot. This keeps the SQL stable and
 *     cacheable while leaving the filter UI snappy.
 */
import { sql } from '@vercel/postgres';
import {
  PIPELINE_STAGE_TO_VIDEO_STAGE,
  SCHEDULE_STATUS_TO_VIDEO_STAGE,
  type VideoStageId,
  isVideoStageId,
  getStageDef,
} from './video-stages';

export interface CommandCenterChannel {
  id: string;
  name: string;
  account_color: string | null;
}

export interface CommandCenterBlocker {
  /** Who or what the video is waiting on, at a glance. */
  kind: 'ai' | 'narrator' | 'editor' | 'user' | 'gate' | 'none';
  /** Plain-language label for the card ("Sarah, due Thu", "AI working", "Needs your review"). */
  label: string;
  /** When the blocker expires / deadline applies; null if open-ended. */
  deadline: string | null;
}

export interface CommandCenterCard {
  id: string;
  title: string;
  niche: string;
  current_stage: VideoStageId;
  current_stage_label: string;
  is_auto_managed: boolean;
  channel: CommandCenterChannel | null;
  scheduled_for: string | null;
  schedule_status: string | null;
  blocker: CommandCenterBlocker;
  /** Most recent stage-change timestamp, used for the stuck panel.
   *  Falls back to projects.updated_at when no transitions exist yet. */
  last_moved_at: string;
  latest_qa_score: number | null;
  latest_qa_aggressiveness: string | null;
  pipeline_run_id: string | null;
}

export interface PerChannelWeekSummary {
  channelId: string | null;
  channelName: string;
  channelColor: string | null;
  totalThisWeek: number;
  doneThisWeek: number;
  blockedThisWeek: number;
  stuckThisWeek: number;
}

const TERMINAL_PIPELINE_STAGES = new Set<string>([
  'cancelled_by_user',
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'seo_failed',
  'cost_cap_exceeded',
]);

/**
 * Load every in-flight video card for the workspace, with the data the
 * kanban needs to render. Bounded by `limit` so a runaway workspace
 * doesn't blow up the page.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadCommandCenterCards(
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<CommandCenterCard[]> {
  // UUID guard up front: a typo'd id should be an empty result, not a
  // Postgres syntax error that bubbles up as a 500 to the user.
  if (!UUID_RE.test(workspaceId)) return [];
  const limit = opts.limit ?? 500;

  const result = await sql`
    SELECT
      p.id,
      p.title,
      p.niche,
      p.status                    AS project_status,
      p.current_stage             AS cached_current_stage,
      p.created_at,
      p.updated_at,
      -- Channel chip
      ch.id                       AS channel_id,
      ch.name                     AS channel_name,
      ch.account_color            AS channel_color,
      -- Schedule slot
      si.scheduled_for            AS scheduled_for,
      si.status                   AS schedule_status,
      -- Narrator assignment (latest)
      na.status                   AS narrator_status,
      na_user.name                AS narrator_name,
      na.deadline                 AS narrator_deadline,
      -- Editor assignment (latest)
      ea.status                   AS editor_status,
      ea_user.name                AS editor_name,
      ea.deadline                 AS editor_deadline,
      -- Pipeline run video (most recent active)
      prv.pipeline_run_id         AS pipeline_run_id,
      prv.stage                   AS pipeline_stage,
      prv.failure_class           AS pipeline_failure_class,
      -- Latest QA pass
      qa.overall_score            AS latest_qa_score,
      cp.aggressiveness           AS latest_qa_aggressiveness,
      -- Latest stage transition (manual advances)
      vst.to_stage                AS latest_transition_to_stage,
      vst.occurred_at             AS latest_transition_at
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT c.id, c.name, c.account_color
      FROM project_channels pcj
      JOIN channels c ON c.id = pcj.channel_id
      WHERE pcj.project_id = p.id
      ORDER BY c.name ASC, c.id ASC
      LIMIT 1
    ) ch ON true
    LEFT JOIN LATERAL (
      SELECT scheduled_for, status
      FROM schedule_items
      WHERE project_id = p.id
      ORDER BY created_at DESC
      LIMIT 1
    ) si ON true
    LEFT JOIN LATERAL (
      SELECT id, status, narrator_id, deadline
      FROM narrator_assignments
      WHERE project_id = p.id
      ORDER BY created_at DESC
      LIMIT 1
    ) na ON true
    LEFT JOIN collaborators na_user ON na_user.id = na.narrator_id
    LEFT JOIN LATERAL (
      SELECT id, status, editor_id, deadline
      FROM editor_assignments
      WHERE project_id = p.id
      ORDER BY created_at DESC
      LIMIT 1
    ) ea ON true
    LEFT JOIN collaborators ea_user ON ea_user.id = ea.editor_id
    LEFT JOIN LATERAL (
      SELECT pipeline_run_id, stage, failure_class
      FROM pipeline_run_videos
      WHERE project_id = p.id
      ORDER BY created_at DESC
      LIMIT 1
    ) prv ON true
    LEFT JOIN LATERAL (
      SELECT overall_score, script_id
      FROM qa_sessions
      WHERE project_id = p.id
      ORDER BY created_at DESC
      LIMIT 1
    ) qa ON true
    LEFT JOIN LATERAL (
      SELECT aggressiveness
      FROM critic_panels
      WHERE project_id = p.id
      ORDER BY started_at DESC
      LIMIT 1
    ) cp ON true
    LEFT JOIN LATERAL (
      SELECT to_stage, occurred_at
      FROM video_stage_transitions
      WHERE project_id = p.id
      ORDER BY occurred_at DESC
      LIMIT 1
    ) vst ON true
    WHERE p.workspace_id = ${workspaceId}::uuid
      AND COALESCE(p.status, '') NOT IN ('cancelled', 'archived')
    ORDER BY COALESCE(vst.occurred_at, p.updated_at) DESC
    LIMIT ${limit}
  `;

  return result.rows
    .map(rowToCard)
    // Exclude cards whose project has nothing happening yet (no schedule,
    // no script, no pipeline) AND have already drifted to terminal. This
    // keeps the kanban focused on active work without filtering legit
    // brand-new projects out.
    .filter(card => card.current_stage !== 'published');
}

/**
 * Load the videos that have not moved stage in N hours. Reads from
 * video_stage_transitions; a project with no transition row yet but
 * with last `updated_at` over N hours is also considered stuck.
 */
export async function loadStuckCards(
  workspaceId: string,
  thresholdHours: number,
): Promise<CommandCenterCard[]> {
  const all = await loadCommandCenterCards(workspaceId);
  const cutoffMs = Date.now() - thresholdHours * 3600 * 1000;
  return all.filter(card => {
    const lastMovedTs = Date.parse(card.last_moved_at);
    return Number.isFinite(lastMovedTs) && lastMovedTs < cutoffMs;
  });
}

/**
 * Compute the per-channel summary for the left rail. Groups the cards
 * (already filtered by week on the page side) by their channel and
 * counts done / blocked / stuck.
 *
 * Pass `cards` already filtered for the active week — this helper
 * doesn't re-filter so the rail and the kanban share the exact same
 * slice of data. A discrepancy here would confuse the user.
 */
export function summarizeByChannel(cards: CommandCenterCard[], stuckThresholdHours = 48): PerChannelWeekSummary[] {
  const byChannel = new Map<string, PerChannelWeekSummary>();
  const cutoffMs = Date.now() - stuckThresholdHours * 3600 * 1000;

  for (const card of cards) {
    const channelId = card.channel?.id ?? null;
    const key = channelId ?? '__no_channel__';
    if (!byChannel.has(key)) {
      byChannel.set(key, {
        channelId,
        channelName: card.channel?.name ?? 'No channel',
        channelColor: card.channel?.account_color ?? null,
        totalThisWeek: 0,
        doneThisWeek: 0,
        blockedThisWeek: 0,
        stuckThisWeek: 0,
      });
    }
    const bucket = byChannel.get(key)!;
    bucket.totalThisWeek += 1;
    if (card.current_stage === 'published') bucket.doneThisWeek += 1;
    if (card.blocker.kind === 'gate' || card.blocker.kind === 'narrator' || card.blocker.kind === 'editor') {
      bucket.blockedThisWeek += 1;
    }
    const lastMovedTs = Date.parse(card.last_moved_at);
    if (Number.isFinite(lastMovedTs) && lastMovedTs < cutoffMs) {
      bucket.stuckThisWeek += 1;
    }
  }

  return Array.from(byChannel.values()).sort((a, b) => b.totalThisWeek - a.totalThisWeek);
}

// ─── Internal helpers ─────────────────────────────────────────────────

interface RawRow {
  id: string;
  title: string;
  niche: string;
  project_status: string | null;
  cached_current_stage: string | null;
  created_at: string;
  updated_at: string;
  channel_id: string | null;
  channel_name: string | null;
  channel_color: string | null;
  scheduled_for: string | null;
  schedule_status: string | null;
  narrator_status: string | null;
  narrator_name: string | null;
  narrator_deadline: string | null;
  editor_status: string | null;
  editor_name: string | null;
  editor_deadline: string | null;
  pipeline_run_id: string | null;
  pipeline_stage: string | null;
  pipeline_failure_class: string | null;
  latest_qa_score: number | null;
  latest_qa_aggressiveness: string | null;
  latest_transition_to_stage: string | null;
  latest_transition_at: string | null;
}

function rowToCard(raw: Record<string, unknown>): CommandCenterCard {
  const row = raw as unknown as RawRow;
  const pipelineStage = row.pipeline_stage ?? null;
  const isAutoManaged = pipelineStage !== null && !TERMINAL_PIPELINE_STAGES.has(pipelineStage) && pipelineStage !== 'done';
  // Prefer the cached projects.current_stage column when populated (Wave 3
  // dual-write). Falls back to the legacy LATERAL-join resolution for any
  // row that hasn't been touched by advanceVideo() yet — the backfill
  // script populates the column once on first run, after which the cache
  // is the fast path.
  const currentStage = (row.cached_current_stage && isVideoStageId(row.cached_current_stage))
    ? row.cached_current_stage
    : resolveStage({
        pipelineStage,
        latestTransitionToStage: row.latest_transition_to_stage,
        scheduleStatus: row.schedule_status,
        projectStatus: row.project_status,
      });
  return {
    id: row.id,
    title: row.title ?? 'Untitled',
    niche: row.niche ?? '',
    current_stage: currentStage,
    current_stage_label: getStageDef(currentStage).label,
    is_auto_managed: isAutoManaged,
    channel: row.channel_id
      ? { id: row.channel_id, name: row.channel_name ?? 'Unknown', account_color: row.channel_color }
      : null,
    scheduled_for: safeIso(row.scheduled_for),
    schedule_status: row.schedule_status,
    blocker: deriveBlocker(row, pipelineStage),
    last_moved_at: safeIso(row.latest_transition_at) ?? safeIso(row.updated_at) ?? new Date().toISOString(),
    latest_qa_score:
      row.latest_qa_score !== null && Number.isFinite(Number(row.latest_qa_score))
        ? Number(row.latest_qa_score)
        : null,
    latest_qa_aggressiveness: row.latest_qa_aggressiveness ?? null,
    pipeline_run_id: row.pipeline_run_id ?? null,
  };
}

/** Parse a possibly-malformed date input into an ISO string, or null
 *  if it doesn't parse. Guards against bad data in the column without
 *  crashing the page. */
function safeIso(input: string | null | undefined): string | null {
  if (!input) return null;
  const ts = Date.parse(String(input));
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function resolveStage(args: {
  pipelineStage: string | null;
  latestTransitionToStage: string | null;
  scheduleStatus: string | null;
  projectStatus: string | null;
}): VideoStageId {
  if (args.pipelineStage) {
    if (args.pipelineStage === 'done') return 'published';
    if (!TERMINAL_PIPELINE_STAGES.has(args.pipelineStage)) {
      const mapped = PIPELINE_STAGE_TO_VIDEO_STAGE[args.pipelineStage];
      if (mapped) return mapped;
    }
  }
  if (isVideoStageId(args.latestTransitionToStage ?? '')) {
    return args.latestTransitionToStage as VideoStageId;
  }
  if (args.scheduleStatus) {
    const mapped = SCHEDULE_STATUS_TO_VIDEO_STAGE[args.scheduleStatus];
    if (mapped) return mapped;
  }
  if (args.projectStatus && isVideoStageId(args.projectStatus)) {
    return args.projectStatus;
  }
  return 'script';
}

function deriveBlocker(row: RawRow, pipelineStage: string | null): CommandCenterBlocker {
  // Pipeline gates (auto-managed videos waiting on user input)
  if (pipelineStage === 'awaiting_script_gate') {
    return { kind: 'gate', label: 'Script gate — keep, regenerate, or kill', deadline: null };
  }
  if (pipelineStage === 'narration_overdue') {
    return { kind: 'gate', label: 'Narration overdue', deadline: row.narrator_deadline ?? null };
  }
  // Narration in flight
  if (pipelineStage === 'waiting_narration' || row.narrator_status === 'assigned' || row.narrator_status === 'recording' || row.narrator_status === 'submitted') {
    const due = row.narrator_deadline ? new Date(row.narrator_deadline).toISOString() : null;
    const dueLabel = due ? ` · due ${formatRelativeDate(due)}` : '';
    return {
      kind: 'narrator',
      label: row.narrator_name ? `Narrator: ${row.narrator_name}${dueLabel}` : `Narrator${dueLabel}`,
      deadline: due,
    };
  }
  // Editing in flight
  if (row.editor_status === 'assigned' || row.editor_status === 'editing' || row.editor_status === 'submitted') {
    const due = row.editor_deadline ? new Date(row.editor_deadline).toISOString() : null;
    const dueLabel = due ? ` · due ${formatRelativeDate(due)}` : '';
    return {
      kind: 'editor',
      label: row.editor_name ? `Editor: ${row.editor_name}${dueLabel}` : `Editor${dueLabel}`,
      deadline: due,
    };
  }
  // Auto-pipeline actively working
  if (pipelineStage && !TERMINAL_PIPELINE_STAGES.has(pipelineStage) && pipelineStage !== 'done') {
    return { kind: 'ai', label: 'AI working', deadline: null };
  }
  // Otherwise the user is in charge.
  return { kind: 'none', label: '', deadline: null };
}

function formatRelativeDate(iso: string): string {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return '';
  const deltaDays = Math.round((target - Date.now()) / (24 * 3600 * 1000));
  if (deltaDays === 0) return 'today';
  if (deltaDays === 1) return 'tomorrow';
  if (deltaDays === -1) return 'yesterday';
  if (deltaDays > 0 && deltaDays < 7) {
    return new Date(target).toLocaleDateString(undefined, { weekday: 'short' });
  }
  return new Date(target).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Week helpers (ISO week, Monday-anchored) ─────────────────────────

export interface IsoWeek {
  year: number;
  week: number;
  startISO: string;
  endISO: string;
}

/** Compute the ISO week (Mon-Sun) for a given date. Defaults to today. */
export function currentIsoWeek(date: Date = new Date()): IsoWeek {
  // Clone so we don't mutate the input.
  const d = new Date(date.getTime());
  // Set to nearest Thursday: current date + 4 - current day number
  // (Sunday becomes 7 in ISO).
  d.setUTCHours(0, 0, 0, 0);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const year = d.getUTCFullYear();
  // Monday at 00:00 UTC of this ISO week:
  const monday = new Date(date.getTime());
  monday.setUTCHours(0, 0, 0, 0);
  const today = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - today + 1);
  const sunday = new Date(monday.getTime());
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return {
    year,
    week,
    startISO: monday.toISOString(),
    endISO: sunday.toISOString(),
  };
}

/** Filter cards to only those scheduled within the ISO week, or with
 *  no scheduled_for (these always pass through — early-stage videos
 *  haven't picked a publish date yet and shouldn't disappear because
 *  the week filter is active). */
export function filterCardsByWeek(cards: CommandCenterCard[], week: IsoWeek): CommandCenterCard[] {
  if (!Array.isArray(cards) || cards.length === 0) return [];
  const startMs = Date.parse(week.startISO);
  const endMs = Date.parse(week.endISO);
  // Defensive: if the week itself is malformed, don't filter — return
  // everything so the user can at least see their videos.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return cards;
  return cards.filter(card => {
    if (!card.scheduled_for) return true;
    const t = Date.parse(card.scheduled_for);
    if (!Number.isFinite(t)) return true;
    return t >= startMs && t <= endMs;
  });
}
