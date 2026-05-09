/**
 * Activity feed for a single collaborator on /team-hub.
 *
 * Unions across the existing tables so we don't add new persistence:
 *
 *   - narrator_takes      → "Uploaded take N for <project>"
 *   - narration_take_comments → "Posted a take comment" / "Comment posted on their take"
 *   - review_versions     → "Uploaded review version <N>"
 *   - review_comments     → "Posted a review comment" / "Comment posted on their work"
 *   - team_hub_audit_log  → "Owner acted on their behalf: <action> (success|failure)"
 *
 * All branches are workspace-scoped at the SQL layer. Capped at 50 events
 * total, newest first. The shape is deliberately uniform so the tab
 * component renders one row template across all event types.
 */
import { sql } from '@vercel/postgres';

export type ActivityEventType =
  | 'take_uploaded'
  | 'narration_take_comment'
  | 'review_version_uploaded'
  | 'review_comment'
  | 'act_as';

export interface ActivityEvent {
  event_type: ActivityEventType;
  target_id: string;
  event_at: string;
  /** Free-form per-event-type payload. The tab component reads
   *  type-specific fields based on `event_type`. */
  payload: Record<string, unknown>;
}

export async function getCollaboratorActivity(
  workspaceId: string,
  collaboratorId: string,
  limit = 50,
): Promise<ActivityEvent[]> {
  const { rows } = await sql<ActivityEvent>`
    WITH events AS (
      -- Take uploads (the narrator uploaded a recording)
      SELECT
        'take_uploaded'::text AS event_type,
        t.id AS target_id,
        t.created_at AS event_at,
        json_build_object(
          'take_id', t.id,
          'take_number', t.take_number,
          'section_id', t.section_id,
          'section_number', s.section_number,
          'section_label', s.label,
          'project_id', a.project_id,
          'project_title', p.title
        ) AS payload
        FROM narrator_takes t
        JOIN narrator_sections s ON s.id = t.section_id
        JOIN narrator_assignments a ON a.id = s.assignment_id
        LEFT JOIN projects p ON p.id = a.project_id
       WHERE a.narrator_id = ${collaboratorId}
         AND a.workspace_id = ${workspaceId}

      UNION ALL

      -- Take comments — both the narrator's own comments AND owner
      -- comments left on their takes. Posted-by-owner flag exposed so
      -- the UI can label it correctly.
      SELECT
        'narration_take_comment'::text AS event_type,
        c.id AS target_id,
        c.created_at AS event_at,
        json_build_object(
          'comment_id', c.id,
          'take_id', c.take_id,
          'author_role', c.author_role,
          'author_name', c.author_name,
          'posted_by_owner', c.posted_by_owner,
          'text', LEFT(c.text, 160),
          'project_id', a.project_id,
          'project_title', p.title
        ) AS payload
        FROM narration_take_comments c
        JOIN narrator_takes t ON t.id = c.take_id
        JOIN narrator_sections s ON s.id = t.section_id
        JOIN narrator_assignments a ON a.id = s.assignment_id
        LEFT JOIN projects p ON p.id = a.project_id
       WHERE a.narrator_id = ${collaboratorId}
         AND a.workspace_id = ${workspaceId}

      UNION ALL

      -- Review version uploads — by the editor assigned to the project
      SELECT
        'review_version_uploaded'::text AS event_type,
        v.id AS target_id,
        v.created_at AS event_at,
        json_build_object(
          'version_id', v.id,
          'version_number', v.version_number,
          'uploaded_by', v.uploaded_by,
          'review_project_id', v.project_id,
          'project_id', ea.project_id,
          'project_title', p.title
        ) AS payload
        FROM review_versions v
        JOIN editor_assignments ea ON ea.review_project_id = v.project_id
        LEFT JOIN projects p ON p.id = ea.project_id
       WHERE ea.editor_id = ${collaboratorId}
         AND ea.workspace_id = ${workspaceId}

      UNION ALL

      -- Review comments authored by the collaborator (best-effort name
      -- match, mirroring the same attribution model the rest of the
      -- review system uses).
      SELECT
        'review_comment'::text AS event_type,
        c.id AS target_id,
        c.created_at AS event_at,
        json_build_object(
          'comment_id', c.id,
          'version_id', c.version_id,
          'author_name', c.author_name,
          'posted_by_owner', c.posted_by_owner,
          'text', LEFT(c.text, 160),
          'review_project_id', v.project_id
        ) AS payload
        FROM review_comments c
        JOIN review_versions v ON v.id = c.version_id
        JOIN review_share_links l ON l.project_id = v.project_id
       WHERE l.collaborator_id = ${collaboratorId}
         AND l.workspace_id = ${workspaceId}
         AND c.author_name = (SELECT name FROM collaborators WHERE id = ${collaboratorId})

      UNION ALL

      -- Act-as audit entries where this collaborator was the target.
      SELECT
        'act_as'::text AS event_type,
        audit.id AS target_id,
        audit.performed_at AS event_at,
        json_build_object(
          'action_type', audit.action_type,
          'surface', audit.surface,
          'surface_target_id', audit.target_id,
          'result', audit.result,
          'error_message', audit.error_message
        ) AS payload
        FROM team_hub_audit_log audit
       WHERE audit.target_collaborator_id = ${collaboratorId}
         AND audit.workspace_id = ${workspaceId}
    )
    SELECT event_type, target_id, event_at, payload
      FROM events
     ORDER BY event_at DESC
     LIMIT ${limit}
  `;
  return rows;
}
