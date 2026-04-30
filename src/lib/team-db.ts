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

    // Availability the collaborator self-reports — surfaced to the owner on
    // the team page and to the dashboards. Free-form status_note for a one
    // line "out till Friday" / "deep in editing". Defaults intentionally
    // null so existing rows don't get a fake "available" badge.
    try { await sql`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS availability TEXT`; } catch {}
    try { await sql`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS status_note TEXT`; } catch {}
    try { await sql`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS availability_updated_at TIMESTAMPTZ`; } catch {}

    // Per-collaborator notification preferences. Granular event-type opt-outs
    // beyond the global notifications_enabled toggle. Stored as a jsonb blob
    // so we can add new event keys without further migrations. Empty object
    // = receive everything; explicit false on a key = mute that event type.
    try { await sql`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb`; } catch {}

    // Multi-role support — `role` (singular) stays as the legacy "primary"
    // role for back-compat with existing queries. `roles` is the new source
    // of truth (an array). Backfill it from `role` for any rows where it's
    // NULL so the rest of the codebase can rely on it being populated.
    try { await sql`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS roles TEXT[]`; } catch {}
    try { await sql`UPDATE collaborators SET roles = ARRAY[role] WHERE roles IS NULL AND role IS NOT NULL`; } catch {}

    teamMigrated = true;
  } catch (err) {
    console.error('ensureTeamSchema error:', err);
  }
}

// ---------------------------------------------------------------------------
// Collaborator CRUD
// ---------------------------------------------------------------------------

/** Normalise a roles input — accepts a string, an array of strings, or
 *  nothing — and produces { primary, all } where primary is the first role
 *  (used for the legacy `role` column) and all is the deduped array of roles
 *  to write to the `roles` column. */
function normalizeRoles(roleField: string | undefined, rolesField: string[] | undefined): { primary: string; all: string[] } {
  const validRoles = new Set(['editor', 'narrator', 'reviewer', 'client']);
  const collected: string[] = [];
  if (Array.isArray(rolesField)) {
    for (const r of rolesField) if (validRoles.has(r) && !collected.includes(r)) collected.push(r);
  }
  if (roleField && validRoles.has(roleField) && !collected.includes(roleField)) {
    collected.push(roleField);
  }
  if (collected.length === 0) collected.push('reviewer'); // safe default
  return { primary: collected[0], all: collected };
}

export async function createCollaborator(fields: {
  name: string;
  email?: string;
  role?: string;
  /** Multiple roles — stored in the new roles[] column. Order matters: the
   *  first role becomes the legacy "primary" role. */
  roles?: string[];
  color?: string;
  specialties?: string[];
  notes?: string;
}) {
  await ensureTeamSchema();
  // Generate long random tokens (48-char hex). Used in unsubscribe + dashboard URLs.
  const unsubscribeToken = Array.from({ length: 6 }, () => Math.random().toString(16).slice(2, 10)).join('');
  const personalToken = Array.from({ length: 6 }, () => Math.random().toString(16).slice(2, 10)).join('');
  const { primary, all } = normalizeRoles(fields.role, fields.roles);
  // sql.query() (the lower-level pg interface) handles TEXT[] parameter binding
  // natively. The template-literal `sql` tag does not, so we use query() here.
  const { rows } = await sql.query(
    `INSERT INTO collaborators (name, email, role, roles, color, specialties, notes, unsubscribe_token, personal_token)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING *`,
    [
      fields.name,
      fields.email ?? null,
      primary,
      all,
      fields.color ?? '#7c3aed',
      JSON.stringify(fields.specialties || []),
      fields.notes ?? null,
      unsubscribeToken,
      personalToken,
    ],
  );

  // Also insert into narrator_profiles for backwards compatibility if narrator is one of the roles
  if (all.includes('narrator')) {
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
    // Match the role against EITHER the legacy `role` column or the `roles[]`
    // array — old rows might only have `role` set if the migration backfill
    // didn't run, and the new code writes both.
    const { rows } = await sql`
      SELECT * FROM collaborators
      WHERE role = ${role} OR ${role} = ANY(COALESCE(roles, ARRAY[role]))
      ORDER BY name ASC
    `;
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
  /** When provided, replaces the entire roles array. The legacy `role` column
   *  is synced to roles[0]. To clear all roles, pass an empty array — but
   *  normalizeRoles will fall back to 'reviewer' so a person always has at
   *  least one role. */
  roles?: string[];
  color?: string;
  specialties?: string[];
  notes?: string;
}) {
  await ensureTeamSchema();
  // Roles are only updated when the caller actually provided them. Otherwise
  // we leave the existing values alone so a partial PATCH doesn't wipe roles.
  const rolesProvided = fields.roles !== undefined || fields.role !== undefined;
  let primary: string | null = null;
  let all: string[] | null = null;
  if (rolesProvided) {
    const norm = normalizeRoles(fields.role, fields.roles);
    primary = norm.primary;
    all = norm.all;
  }
  // sql.query() handles TEXT[] parameter binding natively (the template tag
  // does not). Empty/omitted fields stay as-is via COALESCE.
  const { rows } = await sql.query(
    `UPDATE collaborators
     SET name = COALESCE($1, name),
         email = COALESCE($2, email),
         role = COALESCE($3, role),
         roles = COALESCE($4::text[], roles),
         color = COALESCE($5, color),
         specialties = COALESCE($6::jsonb, specialties),
         notes = COALESCE($7, notes)
     WHERE id = $8
     RETURNING *`,
    [
      fields.name ?? null,
      fields.email ?? null,
      primary,
      all,
      fields.color ?? null,
      fields.specialties ? JSON.stringify(fields.specialties) : null,
      fields.notes ?? null,
      id,
    ],
  );

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
  // Clear collaborator references from share links before deleting.
  try { await sql`UPDATE review_share_links SET collaborator_id = NULL WHERE collaborator_id = ${id}`; } catch (e) { console.warn('share link cleanup:', e); }

  // Hard-delete narrator assignments. This cascades to narrator_sections,
  // narrator_takes, and narrator_comments via ON DELETE CASCADE.
  //
  // Why hard-delete: the FK narrator_assignments.narrator_id REFERENCES
  // narrator_profiles(id) has no ON DELETE clause, so leaving the rows
  // around (the previous "soft-deactivate" approach) made the subsequent
  // DELETE FROM narrator_profiles silently fail with an FK violation.
  // The narrator_profiles row would then survive, and on the next Lambda
  // cold start the team-schema migration would re-import it into the
  // collaborators table — the deleted person would visibly come back.
  // The "Revoke All" action is the soft alternative; Delete means delete.
  try { await sql`DELETE FROM narrator_assignments WHERE narrator_id = ${id}`; } catch (e) { console.warn('narrator_assignments cleanup:', e); }

  try { await sql`DELETE FROM narrator_profiles WHERE id = ${id}`; } catch (e) { console.warn('narrator_profiles cleanup:', e); }
  // editor_assignments cascades automatically via FK ON DELETE CASCADE.
  await sql`DELETE FROM collaborators WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Access Overview
// ---------------------------------------------------------------------------

export async function getCollaboratorWithAccess(id: string) {
  await ensureTeamSchema();
  let collaborator = await getCollaborator(id);
  if (!collaborator) return null;

  // Self-heal: if the personal_token column was added but the SQL backfill
  // didn't run (pgcrypto missing, etc.), the row may have personal_token=NULL.
  // Generate one in app code now so the dashboard link works on next render.
  if (!collaborator.personal_token) {
    const token = Array.from({ length: 6 }, () => Math.random().toString(16).slice(2, 10)).join('');
    try {
      const { rows } = await sql`
        UPDATE collaborators SET personal_token = ${token} WHERE id = ${id} AND personal_token IS NULL RETURNING *
      `;
      if (rows[0]) collaborator = rows[0];
    } catch (e) { console.warn('personal_token backfill on read failed:', e); }
  }

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

  // Get editor assignments (only fetched if the editor_assignments table exists yet)
  let editorAssignments: Array<{ id: string; project_id: string; project_title: string; status: string; deadline: string | null; last_accessed_at: string | null; updated_at: string }> = [];
  try {
    const { rows } = await sql`
      SELECT ea.id, ea.project_id, ea.status, ea.deadline, ea.last_accessed_at, ea.updated_at,
        p.title AS project_title
      FROM editor_assignments ea
      LEFT JOIN projects p ON p.id = ea.project_id
      WHERE ea.editor_id = ${id}
      ORDER BY ea.updated_at DESC
    `;
    editorAssignments = rows as typeof editorAssignments;
  } catch {} // Table may not exist yet on a fresh DB

  return { ...collaborator, reviewLinks, assignments, editorAssignments };
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

/**
 * Role-agnostic lookup. The same personal_token serves whichever role(s)
 * a collaborator has, so any "this person's account" endpoint (activity
 * feed, preferences, availability) should accept the token without
 * requiring a specific role.
 */
export async function getCollaboratorByPersonalToken(token: string) {
  await ensureTeamSchema();
  const { rows } = await sql`
    SELECT id, name, email, color, role, roles, personal_token, notifications_enabled,
           availability, status_note, availability_updated_at, notification_prefs
    FROM collaborators WHERE personal_token = ${token}
    LIMIT 1
  `;
  return rows[0] || null;
}

/** Update self-reported availability + free-form status note. */
export async function updateCollaboratorAvailability(id: string, fields: { availability?: string | null; status_note?: string | null }) {
  await ensureTeamSchema();
  await sql`
    UPDATE collaborators
    SET availability = COALESCE(${fields.availability ?? null}, availability),
        status_note = ${fields.status_note ?? null},
        availability_updated_at = NOW()
    WHERE id = ${id}
  `;
}

/** Update notification_prefs jsonb. Caller passes a partial patch object;
 *  we shallow-merge it with the existing blob via jsonb || jsonb. */
export async function updateCollaboratorNotificationPrefs(id: string, patch: Record<string, unknown>) {
  await ensureTeamSchema();
  await sql`
    UPDATE collaborators
    SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE id = ${id}
  `;
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
