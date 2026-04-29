import { sql } from '@vercel/postgres';

// ---------------------------------------------------------------------------
// Schema migration (idempotent)
// ---------------------------------------------------------------------------

let narratorMigrated = false;

export async function ensureNarratorSchema() {
  if (narratorMigrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS narrator_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT,
        color TEXT NOT NULL DEFAULT '#7c3aed',
        specialties JSONB DEFAULT '[]',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS narrator_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        script_id UUID REFERENCES scripts(id),
        narrator_id UUID REFERENCES narrator_profiles(id),
        status TEXT NOT NULL DEFAULT 'assigned'
          CHECK (status IN ('assigned','received','recording','submitted','revisions','approved','completed')),
        deadline TIMESTAMPTZ,
        director_notes TEXT,
        share_token TEXT NOT NULL UNIQUE,
        wpm INTEGER NOT NULL DEFAULT 150,
        script_version INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_narrator_assignments_project ON narrator_assignments(project_id)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_narrator_assignments_token ON narrator_assignments(share_token)`; } catch {}

    await sql`
      CREATE TABLE IF NOT EXISTS narrator_sections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        assignment_id UUID NOT NULL REFERENCES narrator_assignments(id) ON DELETE CASCADE,
        section_number INTEGER NOT NULL,
        label TEXT,
        script_text TEXT NOT NULL,
        director_notes TEXT,
        pronunciation_notes JSONB DEFAULT '[]',
        emphasis_markers JSONB DEFAULT '[]',
        estimated_duration_seconds INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','recording','submitted','approved','retake')),
        approved_take_id UUID,
        reference_audio_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(assignment_id, section_number)
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_narrator_sections_assignment ON narrator_sections(assignment_id)`; } catch {}

    await sql`
      CREATE TABLE IF NOT EXISTS narrator_takes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        section_id UUID NOT NULL REFERENCES narrator_sections(id) ON DELETE CASCADE,
        take_number INTEGER NOT NULL,
        audio_url TEXT NOT NULL,
        blob_pathname TEXT,
        duration_seconds NUMERIC,
        file_size BIGINT,
        narrator_notes TEXT,
        owner_notes TEXT,
        rating INTEGER CHECK (rating BETWEEN 1 AND 5),
        is_selected BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_narrator_takes_section ON narrator_takes(section_id)`; } catch {}
    try { await sql`ALTER TABLE narrator_takes ADD CONSTRAINT narrator_takes_section_take_unique UNIQUE (section_id, take_number)`; } catch {}
    // R2 narration bucket migration — old takes lived on Vercel Blob; new ones go to R2
    try { await sql`ALTER TABLE narrator_takes ADD COLUMN IF NOT EXISTS r2_key TEXT`; } catch {}

    await sql`
      CREATE TABLE IF NOT EXISTS narrator_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        assignment_id UUID NOT NULL REFERENCES narrator_assignments(id) ON DELETE CASCADE,
        section_id UUID REFERENCES narrator_sections(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_role TEXT NOT NULL CHECK (author_role IN ('owner','narrator')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_narrator_comments_assignment ON narrator_comments(assignment_id)`; } catch {}

    // Access tracking columns
    try { await sql`ALTER TABLE narrator_assignments ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`; } catch {}
    try { await sql`ALTER TABLE narrator_assignments ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0`; } catch {}

    narratorMigrated = true;
  } catch (err) {
    console.error('ensureNarratorSchema error:', err);
  }
}

// ---------------------------------------------------------------------------
// Narrator Profiles
// ---------------------------------------------------------------------------

export async function createNarratorProfile(fields: { name: string; email?: string; color?: string; specialties?: string[]; notes?: string }) {
  await ensureNarratorSchema();
  // Create in collaborators table (unified), also mirror to narrator_profiles for FK compatibility
  const { rows } = await sql`
    INSERT INTO collaborators (name, email, color, specialties, notes, role)
    VALUES (${fields.name}, ${fields.email ?? null}, ${fields.color ?? '#7c3aed'}, ${JSON.stringify(fields.specialties || [])}, ${fields.notes ?? null}, 'narrator')
    RETURNING *
  `;
  try {
    await sql`
      INSERT INTO narrator_profiles (id, name, email, color, specialties, notes)
      VALUES (${rows[0].id}, ${fields.name}, ${fields.email ?? null}, ${fields.color ?? '#7c3aed'}, ${JSON.stringify(fields.specialties || [])}, ${fields.notes ?? null})
      ON CONFLICT (id) DO NOTHING
    `;
  } catch (e) { console.warn('narrator_profiles sync insert:', e); }
  return rows[0];
}

export async function listNarratorProfiles() {
  await ensureNarratorSchema();
  const { rows } = await sql`SELECT * FROM collaborators WHERE role = 'narrator' ORDER BY name ASC`;
  return rows;
}

export async function updateNarratorProfile(id: string, fields: { name?: string; email?: string; color?: string; specialties?: string[]; notes?: string }) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    UPDATE collaborators
    SET name = COALESCE(${fields.name ?? null}, name),
        email = COALESCE(${fields.email ?? null}, email),
        color = COALESCE(${fields.color ?? null}, color),
        specialties = COALESCE(${fields.specialties ? JSON.stringify(fields.specialties) : null}, specialties),
        notes = COALESCE(${fields.notes ?? null}, notes)
    WHERE id = ${id}
    RETURNING *
  `;
  // Sync narrator_profiles
  try { await sql`UPDATE narrator_profiles SET name = ${rows[0]?.name}, email = ${rows[0]?.email}, color = ${rows[0]?.color} WHERE id = ${id}`; } catch (e) { console.warn('narrator_profiles sync update:', e); }
  return rows[0] ?? null;
}

export async function deleteNarratorProfile(id: string) {
  await ensureNarratorSchema();
  try { await sql`DELETE FROM narrator_profiles WHERE id = ${id}`; } catch (e) { console.warn('narrator_profiles sync delete:', e); }
  await sql`DELETE FROM collaborators WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function createAssignment(fields: {
  project_id: string;
  script_id: string;
  narrator_id: string;
  director_notes?: string;
  wpm?: number;
  script_version?: number;
  deadline?: string;
}) {
  await ensureNarratorSchema();
  const token = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO narrator_assignments (project_id, script_id, narrator_id, director_notes, wpm, script_version, deadline, share_token)
    VALUES (${fields.project_id}, ${fields.script_id}, ${fields.narrator_id}, ${fields.director_notes ?? null}, ${fields.wpm ?? 150}, ${fields.script_version ?? null}, ${fields.deadline ?? null}, ${token})
    RETURNING *
  `;
  return rows[0];
}

export async function getAssignment(id: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT a.*, n.name AS narrator_name, n.color AS narrator_color, p.title AS project_title
    FROM narrator_assignments a
    LEFT JOIN collaborators n ON n.id = a.narrator_id
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.id = ${id}
  `;
  return rows[0] ?? null;
}

export async function getAssignmentByToken(token: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT a.*, n.name AS narrator_name, n.color AS narrator_color, p.title AS project_title
    FROM narrator_assignments a
    LEFT JOIN collaborators n ON n.id = a.narrator_id
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.share_token = ${token}
  `;
  return rows[0] ?? null;
}

export async function getAssignmentsForProject(projectId: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT a.*, n.name AS narrator_name, n.color AS narrator_color
    FROM narrator_assignments a
    LEFT JOIN collaborators n ON n.id = a.narrator_id
    WHERE a.project_id = ${projectId}
    ORDER BY a.created_at DESC
  `;
  return rows;
}

export async function listAllAssignments() {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT a.*, n.name AS narrator_name, n.color AS narrator_color, n.personal_token AS narrator_personal_token, p.title AS project_title,
      (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id) AS total_sections,
      (SELECT COUNT(*)::int FROM narrator_sections s WHERE s.assignment_id = a.id AND s.status = 'approved') AS approved_sections
    FROM narrator_assignments a
    LEFT JOIN collaborators n ON n.id = a.narrator_id
    LEFT JOIN projects p ON p.id = a.project_id
    ORDER BY a.updated_at DESC
  `;
  return rows;
}

export async function updateAssignment(id: string, fields: { status?: string; director_notes?: string; deadline?: string }) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    UPDATE narrator_assignments
    SET status = COALESCE(${fields.status ?? null}, status),
        director_notes = COALESCE(${fields.director_notes ?? null}, director_notes),
        deadline = COALESCE(${fields.deadline ?? null}, deadline),
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export async function createSection(fields: {
  assignment_id: string;
  section_number: number;
  label?: string;
  script_text: string;
  director_notes?: string;
  pronunciation_notes?: unknown[];
  emphasis_markers?: unknown[];
  estimated_duration_seconds?: number;
}) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    INSERT INTO narrator_sections (assignment_id, section_number, label, script_text, director_notes, pronunciation_notes, emphasis_markers, estimated_duration_seconds)
    VALUES (${fields.assignment_id}, ${fields.section_number}, ${fields.label ?? null}, ${fields.script_text}, ${fields.director_notes ?? null}, ${JSON.stringify(fields.pronunciation_notes || [])}, ${JSON.stringify(fields.emphasis_markers || [])}, ${fields.estimated_duration_seconds ?? null})
    RETURNING *
  `;
  return rows[0];
}

export async function getSectionsForAssignment(assignmentId: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT s.*,
      (SELECT json_agg(t ORDER BY t.take_number DESC) FROM narrator_takes t WHERE t.section_id = s.id) AS takes
    FROM narrator_sections s
    WHERE s.assignment_id = ${assignmentId}
    ORDER BY s.section_number ASC
  `;
  return rows;
}

export async function updateSection(sectionId: string, fields: {
  status?: string;
  director_notes?: string;
  pronunciation_notes?: unknown[];
  emphasis_markers?: unknown[];
  approved_take_id?: string;
  reference_audio_url?: string;
}) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    UPDATE narrator_sections
    SET status = COALESCE(${fields.status ?? null}, status),
        director_notes = COALESCE(${fields.director_notes ?? null}, director_notes),
        pronunciation_notes = COALESCE(${fields.pronunciation_notes ? JSON.stringify(fields.pronunciation_notes) : null}, pronunciation_notes),
        emphasis_markers = COALESCE(${fields.emphasis_markers ? JSON.stringify(fields.emphasis_markers) : null}, emphasis_markers),
        approved_take_id = COALESCE(${fields.approved_take_id ?? null}, approved_take_id),
        reference_audio_url = COALESCE(${fields.reference_audio_url ?? null}, reference_audio_url)
    WHERE id = ${sectionId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------

export async function createTake(fields: {
  section_id: string;
  audio_url: string;
  /** R2 key when stored in the narration bucket (preferred) */
  r2_key?: string;
  /** Vercel Blob pathname (legacy uploads) */
  blob_pathname?: string;
  duration_seconds?: number;
  file_size?: number;
  narrator_notes?: string;
}) {
  await ensureNarratorSchema();
  // Atomic take_number increment via subquery
  const { rows } = await sql`
    INSERT INTO narrator_takes (section_id, take_number, audio_url, r2_key, blob_pathname, duration_seconds, file_size, narrator_notes)
    VALUES (
      ${fields.section_id},
      (SELECT COALESCE(MAX(take_number), 0) + 1 FROM narrator_takes WHERE section_id = ${fields.section_id}),
      ${fields.audio_url},
      ${fields.r2_key ?? null},
      ${fields.blob_pathname ?? null},
      ${fields.duration_seconds ?? null},
      ${fields.file_size ?? null},
      ${fields.narrator_notes ?? null}
    )
    RETURNING *
  `;

  // Auto-update section status to 'submitted' on first take
  if (rows[0].take_number === 1) {
    await sql`UPDATE narrator_sections SET status = 'submitted' WHERE id = ${fields.section_id} AND status IN ('pending', 'recording', 'retake')`;
  }

  return rows[0];
}

export async function getTakesForSection(sectionId: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT * FROM narrator_takes WHERE section_id = ${sectionId} ORDER BY take_number DESC
  `;
  return rows;
}

export async function updateTake(takeId: string, fields: { rating?: number; owner_notes?: string; is_selected?: boolean }) {
  await ensureNarratorSchema();
  // If selecting this take, unselect others in same section
  if (fields.is_selected) {
    const { rows: takeRows } = await sql`SELECT section_id FROM narrator_takes WHERE id = ${takeId}`;
    if (takeRows[0]) {
      await sql`UPDATE narrator_takes SET is_selected = false WHERE section_id = ${takeRows[0].section_id}`;
    }
  }
  const { rows } = await sql`
    UPDATE narrator_takes
    SET rating = COALESCE(${fields.rating ?? null}, rating),
        owner_notes = COALESCE(${fields.owner_notes ?? null}, owner_notes),
        is_selected = COALESCE(${fields.is_selected ?? null}, is_selected)
    WHERE id = ${takeId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function createNarratorComment(fields: {
  assignment_id: string;
  section_id?: string;
  text: string;
  author_name: string;
  author_role: 'owner' | 'narrator';
}) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    INSERT INTO narrator_comments (assignment_id, section_id, text, author_name, author_role)
    VALUES (${fields.assignment_id}, ${fields.section_id ?? null}, ${fields.text}, ${fields.author_name}, ${fields.author_role})
    RETURNING *
  `;
  return rows[0];
}

export async function getCommentsForAssignment(assignmentId: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT * FROM narrator_comments
    WHERE assignment_id = ${assignmentId}
    ORDER BY created_at ASC
  `;
  return rows;
}
