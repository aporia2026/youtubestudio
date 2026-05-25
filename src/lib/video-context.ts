/**
 * Server-side loader for a video's unified context.
 *
 * Reconciles the three independent state machines (projects.status,
 * schedule_items.status, pipeline_run_videos.stage) into one canonical
 * VideoStageId for the UI to show, and bundles the surrounding data
 * (channel, active script, narrator assignment, editor assignment,
 * schedule slot, latest QA score) so the VideoContextStrip and the
 * Wave 2 Command Center can render in one round-trip.
 *
 * This module is server-only. The shape it returns is serialisable so it
 * can be passed through a route handler to a client component.
 *
 * Stage resolution priority (most-authoritative first):
 *   1. Active pipeline_run_videos row (auto-pipeline owns the journey).
 *   2. Latest video_stage_transitions.to_stage (user-driven advances).
 *   3. Schedule item status (publishing-side state).
 *   4. Project.status fallback.
 *
 * The first source that yields a recognised VideoStageId wins. Sources
 * 2-4 are projections; source 1 is the live owner when present.
 */
// Server-only by virtue of importing @vercel/postgres. The project does not
// install the `server-only` shim package; the runtime guard is implicit.
import { sql } from '@vercel/postgres';
import {
  PIPELINE_STAGE_TO_VIDEO_STAGE,
  SCHEDULE_STATUS_TO_VIDEO_STAGE,
  STAGE_CHAIN,
  type VideoStageId,
  isVideoStageId,
  getStageDef,
  getStageIndex,
} from './video-stages';

export interface VideoChannelContext {
  id: string;
  name: string;
  account_color: string | null;
}

export interface VideoScheduleContext {
  id: string;
  scheduled_for: string | null;
  status: string;
}

export interface VideoNarratorContext {
  id: string;
  status: string;
  narrator_id: string | null;
  narrator_name: string | null;
  deadline: string | null;
}

export interface VideoEditorContext {
  id: string;
  status: string;
  editor_id: string | null;
  editor_name: string | null;
  deadline: string | null;
}

export interface VideoPipelineContext {
  pipeline_run_id: string;
  pipeline_run_video_id: string;
  stage: string;
  retry_count: number;
  failure_class: string | null;
  failure_message: string | null;
}

export interface VideoContext {
  /** Project id, the authoritative anchor for a video. */
  id: string;
  workspace_id: string;
  title: string;
  niche: string;
  topic: string | null;
  /** Canonical user-facing stage, resolved from the most-authoritative
   *  state-machine source available. */
  current_stage: VideoStageId;
  /** Position in STAGE_CHAIN, 0-indexed. Used by the "Stage X of Y" hover hint. */
  current_stage_index: number;
  current_stage_label: string;
  /** True when an active pipeline_run_videos row owns this video; the
   *  VideoContextStrip's Next button defers to the pipeline's gate logic
   *  in that case. */
  is_auto_managed: boolean;
  channel: VideoChannelContext | null;
  schedule_item: VideoScheduleContext | null;
  narrator_assignment: VideoNarratorContext | null;
  editor_assignment: VideoEditorContext | null;
  pipeline: VideoPipelineContext | null;
  /** Latest QA pass score, if any. Null when no QA has been run. */
  latest_qa_score: number | null;
  /** Latest critic-panel aggressiveness (standard | brutal | nuclear) for
   *  the latest pass. Used by the strip to show "QA: 84 / 100 (nuclear)". */
  latest_qa_aggressiveness: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Load the full context for a video by project id, scoped to the
 * caller's workspace. Returns null when the project does not exist or
 * the caller does not have access.
 *
 * The query is a single round-trip with a LATERAL join per side-channel
 * source. Each side-channel join is LIMIT 1 so the result row stays a
 * single row regardless of how many child rows exist.
 */
export async function loadVideoContext(
  projectId: string,
  workspaceId: string,
): Promise<VideoContext | null> {
  // UUID validation up-front: rejecting non-UUID strings here gives a
  // clean 404 instead of a Postgres error.
  if (!UUID_RE.test(projectId)) return null;
  if (!UUID_RE.test(workspaceId)) return null;

  // One big SELECT. LEFT JOINs everywhere so a video missing any
  // side-channel data still resolves; we treat absence as "stage hasn't
  // moved there yet."
  const result = await sql`
    SELECT
      p.id,
      p.workspace_id,
      p.title,
      p.niche,
      p.topic,
      p.status                     AS project_status,
      p.current_stage              AS cached_current_stage,
      p.created_at,
      p.updated_at,
      -- Channel (first link in project_channels, if any)
      pc_channel.id                AS channel_id,
      pc_channel.name              AS channel_name,
      pc_channel.account_color     AS channel_color,
      -- Schedule slot
      si.id                        AS schedule_item_id,
      si.scheduled_for             AS schedule_scheduled_for,
      si.status                    AS schedule_status,
      -- Narrator assignment (latest)
      na.id                        AS narrator_assignment_id,
      na.status                    AS narrator_status,
      na.narrator_id               AS narrator_id,
      na_user.name                 AS narrator_name,
      na.deadline                  AS narrator_deadline,
      -- Editor assignment (latest)
      ea.id                        AS editor_assignment_id,
      ea.status                    AS editor_status,
      ea.editor_id                 AS editor_id,
      ea_user.name                 AS editor_name,
      ea.deadline                  AS editor_deadline,
      -- Pipeline run video (most recent active one)
      prv.id                       AS pipeline_run_video_id,
      prv.pipeline_run_id          AS pipeline_run_id,
      prv.stage                    AS pipeline_stage,
      prv.retry_count              AS pipeline_retry_count,
      prv.failure_class            AS pipeline_failure_class,
      prv.failure_message          AS pipeline_failure_message,
      -- Latest QA pass
      qa.overall_score             AS latest_qa_score,
      cp.aggressiveness            AS latest_qa_aggressiveness,
      -- Latest manual stage-transition
      vst.to_stage                 AS latest_transition_to_stage
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT c.id, c.name, c.account_color
      FROM project_channels pcj
      JOIN channels c ON c.id = pcj.channel_id
      WHERE pcj.project_id = p.id
      ORDER BY c.name ASC, c.id ASC
      LIMIT 1
    ) pc_channel ON true
    LEFT JOIN LATERAL (
      SELECT si.id, si.scheduled_for, si.status
      FROM schedule_items si
      WHERE si.project_id = p.id
      ORDER BY si.created_at DESC
      LIMIT 1
    ) si ON true
    LEFT JOIN LATERAL (
      SELECT na.id, na.status, na.narrator_id, na.deadline
      FROM narrator_assignments na
      WHERE na.project_id = p.id
      ORDER BY na.created_at DESC
      LIMIT 1
    ) na ON true
    LEFT JOIN collaborators na_user ON na_user.id = na.narrator_id
    LEFT JOIN LATERAL (
      SELECT ea.id, ea.status, ea.editor_id, ea.deadline
      FROM editor_assignments ea
      WHERE ea.project_id = p.id
      ORDER BY ea.created_at DESC
      LIMIT 1
    ) ea ON true
    LEFT JOIN collaborators ea_user ON ea_user.id = ea.editor_id
    LEFT JOIN LATERAL (
      SELECT prv.id, prv.pipeline_run_id, prv.stage, prv.retry_count,
             prv.failure_class, prv.failure_message
      FROM pipeline_run_videos prv
      WHERE prv.project_id = p.id
      ORDER BY prv.created_at DESC
      LIMIT 1
    ) prv ON true
    LEFT JOIN LATERAL (
      SELECT qa.overall_score, qa.script_id
      FROM qa_sessions qa
      WHERE qa.project_id = p.id
      ORDER BY qa.created_at DESC
      LIMIT 1
    ) qa ON true
    LEFT JOIN LATERAL (
      SELECT cp.aggressiveness
      FROM critic_panels cp
      WHERE cp.project_id = p.id
      ORDER BY cp.started_at DESC
      LIMIT 1
    ) cp ON true
    LEFT JOIN LATERAL (
      SELECT vst.to_stage
      FROM video_stage_transitions vst
      WHERE vst.project_id = p.id
      ORDER BY vst.occurred_at DESC
      LIMIT 1
    ) vst ON true
    WHERE p.id = ${projectId}::uuid
      AND p.workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;

  const row = result.rows[0];
  if (!row) return null;

  const pipelineStage: string | null = row.pipeline_stage ?? null;
  // A pipeline 'done' video is no longer auto-managed (the user is back in
  // charge). Treated the same as terminal pipeline states; matches the
  // logic in command-center.ts.
  const isAutoManaged =
    pipelineStage !== null
    && pipelineStage !== 'done'
    && !TERMINAL_PIPELINE_STAGES.has(pipelineStage);

  // Prefer the cached projects.current_stage column when populated. Falls
  // back to the legacy LATERAL-join resolution for any row that hasn't
  // been touched by advanceVideo() yet.
  const cached = (row.cached_current_stage as string | null) ?? null;
  const currentStage: VideoStageId = (cached && isVideoStageId(cached))
    ? cached
    : resolveStage({
        pipelineStage,
        latestTransitionToStage: (row.latest_transition_to_stage as string | null) ?? null,
        scheduleStatus: (row.schedule_status as string | null) ?? null,
        projectStatus: (row.project_status as string | null) ?? null,
      });

  const stageDef = getStageDef(currentStage);

  return {
    id: row.id,
    workspace_id: row.workspace_id,
    title: row.title,
    niche: row.niche,
    topic: row.topic ?? null,
    current_stage: currentStage,
    current_stage_index: getStageIndex(currentStage),
    current_stage_label: stageDef.label,
    is_auto_managed: isAutoManaged,
    channel: row.channel_id
      ? {
          id: row.channel_id,
          name: row.channel_name,
          account_color: row.channel_color ?? null,
        }
      : null,
    schedule_item: row.schedule_item_id
      ? {
          id: row.schedule_item_id,
          scheduled_for: row.schedule_scheduled_for ? new Date(row.schedule_scheduled_for).toISOString() : null,
          status: row.schedule_status,
        }
      : null,
    narrator_assignment: row.narrator_assignment_id
      ? {
          id: row.narrator_assignment_id,
          status: row.narrator_status,
          narrator_id: row.narrator_id ?? null,
          narrator_name: row.narrator_name ?? null,
          deadline: row.narrator_deadline ? new Date(row.narrator_deadline).toISOString() : null,
        }
      : null,
    editor_assignment: row.editor_assignment_id
      ? {
          id: row.editor_assignment_id,
          status: row.editor_status,
          editor_id: row.editor_id ?? null,
          editor_name: row.editor_name ?? null,
          deadline: row.editor_deadline ? new Date(row.editor_deadline).toISOString() : null,
        }
      : null,
    pipeline: row.pipeline_run_video_id
      ? {
          pipeline_run_id: row.pipeline_run_id,
          pipeline_run_video_id: row.pipeline_run_video_id,
          stage: pipelineStage as string,
          retry_count: row.pipeline_retry_count ?? 0,
          failure_class: row.pipeline_failure_class ?? null,
          failure_message: row.pipeline_failure_message ?? null,
        }
      : null,
    latest_qa_score: row.latest_qa_score ?? null,
    latest_qa_aggressiveness: row.latest_qa_aggressiveness ?? null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

// Terminal pipeline stages — a video that's in a terminal state is no
// longer "auto-managed" in the sense that the cron will move it; the
// user is back in charge.
const TERMINAL_PIPELINE_STAGES = new Set<string>([
  'done',
  'cancelled_by_user',
  'qa_failed_after_max_retries',
  'narration_abandoned',
  'production_doc_failed',
  'thumbnail_failed',
  'editor_assignment_failed',
  'seo_failed',
  'cost_cap_exceeded',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the canonical user-facing stage from the available state-machine
 * sources. Falls through in priority order; defaults to 'script' if no
 * source yields a recognised stage (a brand-new project with no scripts,
 * no schedule item, and no pipeline row is at "script" stage by default
 * because that's the first thing the user does for a manual video).
 */
function resolveStage(args: {
  pipelineStage: string | null;
  latestTransitionToStage: string | null;
  scheduleStatus: string | null;
  projectStatus: string | null;
}): VideoStageId {
  // 1. Pipeline owns the journey if it's running.
  if (args.pipelineStage && !TERMINAL_PIPELINE_STAGES.has(args.pipelineStage)) {
    const mapped = PIPELINE_STAGE_TO_VIDEO_STAGE[args.pipelineStage];
    if (mapped) return mapped;
  }

  // 2. Latest user-driven transition (from video_stage_transitions).
  if (isVideoStageId(args.latestTransitionToStage)) {
    return args.latestTransitionToStage;
  }

  // 3. Schedule slot status.
  if (args.scheduleStatus) {
    const mapped = SCHEDULE_STATUS_TO_VIDEO_STAGE[args.scheduleStatus];
    if (mapped) return mapped;
  }

  // 4. Project status fallback. The legacy `projects.status` is mostly
  //    'draft' so we treat draft as "still on script" — the manual-flow
  //    default. Other values pass through if they happen to match a
  //    VideoStageId, otherwise default.
  if (args.projectStatus && isVideoStageId(args.projectStatus)) {
    return args.projectStatus;
  }

  // 5. Default: script stage. A fresh project has nothing else to be at yet.
  return 'script';
}

/**
 * Compute the prev/next tool URLs for a given video's current stage.
 * The video id is appended as ?videoId= to preserve the context through
 * navigation. Returns null for prev/next when at the chain boundary.
 */
export function neighborUrlsForStage(
  currentStage: VideoStageId,
  videoId: string,
): { prev: { stage: VideoStageId; label: string; href: string } | null; next: { stage: VideoStageId; label: string; href: string } | null } {
  const idx = STAGE_CHAIN.findIndex(s => s.id === currentStage);
  if (idx < 0) return { prev: null, next: null };
  const prev = idx > 0 ? STAGE_CHAIN[idx - 1] : null;
  const next = idx < STAGE_CHAIN.length - 1 ? STAGE_CHAIN[idx + 1] : null;
  const withVideoId = (path: string): string => `${path}?videoId=${encodeURIComponent(videoId)}`;
  return {
    prev: prev ? { stage: prev.id, label: prev.label, href: withVideoId(prev.toolPath) } : null,
    next: next ? { stage: next.id, label: next.label, href: withVideoId(next.toolPath) } : null,
  };
}
