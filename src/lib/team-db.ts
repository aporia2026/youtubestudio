import { sql } from '@vercel/postgres';

// ---------------------------------------------------------------------------
// Schema migration (idempotent)
// ---------------------------------------------------------------------------

let teamMigrated = false;

export async function ensureTeamSchema() {
  if (teamMigrated) return;
  try {
    // Create collaborators table
    await sql`
      CREATE TABLE IF NOT EXISTS collaborators (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'reviewer'
          CHECK (role IN ('editor','narrator','reviewer','client')),
        color TEXT NOT NULL DEFAULT '#7c3aed',
        specialties JSONB DEFAULT '[]',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Migrate narrator_profiles into collaborators (preserving IDs)
    try {
      await sql`
        INSERT INTO collaborators (id, name, email, color, specialties, notes, role, created_at)
        SELECT id, name, email, color, COALESCE(specialties, '[]'::jsonb), notes, 'narrator', created_at
        FROM narrator_profiles
        ON CONFLICT (id) DO NOTHING
      `;
    } catch (e) { console.warn('narrator_profiles migration:', e); }

    // Add tracking columns to review_share_links
    try { await sql`ALTER TABLE review_share_links ADD COLUMN IF NOT EXISTS collaborator_id UUID`; } catch {}
    try { await sql`ALTER TABLE review_share_links ADD COLUMN IF NOT EXISTS label TEXT`; } catch {}
    try { await sql`ALTER TABLE review_share_links ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`; } catch {}
    try { await sql`ALTER TABLE review_share_links ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0`; } catch {}

    // Add tracking columns to narrator_assignments
    try { await sql`ALTER TABLE narrator_assignments ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`; } catch {}
    try { await sql`ALTER TABLE narrator_assignments ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0`; } catch {}

    // Notification columns on collaborators
    try { await sql`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT true`; } catch {}
    try { await sql`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT`; } catch {}
    // Backfill missing tokens
    try { await sql`UPDATE collaborators SET unsubscribe_token = encode(gen_random_bytes(24), 'hex') WHERE unsubscribe_token IS NULL`; } catch {}
    try { await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_collaborators_unsubscribe_token ON collaborators(unsubscribe_token)`; } catch {}

    // Personal token for narrator dashboard (one URL = all their assignments)
    try { await sql`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS personal_token TEXT`; } catch {}
    try { await sql`UPDATE collaborators SET personal_token = encode(gen_random_bytes(24), 'hex') WHERE personal_token IS NULL`; } catch {}
    try { await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_collaborators_personal_token ON collaborators(personal_token)`; } catch {}

    teamMigrated = true;
  } catch (err) {
    console.error('ensureTeamSchema error:', err);
  }
}

// ---------------------------------------------------------------------------
// Collaborator CRUD
// ---------------------------------------------------------------------------

export async function createCollaborator(fields: {
  name: string;
  email?: string;
  role?: string;
  color?: string;
  specialties?: string[];
  notes?: string;
}) {
  await ensureTeamSchema();
  // Generate long random tokens (48-char hex). Used in unsubscribe + dashboard URLs.
  const unsubscribeToken = Array.from({ length: 6 }, () => Math.random().toString(16).slice(2, 10)).join('');
  const personalToken = Array.from({ length: 6 }, () => Math.random().toString(16).slice(2, 10)).join('');
  const { rows } = await sql`
    INSERT INTO collaborators (name, email, role, color, specialties, notes, unsubscribe_token, personal_token)
    VALUES (${fields.name}, ${fields.email ?? null}, ${fields.role ?? 'reviewer'}, ${fields.color ?? '#7c3aed'}, ${JSON.stringify(fields.specialties || [])}, ${fields.notes ?? null}, ${unsubscribeToken}, ${personalToken})
    RETURNING *
  `;

  // Also insert into narrator_profiles for backwards compatibility if role is narrator
  if ((fields.role ?? 'reviewer') === 'narrator') {
    try {
      await sql`
        INSERT INTO narrator_profiles (id, name, email, color, specialties, notes)
        VALUES (${rows[0].id}, ${fields.name}, ${fields.email ?? null}, ${fields.color ?? '#7c3aed'}, ${JSON.stringify(fields.specialties || [])}, ${fields.notes ?? null})
        ON CONFLICT (id) DO NOTHING
      `;
    } catch {}
  }

  return rows[0];
}

export async function listCollaborators(role?: string) {
  await ensureTeamSchema();
  if (role) {
    const { rows } = await sql`SELECT * FROM collaborators WHERE role = ${role} ORDER BY name ASC`;
    return rows;
  }
  const { rows } = await sql`SELECT * FROM collaborators ORDER BY name ASC`;
  return rows;
}

export async function getCollaborator(id: string) {
  await ensureTeamSchema();
  const { rows } = await sql`SELECT * FROM collaborators WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function updateCollaborator(id: string, fields: {
  name?: string;
  email?: string;
  role?: string;
  color?: string;
  specialties?: string[];
  notes?: string;
}) {
  await ensureTeamSchema();
  const { rows } = await sql`
    UPDATE collaborators
    SET name = COALESCE(${fields.name ?? null}, name),
        email = COALESCE(${fields.email ?? null}, email),
        role = COALESCE(${fields.role ?? null}, role),
        color = COALESCE(${fields.color ?? null}, color),
        specialties = COALESCE(${fields.specialties ? JSON.stringify(fields.specialties) : null}, specialties),
        notes = COALESCE(${fields.notes ?? null}, notes)
    WHERE id = ${id}
    RETURNING *
  `;

  // Sync to narrator_profiles
  if (rows[0]) {
    try {
      await sql`
        UPDATE narrator_profiles
        SET name = ${rows[0].name}, email = ${rows[0].email}, color = ${rows[0].color},
            specialties = ${JSON.stringify(rows[0].specialties || [])}::jsonb, notes = ${rows[0].notes}
        WHERE id = ${id}
      `;
    } catch {}
  }

  return rows[0] ?? null;
}

export async function deleteCollaborator(id: string) {
  await ensureTeamSchema();
  // Clear collaborator references from share links before deleting
  try { await sql`UPDATE review_share_links SET collaborator_id = NULL WHERE collaborator_id = ${id}`; } catch (e) { console.warn('share link cleanup:', e); }
  // Deactivate narrator assignments before removing profile (avoids FK violations)
  try { await sql`UPDATE narrator_assignments SET status = 'completed' WHERE narrator_id = ${id} AND status != 'completed'`; } catch (e) { console.warn('assignment deactivation:', e); }
  try { await sql`DELETE FROM narrator_profiles WHERE id = ${id}`; } catch (e) { console.warn('narrator_profiles cleanup:', e); }
  await sql`DELETE FROM collaborators WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Access Overview
// ---------------------------------------------------------------------------

export async function getCollaboratorWithAccess(id: string) {
  await ensureTeamSchema();
  const collaborator = await getCollaborator(id);
  if (!collaborator) return null;

  // Get review links assigned to this collaborator
  const { rows: reviewLinks } = await sql`
    SELECT s.*, p.title AS project_title
    FROM review_share_links s
    JOIN review_projects p ON p.id = s.project_id
    WHERE s.collaborator_id = ${id}
    ORDER BY s.created_at DESC
  `;

  // Get narrator assignments (via narrator_id matching collaborator id)
  const { rows: assignments } = await sql`
    SELECT a.*, p.title AS project_title,
      (SELECT COUNT(*)::int FROM narrator_sections ns WHERE ns.assignment_id = a.id) AS total_sections,
      (SELECT COUNT(*)::int FROM narrator_sections ns WHERE ns.assignment_id = a.id AND ns.status = 'approved') AS approved_sections
    FROM narrator_assignments a
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.narrator_id = ${id}
    ORDER BY a.updated_at DESC
  `;

  return { ...collaborator, reviewLinks, assignments };
}

export async function getTeamOverview() {
  await ensureTeamSchema();

  // All collaborators with their access counts and last activity
  const { rows } = await sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM review_share_links s WHERE s.collaborator_id = c.id) AS review_link_count,
      (SELECT COUNT(*)::int FROM narrator_assignments a WHERE a.narrator_id = c.id) AS assignment_count,
      GREATEST(
        (SELECT MAX(s.last_accessed_at) FROM review_share_links s WHERE s.collaborator_id = c.id),
        (SELECT MAX(a.last_accessed_at) FROM narrator_assignments a WHERE a.narrator_id = c.id)
      ) AS last_activity
    FROM collaborators c
    ORDER BY last_activity DESC NULLS LAST, c.name ASC
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Bulk Revoke
// ---------------------------------------------------------------------------

/**
 * Look up a collaborator by their personal token, used for the narrator
 * dashboard at /narrator/[token]. Returns null if not found or not a narrator.
 */
export async function getNarratorByPersonalToken(token: string) {
  await ensureTeamSchema();
  const { rows } = await sql`
    SELECT id, name, email, color, role, personal_token, notifications_enabled
    FROM collaborators WHERE personal_token = ${token} AND role = 'narrator'
    LIMIT 1
  `;
  return rows[0] || null;
}

/** Look up an editor by their personal token (used for /editor/[token]). */
export async function getEditorByPersonalToken(token: string) {
  await ensureTeamSchema();
  const { rows } = await sql`
    SELECT id, name, email, color, role, personal_token, notifications_enabled
    FROM collaborators WHERE personal_token = ${token} AND role = 'editor'
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function revokeAllAccess(collaboratorId: string) {
  await ensureTeamSchema();

  // Delete all review share links assigned to this collaborator
  const { rowCount: linksDeleted } = await sql`
    DELETE FROM review_share_links WHERE collaborator_id = ${collaboratorId}
  `;

  // Deactivate (don't delete) narrator assignments — set status to 'completed'
  const { rowCount: assignmentsDeactivated } = await sql`
    UPDATE narrator_assignments
    SET status = 'completed', updated_at = NOW()
    WHERE narrator_id = ${collaboratorId} AND status NOT IN ('completed')
  `;

  return { linksDeleted: linksDeleted ?? 0, assignmentsDeactivated: assignmentsDeactivated ?? 0 };
}
