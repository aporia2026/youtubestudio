/**
 * Canonical stage chain for a video's journey through the studio.
 *
 * The same stages auto-pipeline already walks (queued → generating_idea →
 * generating_script → running_qa → waiting_narration → narration_complete →
 * generating_production_doc → generating_thumbnail → assigning_to_editor →
 * generating_seo → done), collapsed into the user-facing label the kanban
 * column / context strip shows, and mapped to the tool route that handles
 * that stage in the UI.
 *
 * This is presentation-layer canon. The underlying state machines
 * (projects.status, schedule_items.status, pipeline_run_videos.stage,
 * narrator_assignments.status, editor_assignments.status) keep their
 * own vocabulary; resolveStageForVideo() in src/lib/video-context.ts
 * picks the right "currently-at" stage from those projections.
 *
 * Naming choice: stage ids are short camelCase keys; the user-facing
 * label is always plain English. "Stage 4 of 10" hover hints come from
 * the order in STAGE_CHAIN — never hard-code an index in the UI.
 */

export type VideoStageId =
  | 'idea'
  | 'script'
  | 'qa'
  | 'voiceover'
  | 'production_doc'
  | 'thumbnail'
  | 'edit'
  | 'seo'
  | 'scheduled'
  | 'published';

export interface VideoStageDef {
  id: VideoStageId;
  label: string;
  toolPath: string;
  shortHint: string;
}

export const STAGE_CHAIN: readonly VideoStageDef[] = [
  { id: 'idea',            label: 'Idea',           toolPath: '/ideas',          shortHint: 'Pick or generate the idea' },
  { id: 'script',          label: 'Script',         toolPath: '/generator',      shortHint: 'Write or generate the script' },
  { id: 'qa',              label: 'QA',             toolPath: '/qa',             shortHint: 'Critic panel review' },
  { id: 'voiceover',       label: 'Voiceover',      toolPath: '/voiceover',      shortHint: 'AI voiceover or human narrator' },
  { id: 'production_doc',  label: 'Production doc', toolPath: '/production-doc', shortHint: 'B-roll, overlays, shot breakdown' },
  { id: 'thumbnail',       label: 'Thumbnail',      toolPath: '/thumbnails',     shortHint: 'Generate or edit the thumbnail' },
  { id: 'edit',            label: 'Edit',           toolPath: '/video-studio',   shortHint: 'Assemble the final cut' },
  { id: 'seo',             label: 'SEO',            toolPath: '/seo',            shortHint: 'Title, description, tags' },
  { id: 'scheduled',       label: 'Scheduled',      toolPath: '/schedule',       shortHint: 'Set the publish date' },
  { id: 'published',       label: 'Published',      toolPath: '/schedule',       shortHint: 'Live on YouTube' },
] as const;

const STAGE_INDEX_BY_ID: Record<VideoStageId, number> = STAGE_CHAIN.reduce(
  (acc, stage, idx) => {
    acc[stage.id] = idx;
    return acc;
  },
  {} as Record<VideoStageId, number>,
);

const ALL_STAGE_IDS = new Set<string>(STAGE_CHAIN.map(s => s.id));

export function isVideoStageId(value: string | null | undefined): value is VideoStageId {
  return typeof value === 'string' && ALL_STAGE_IDS.has(value);
}

export function getStageDef(id: VideoStageId): VideoStageDef {
  return STAGE_CHAIN[STAGE_INDEX_BY_ID[id]];
}

export function getStageIndex(id: VideoStageId): number {
  return STAGE_INDEX_BY_ID[id];
}

export function getStageNeighbors(id: VideoStageId): { prev: VideoStageDef | null; next: VideoStageDef | null } {
  const idx = STAGE_INDEX_BY_ID[id];
  return {
    prev: idx > 0 ? STAGE_CHAIN[idx - 1] : null,
    next: idx < STAGE_CHAIN.length - 1 ? STAGE_CHAIN[idx + 1] : null,
  };
}

/**
 * Mapping from the underlying state-machine vocabularies into the canonical
 * VideoStageId. Used by resolveStageForVideo() in video-context.ts and by
 * advanceVideo() to translate a target VideoStageId back into the right
 * write target on the right table.
 *
 * Auto-pipeline `pipeline_run_videos.stage` is the most detailed; many of
 * its substages collapse to one user-facing stage (queued + generating_idea
 * both surface as "Idea"; generating_script + awaiting_script_gate both
 * surface as "Script"; running_qa + qa_retry both surface as "QA"; etc.).
 */
export const PIPELINE_STAGE_TO_VIDEO_STAGE: Record<string, VideoStageId> = {
  queued: 'idea',
  generating_idea: 'idea',
  generating_script: 'script',
  awaiting_script_gate: 'script',
  running_qa: 'qa',
  qa_retry: 'qa',
  waiting_narration: 'voiceover',
  narration_overdue: 'voiceover',
  narration_complete: 'voiceover',
  generating_production_doc: 'production_doc',
  generating_thumbnail: 'thumbnail',
  assigning_to_editor: 'edit',
  generating_seo: 'seo',
  done: 'published',
};

/**
 * Schedule item status keys vary per channel pipeline (configured in
 * channel_statuses) but the default set in db.ts uses these labels. We
 * map the common ones; an unknown status falls back to the project's
 * own derived stage (see resolveStageForVideo).
 */
export const SCHEDULE_STATUS_TO_VIDEO_STAGE: Record<string, VideoStageId> = {
  idea: 'idea',
  scripting: 'script',
  recording: 'voiceover',
  editing: 'edit',
  ready: 'seo',
  upload_queue: 'scheduled',
  scheduled: 'scheduled',
  published: 'published',
};
