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
