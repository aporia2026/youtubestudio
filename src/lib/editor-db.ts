import { sql } from '@vercel/postgres';

let migrated = false;

export async function ensureEditorSchema() {
  if (migrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS editor_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        editor_id UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'assigned'
          CHECK (status IN ('assigned','editing','submitted','approved','completed')),
        editor_notes TEXT,
        deadline TIMESTAMPTZ,
        review_project_id UUID REFERENCES review_projects(id) ON DELETE SET NULL,
        last_accessed_at TIMESTAMPTZ,
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(project_id, editor_id)
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_editor_assignments_editor ON editor_assignments(editor_id)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_editor_assignments_project ON editor_assignments(project_id)`; } catch {}

    // Extend media_assets so we can track which R2 bucket holds the file.
    try { await sql`ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS r2_bucket TEXT`; } catch {}
    try { await sql`ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS r2_key TEXT`; } catch {}

    migrated = true;
  } catch (err) {
    console.error('ensureEditorSchema error:', err);
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createEditorAssignment(fields: {
  project_id: string;
  editor_id: string;
  editor_notes?: string;
  deadline?: string;
}) {
  await ensureEditorSchema();
  const { rows } = await sql`
    INSERT INTO editor_assignments (project_id, editor_id, editor_notes, deadline)
    VALUES (${fields.project_id}, ${fields.editor_id}, ${fields.editor_notes ?? null}, ${fields.deadline ?? null})
    ON CONFLICT (project_id, editor_id) DO UPDATE
      SET editor_notes = EXCLUDED.editor_notes,
          deadline = EXCLUDED.deadline,
          updated_at = NOW()
    RETURNING *
  `;
  return rows[0];
}

export async function getEditorAssignmentsForProject(projectId: string) {
  await ensureEditorSchema();
  const { rows } = await sql`
    SELECT a.*,
      c.name AS editor_name,
      c.email AS editor_email,
      c.color AS editor_color,
      c.personal_token AS editor_personal_token
    FROM editor_assignments a
    LEFT JOIN collaborators c ON c.id = a.editor_id
    WHERE a.project_id = ${projectId}
    ORDER BY a.created_at DESC
  `;
  return rows;
}

export async function deleteEditorAssignment(id: string) {
  await ensureEditorSchema();
  await sql`DELETE FROM editor_assignments WHERE id = ${id}`;
}

export async function getEditorAssignmentsForEditor(editorId: string) {
  await ensureEditorSchema();
  const { rows } = await sql`
    SELECT a.*,
      p.title AS project_title,
      p.niche AS project_niche,
      p.topic AS project_topic,
      p.status AS project_status,
      (SELECT COUNT(*)::int FROM media_assets m WHERE m.project_id = a.project_id AND m.type = 'image') AS image_ref_count,
      (SELECT COUNT(*)::int FROM media_assets m WHERE m.project_id = a.project_id AND m.type = 'voiceover') AS voiceover_count,
      (SELECT COUNT(*)::int FROM youtube_references r WHERE r.project_id = a.project_id) AS youtube_ref_count,
      (SELECT COUNT(*)::int FROM review_versions v WHERE v.project_id = a.review_project_id) AS uploaded_version_count
    FROM editor_assignments a
    JOIN projects p ON p.id = a.project_id
    WHERE a.editor_id = ${editorId}
    ORDER BY
      CASE a.status
        WHEN 'editing' THEN 1
        WHEN 'assigned' THEN 2
        WHEN 'submitted' THEN 3
        WHEN 'approved' THEN 4
        WHEN 'completed' THEN 5
        ELSE 6
      END,
      a.deadline ASC NULLS LAST,
      a.updated_at DESC
  `;
  return rows;
}

export async function getEditorAssignment(projectId: string, editorId: string) {
  await ensureEditorSchema();
  const { rows } = await sql`
    SELECT * FROM editor_assignments
    WHERE project_id = ${projectId} AND editor_id = ${editorId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateEditorAssignment(id: string, fields: { status?: string; editor_notes?: string; deadline?: string; review_project_id?: string }) {
  await ensureEditorSchema();
  const { rows } = await sql`
    UPDATE editor_assignments SET
      status = COALESCE(${fields.status ?? null}, status),
      editor_notes = COALESCE(${fields.editor_notes ?? null}, editor_notes),
      deadline = COALESCE(${fields.deadline ?? null}, deadline),
      review_project_id = COALESCE(${fields.review_project_id ?? null}, review_project_id),
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

/** Track that the editor opened the dashboard / a project. Fire-and-forget. */
export async function bumpEditorAssignmentAccess(projectId: string, editorId: string) {
  try {
    await sql`
      UPDATE editor_assignments
      SET last_accessed_at = NOW(), access_count = access_count + 1
      WHERE project_id = ${projectId} AND editor_id = ${editorId}
    `;
  } catch {}
}

/**
 * Find the main `projects.id` that corresponds to a `review_projects.id`.
 *
 * The link is indirect — when a schedule item spawns a review project we stash
 * `review_project_id` in `schedule_items.custom_fields`, and the schedule item
 * already carries the main `project_id`. So we hop schedule_items to translate.
 *
 * Returns null when no schedule item links the two (standalone review project).
 */
export async function findMainProjectIdForReviewProject(reviewProjectId: string): Promise<string | null> {
  try {
    const { rows } = await sql`
      SELECT project_id FROM schedule_items
      WHERE custom_fields->>'review_project_id' = ${reviewProjectId}
        AND project_id IS NOT NULL
      LIMIT 1
    `;
    return (rows[0]?.project_id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort: when an editor gets a review link, ensure they also have an
 * editor_assignment so the project shows up on their personal dashboard.
 * Silently no-ops if the review project isn't tied to a main project (e.g.
 * standalone review projects created outside the schedule flow).
 */
export async function ensureEditorAssignmentFromReviewLink(reviewProjectId: string, editorId: string) {
  try {
    const projectId = await findMainProjectIdForReviewProject(reviewProjectId);
    if (!projectId) return null;
    await ensureEditorSchema();
    const { rows } = await sql`
      INSERT INTO editor_assignments (project_id, editor_id, review_project_id)
      VALUES (${projectId}, ${editorId}, ${reviewProjectId})
      ON CONFLICT (project_id, editor_id) DO UPDATE
        SET review_project_id = COALESCE(editor_assignments.review_project_id, EXCLUDED.review_project_id),
            updated_at = NOW()
      RETURNING *
    `;
    return rows[0] ?? null;
  } catch (err) {
    console.error('ensureEditorAssignmentFromReviewLink error:', err);
    return null;
  }
}

/**
 * Return review_share_links assigned to this editor that have NO matching
 * editor_assignment (and no resolvable main project). Used by the dashboard
 * to show "review-only" projects so a misconfigured share still surfaces.
 */
export async function getReviewOnlyEntriesForEditor(editorId: string) {
  await ensureEditorSchema();
  try {
    const { rows } = await sql`
      SELECT
        s.id           AS link_id,
        s.token        AS share_token,
        s.permission   AS permission,
        s.label        AS label,
        s.created_at   AS created_at,
        rp.id          AS review_project_id,
        rp.title       AS project_title,
        rp.status      AS review_status
      FROM review_share_links s
      JOIN review_projects rp ON rp.id = s.project_id
      WHERE s.collaborator_id = ${editorId}
        AND NOT EXISTS (
          SELECT 1 FROM editor_assignments ea
          WHERE ea.editor_id = ${editorId}
            AND ea.review_project_id = rp.id
        )
      ORDER BY s.created_at DESC
    `;
    return rows;
  } catch {
    return [];
  }
}
