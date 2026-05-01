import { sql } from '@vercel/postgres';
import { splitScriptIntoSections } from './narrator-utils';

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

    // Per-take Frame.io-style timestamped review comments. Mirrors the
    // review_comments shape but scoped to a single audio take. Same idempotent
    // pattern as the rest of this file — also created by migration 0006 in
    // production.
    await sql`
      CREATE TABLE IF NOT EXISTS narration_take_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        take_id UUID NOT NULL REFERENCES narrator_takes(id) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        end_timestamp_ms INTEGER,
        text TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_color TEXT NOT NULL DEFAULT '#7c3aed',
        author_role TEXT NOT NULL CHECK (author_role IN ('owner','narrator')),
        resolved BOOLEAN NOT NULL DEFAULT false,
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        parent_id UUID REFERENCES narration_take_comments(id) ON DELETE CASCADE,
        fix_for_comment_id UUID REFERENCES narration_take_comments(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_narration_take_comments_take ON narration_take_comments(take_id)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_narration_take_comments_parent ON narration_take_comments(parent_id)`; } catch {}

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
    SELECT a.*, n.name AS narrator_name, n.color AS narrator_color, n.personal_token AS narrator_personal_token, p.title AS project_title
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

/**
 * Rebuild a single assignment's sections from the project's currently-active
 * script if it's safe to do so. "Safe" means:
 *   - No takes have been uploaded yet (otherwise rebuilding orphans audio).
 *   - The assignment is not already submitted/approved/completed.
 *   - The assignment's recorded script_id/version differs from the project's
 *     current active script (i.e. the owner edited the script since the
 *     assignment was created or last synced).
 *
 * This runs lazily on the narrator-portal data load so the narrator always
 * reads from the latest script even if the script-POST hook was missed
 * (e.g. edit happened before the auto-sync feature shipped).
 *
 * Returns true when sections were rebuilt, false otherwise.
 */
export async function resyncAssignmentSectionsIfStale(assignmentId: string): Promise<boolean> {
  await ensureNarratorSchema();
  try {
    const { rows: assignmentRows } = await sql`
      SELECT a.id, a.project_id, a.script_id, a.script_version, a.status, a.wpm
      FROM narrator_assignments a
      WHERE a.id = ${assignmentId}
      LIMIT 1
    `;
    const assignment = assignmentRows[0];
    if (!assignment) return false;
    if (!['assigned', 'received', 'recording'].includes(assignment.status)) return false;

    // Skip if any take exists — rebuilding sections would orphan audio.
    const { rows: takeRows } = await sql`
      SELECT 1 FROM narrator_takes t
      JOIN narrator_sections s ON s.id = t.section_id
      WHERE s.assignment_id = ${assignmentId}
      LIMIT 1
    `;
    if (takeRows.length > 0) return false;

    // Look up the currently-active script for this project.
    const { rows: scriptRows } = await sql`
      SELECT id, version, content
      FROM scripts
      WHERE project_id = ${assignment.project_id} AND is_active = true
      ORDER BY version DESC
      LIMIT 1
    `;
    const activeScript = scriptRows[0];
    if (!activeScript || !activeScript.content) return false;

    // Only proceed when we have a clear staleness signal: either the script
    // version is older than the active version, or the section text doesn't
    // match what splitting the active script produces. Avoids spurious
    // rebuilds on assignments with legacy NULL script_version.
    const candidate = splitScriptIntoSections(activeScript.content, assignment.wpm || 150);
    candidate.forEach((s, i) => {
      if (!s.label) s.label = i === 0 ? 'Hook' : i === candidate.length - 1 ? 'Outro' : `Section ${i + 1}`;
    });

    const versionStale =
      typeof assignment.script_version === 'number' &&
      typeof activeScript.version === 'number' &&
      assignment.script_version < activeScript.version;

    if (!versionStale) {
      // Compare the existing sections' text to what we'd build from the
      // active script. If they match, the assignment is already in sync.
      const { rows: existing } = await sql`
        SELECT script_text FROM narrator_sections
        WHERE assignment_id = ${assignmentId}
        ORDER BY section_number ASC
      `;
      const existingTexts = existing.map(r => (r.script_text as string).trim());
      const candidateTexts = candidate.map(s => s.script_text.trim());
      const same =
        existingTexts.length === candidateTexts.length &&
        existingTexts.every((t, i) => t === candidateTexts[i]);
      if (same) return false;
    }

    const sections = candidate;
    await sql`DELETE FROM narrator_sections WHERE assignment_id = ${assignmentId}`;
    await sql`
      UPDATE narrator_assignments
      SET script_id = ${activeScript.id}, script_version = ${activeScript.version}, updated_at = NOW()
      WHERE id = ${assignmentId}
    `;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      await createSection({
        assignment_id: assignmentId,
        section_number: i + 1,
        label: s.label,
        script_text: s.script_text,
        emphasis_markers: s.emphasis_markers,
        estimated_duration_seconds: s.estimated_duration_seconds,
      });
    }
    return true;
  } catch (e) {
    console.warn('resyncAssignmentSectionsIfStale failed:', e);
    return false;
  }
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

// ---------------------------------------------------------------------------
// Per-take timestamped review comments (Frame.io-style)
// ---------------------------------------------------------------------------

export interface NarrationTakeComment {
  id: string;
  take_id: string;
  timestamp_ms: number;
  end_timestamp_ms: number | null;
  text: string;
  author_name: string;
  author_color: string;
  author_role: 'owner' | 'narrator';
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  parent_id: string | null;
  fix_for_comment_id: string | null;
  created_at: string;
}

export async function createTakeComment(fields: {
  take_id: string;
  timestamp_ms: number;
  /** When set and > timestamp_ms, this is a RANGE comment. */
  end_timestamp_ms?: number | null;
  text: string;
  author_name: string;
  author_color?: string;
  author_role: 'owner' | 'narrator';
  parent_id?: string | null;
  fix_for_comment_id?: string | null;
}) {
  await ensureNarratorSchema();
  // Coerce a reversed/equal range to null so weird input doesn't end up as
  // a hidden bug. Mirrors createComment() in review-db.ts.
  let endMs: number | null = null;
  if (typeof fields.end_timestamp_ms === 'number' && fields.end_timestamp_ms > fields.timestamp_ms) {
    endMs = fields.end_timestamp_ms;
  }
  const { rows } = await sql`
    INSERT INTO narration_take_comments
      (take_id, timestamp_ms, end_timestamp_ms, text, author_name, author_color, author_role, parent_id, fix_for_comment_id)
    VALUES (
      ${fields.take_id},
      ${Math.max(0, Math.round(fields.timestamp_ms))},
      ${endMs},
      ${fields.text},
      ${fields.author_name},
      ${fields.author_color || '#7c3aed'},
      ${fields.author_role},
      ${fields.parent_id ?? null},
      ${fields.fix_for_comment_id ?? null}
    )
    RETURNING *
  `;
  return rows[0] as NarrationTakeComment;
}

export async function getTakeComments(takeId: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT * FROM narration_take_comments
    WHERE take_id = ${takeId}
    ORDER BY timestamp_ms ASC, created_at ASC
  `;
  return rows as NarrationTakeComment[];
}

/** All comments across every take in an assignment — used for the owner-side
 *  count badges and the "request retake" auto-summary. */
export async function getTakeCommentsForAssignment(assignmentId: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT c.* FROM narration_take_comments c
    JOIN narrator_takes t ON t.id = c.take_id
    JOIN narrator_sections s ON s.id = t.section_id
    WHERE s.assignment_id = ${assignmentId}
    ORDER BY c.created_at ASC
  `;
  return rows as NarrationTakeComment[];
}

export async function resolveTakeComment(commentId: string, resolvedBy: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    UPDATE narration_take_comments
    SET resolved = true, resolved_by = ${resolvedBy}, resolved_at = NOW()
    WHERE id = ${commentId}
    RETURNING *
  `;
  return (rows[0] as NarrationTakeComment) ?? null;
}

export async function unresolveTakeComment(commentId: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    UPDATE narration_take_comments
    SET resolved = false, resolved_by = NULL, resolved_at = NULL
    WHERE id = ${commentId}
    RETURNING *
  `;
  return (rows[0] as NarrationTakeComment) ?? null;
}

export async function deleteTakeComment(commentId: string) {
  await ensureNarratorSchema();
  await sql`DELETE FROM narration_take_comments WHERE id = ${commentId}`;
}

/** Walk back up the take ownership chain to verify a comment lives under a
 *  given assignment. Used by both owner + token routes to enforce scoping. */
export async function getTakeCommentScope(commentId: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT c.id, c.author_name, c.author_role, t.id AS take_id, s.id AS section_id, s.assignment_id
    FROM narration_take_comments c
    JOIN narrator_takes t ON t.id = c.take_id
    JOIN narrator_sections s ON s.id = t.section_id
    WHERE c.id = ${commentId}
    LIMIT 1
  `;
  return (rows[0] as {
    id: string;
    author_name: string;
    author_role: 'owner' | 'narrator';
    take_id: string;
    section_id: string;
    assignment_id: string;
  }) ?? null;
}

/** Lookup helper for posting a comment: confirm a take belongs to an assignment. */
export async function getTakeAssignmentScope(takeId: string) {
  await ensureNarratorSchema();
  const { rows } = await sql`
    SELECT t.id AS take_id, s.id AS section_id, s.assignment_id
    FROM narrator_takes t
    JOIN narrator_sections s ON s.id = t.section_id
    WHERE t.id = ${takeId}
    LIMIT 1
  `;
  return (rows[0] as { take_id: string; section_id: string; assignment_id: string }) ?? null;
}
