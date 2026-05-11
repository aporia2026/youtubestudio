/**
 * Per-collaborator task queries for the /team-hub Tasks tab.
 *
 * Each role surfaces a different shape of work:
 *
 *   - Narrator → narrator_assignments + per-assignment section progress.
 *   - Editor   → editor_assignments + linked review_project + version count.
 *   - Reviewer → review_share_links + per-link unresolved comment count.
 *   - Channel editor → schedule_items they touch + last-week activity.
 *
 * Every query is workspace-scoped at the SQL layer (the route layer
 * passes `session.ws`). A row from another workspace cannot leak through
 * even if a malicious caller forges the collaborator id in the URL.
 */
import { sql } from '@vercel/postgres';
import { countWords } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Editor tasks
// ---------------------------------------------------------------------------

export interface EditorTaskRow {
  /** editor_assignments.id */
  id: string;
  project_id: string;
  project_title: string | null;
  status: string;
  deadline: string | null;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Linked review project (set once the editor uploads their first video). */
  review_project_id: string | null;
  /** Total + unresolved counts on review_comments scoped to the linked
   *  review_project. NULL review_project_id ⇒ both 0. */
  uploaded_version_count: number;
  unresolved_review_comment_count: number;
}

export async function getEditorTasks(
  workspaceId: string,
  editorId: string,
): Promise<EditorTaskRow[]> {
  const { rows } = await sql<EditorTaskRow>`
    SELECT
      a.id,
      a.project_id,
      p.title AS project_title,
      a.status,
      a.deadline,
      a.last_accessed_at,
      a.created_at,
      a.updated_at,
      a.review_project_id,
      COALESCE(vc.uploaded_version_count, 0)::int AS uploaded_version_count,
      COALESCE(cc.unresolved_review_comment_count, 0)::int AS unresolved_review_comment_count
      FROM editor_assignments a
      LEFT JOIN projects p ON p.id = a.project_id
      LEFT JOIN (
        SELECT project_id, COUNT(*)::int AS uploaded_version_count
          FROM review_versions
         GROUP BY project_id
      ) vc ON vc.project_id = a.review_project_id
      LEFT JOIN (
        SELECT v.project_id, COUNT(*)::int AS unresolved_review_comment_count
          FROM review_comments c
          JOIN review_versions v ON v.id = c.version_id
         WHERE NOT c.resolved
         GROUP BY v.project_id
      ) cc ON cc.project_id = a.review_project_id
     WHERE a.editor_id = ${editorId}
       AND a.workspace_id = ${workspaceId}
     ORDER BY a.updated_at DESC
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Reviewer / client tasks
// ---------------------------------------------------------------------------

export interface ReviewerTaskRow {
  /** review_share_links.id */
  id: string;
  /** review_projects.id — the linked review project, NOT the upstream project. */
  review_project_id: string;
  project_title: string | null;
  permission: 'view-only' | 'can-comment' | 'can-annotate';
  label: string | null;
  expires_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
  token: string;
  created_at: string;
  /** Comments authored by this reviewer that aren't resolved yet. */
  authored_unresolved_count: number;
}

export async function getReviewerTasks(
  workspaceId: string,
  collaboratorId: string,
): Promise<ReviewerTaskRow[]> {
  // review_share_links.project_id points at review_projects.id; we join
  // back to review_projects to get the human title, then to the unresolved
  // comment count. The permission CHECK constraint on review_share_links
  // bounds the union of values to the three TS literals above.
  //
  // Authored-comment count uses author_name match — comments don't carry
  // the collaborator id, only the display name they typed in. That's a
  // best-effort attribution, but it's the same contract NarrationTab uses.
  const { rows } = await sql<ReviewerTaskRow>`
    SELECT
      l.id,
      l.project_id AS review_project_id,
      rp.title AS project_title,
      l.permission,
      l.label,
      l.expires_at,
      l.last_accessed_at,
      l.access_count,
      l.token,
      l.created_at,
      COALESCE(uc.authored_unresolved_count, 0)::int AS authored_unresolved_count
      FROM review_share_links l
      LEFT JOIN review_projects rp ON rp.id = l.project_id
      LEFT JOIN (
        SELECT v.project_id, c.author_name, COUNT(*)::int AS authored_unresolved_count
          FROM review_comments c
          JOIN review_versions v ON v.id = c.version_id
         WHERE NOT c.resolved
         GROUP BY v.project_id, c.author_name
      ) uc ON uc.project_id = l.project_id
       AND uc.author_name = (SELECT name FROM collaborators WHERE id = ${collaboratorId})
     WHERE l.collaborator_id = ${collaboratorId}
       AND l.workspace_id = ${workspaceId}
     ORDER BY l.created_at DESC
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Channel-editor tasks
// ---------------------------------------------------------------------------

export interface ChannelEditorTaskRow {
  /** Composite roster id: '<channel_editor.id>@<channel_id>' (matches the
   *  scheme team-hub-db.ts uses to give per-channel-editor entries
   *  unique ids in the URL space). */
  id: string;
  channel_editor_id: string;
  channel_id: string;
  channel_name: string;
  /** Schedule items the editor has been assigned via channel_editors. */
  upcoming_schedule_count: number;
  past_schedule_count: number;
}

export async function getChannelEditorTasks(
  workspaceId: string,
  channelEditorId: string,
  channelId: string,
): Promise<ChannelEditorTaskRow | null> {
  const { rows } = await sql<ChannelEditorTaskRow>`
    SELECT
      ${channelEditorId} || '@' || ${channelId} AS id,
      ce.id AS channel_editor_id,
      ce.channel_id,
      ch.name AS channel_name,
      (
        SELECT COUNT(*)::int
          FROM schedule_items si
         WHERE si.editor_id = ce.id
           AND si.workspace_id = ${workspaceId}
           AND COALESCE(si.scheduled_for, si.created_at) >= NOW()
      ) AS upcoming_schedule_count,
      (
        SELECT COUNT(*)::int
          FROM schedule_items si
         WHERE si.editor_id = ce.id
           AND si.workspace_id = ${workspaceId}
           AND COALESCE(si.scheduled_for, si.created_at) < NOW()
      ) AS past_schedule_count
      FROM channel_editors ce
      JOIN channels ch ON ch.id = ce.channel_id
     WHERE ce.id = ${channelEditorId}
       AND ce.channel_id = ${channelId}
       AND ch.workspace_id = ${workspaceId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Narrator tasks
// ---------------------------------------------------------------------------

export interface NarratorTaskRow {
  /** narrator_assignments.id */
  id: string;
  project_id: string;
  project_title: string | null;
  status: string;
  deadline: string | null;
  share_token: string;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Section progress (excluding section 0 — synthetic full-audio holder). */
  total_sections: number;
  approved_sections: number;
  /** Most recent take id under the assignment, used to default the
   *  "Open take comments" action. NULL when the narrator hasn't uploaded
   *  any takes yet. */
  latest_take_id: string | null;
  /** Duration in seconds of the narrator's most recent narration upload —
   *  the assignment's cached `full_audio_duration_seconds` when they
   *  uploaded a single full-script file, otherwise the most recent
   *  per-section take's `duration_seconds`. NULL when nothing has been
   *  uploaded yet. */
  latest_take_duration_seconds: number | null;
  /** Count of *spoken* words across all real script sections, with
   *  production cues / metadata stripped via `stripProductionCues`.
   *  Gives the owner a quick read on how much narration the assignment
   *  actually contains, independent of bracketed direction. */
  spoken_word_count: number;
}

/** Raw row shape returned by the narrator-tasks query — kept separate
 *  from `NarratorTaskRow` so the post-processing step in `getNarratorTasks`
 *  is unit-testable without spinning up Postgres. NUMERIC columns can come
 *  back as either `string` or `number` depending on the driver's type
 *  parser configuration, so the post-processor coerces. */
export interface NarratorTaskQueryRow extends Omit<NarratorTaskRow, 'latest_take_duration_seconds' | 'spoken_word_count'> {
  full_audio_duration_seconds: number | string | null;
  latest_section_take_duration_seconds: number | string | null;
  scripts_joined: string | null;
}

/** Pure post-processor: coerce numeric duration to a real `number`,
 *  prefer the cached full-audio duration when present, and compute the
 *  spoken-word count off the aggregated script text. Exported for tests. */
export function projectNarratorTaskRow(raw: NarratorTaskQueryRow): NarratorTaskRow {
  const full = raw.full_audio_duration_seconds;
  const perSection = raw.latest_section_take_duration_seconds;
  let latestTakeDurationSeconds: number | null = null;
  if (full != null && full !== '') {
    const n = Number(full);
    if (Number.isFinite(n)) latestTakeDurationSeconds = n;
  } else if (perSection != null && perSection !== '') {
    const n = Number(perSection);
    if (Number.isFinite(n)) latestTakeDurationSeconds = n;
  }
  return {
    id: raw.id,
    project_id: raw.project_id,
    project_title: raw.project_title,
    status: raw.status,
    deadline: raw.deadline,
    share_token: raw.share_token,
    last_accessed_at: raw.last_accessed_at,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    total_sections: raw.total_sections,
    approved_sections: raw.approved_sections,
    latest_take_id: raw.latest_take_id,
    latest_take_duration_seconds: latestTakeDurationSeconds,
    spoken_word_count: countWords(raw.scripts_joined ?? ''),
  };
}

/**
 * All narrator assignments for one collaborator in one workspace, newest
 * first. Includes per-assignment section progress and the latest take id
 * so the UI can deep-link the take-comments surface in one click.
 *
 * The COUNT(*) FILTER aggregations excluded section 0 because section 0
 * is a synthetic "full-audio" holder that mustn't inflate the user-visible
 * X/Y progress.
 */
export async function getNarratorTasks(
  workspaceId: string,
  narratorId: string,
): Promise<NarratorTaskRow[]> {
  // Section 0 is filtered out of every subquery: it's a synthetic holder
  // for the full-script audio path and would otherwise (a) inflate progress
  // counts, (b) duplicate the take into the "latest per-section take"
  // subquery, and (c) double-count its script_text into the aggregate.
  // The full-audio path surfaces via the assignment-level cached duration
  // instead — see `projectNarratorTaskRow`.
  const { rows } = await sql<NarratorTaskQueryRow>`
    SELECT
      a.id,
      a.project_id,
      p.title AS project_title,
      a.status,
      a.deadline,
      a.share_token,
      a.last_accessed_at,
      a.created_at,
      a.updated_at,
      a.full_audio_duration_seconds,
      COALESCE(ss.total_sections, 0)::int AS total_sections,
      COALESCE(ss.approved_sections, 0)::int AS approved_sections,
      (
        SELECT t.id
          FROM narrator_takes t
          JOIN narrator_sections s ON s.id = t.section_id
         WHERE s.assignment_id = a.id
         ORDER BY t.created_at DESC
         LIMIT 1
      ) AS latest_take_id,
      (
        SELECT t.duration_seconds
          FROM narrator_takes t
          JOIN narrator_sections s ON s.id = t.section_id
         WHERE s.assignment_id = a.id
           AND s.section_number != 0
         ORDER BY t.created_at DESC
         LIMIT 1
      ) AS latest_section_take_duration_seconds,
      (
        SELECT COALESCE(string_agg(s.script_text, E'\n\n' ORDER BY s.section_number), '')
          FROM narrator_sections s
         WHERE s.assignment_id = a.id
           AND s.section_number != 0
      ) AS scripts_joined
      FROM narrator_assignments a
      LEFT JOIN projects p ON p.id = a.project_id
      LEFT JOIN (
        SELECT
          s.assignment_id,
          COUNT(*) FILTER (WHERE s.section_number != 0) AS total_sections,
          COUNT(*) FILTER (WHERE s.section_number != 0 AND s.status = 'approved') AS approved_sections
          FROM narrator_sections s
         GROUP BY s.assignment_id
      ) ss ON ss.assignment_id = a.id
     WHERE a.narrator_id = ${narratorId}
       AND a.workspace_id = ${workspaceId}
     ORDER BY a.updated_at DESC
  `;
  return rows.map(projectNarratorTaskRow);
}
