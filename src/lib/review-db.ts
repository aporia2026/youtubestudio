import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Schema migration (idempotent)
// ---------------------------------------------------------------------------

let reviewMigrated = false;

export async function ensureReviewSchema() {
  if (reviewMigrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS review_projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'in-review'
          CHECK (status IN ('in-review', 'needs-changes', 'approved')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS review_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES review_projects(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL DEFAULT 1,
        video_url TEXT,
        r2_key TEXT NOT NULL,
        thumbnail_url TEXT,
        duration_ms INTEGER,
        uploaded_by TEXT NOT NULL DEFAULT 'owner',
        file_size BIGINT,
        width INTEGER,
        height INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(project_id, version_number)
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_review_versions_project ON review_versions(project_id)`; } catch {}

    await sql`
      CREATE TABLE IF NOT EXISTS review_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        version_id UUID NOT NULL REFERENCES review_versions(id) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        text TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_color TEXT NOT NULL DEFAULT '#7c3aed',
        drawing_data JSONB,
        drawing_thumbnail_url TEXT,
        resolved BOOLEAN NOT NULL DEFAULT false,
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        parent_id UUID REFERENCES review_comments(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_review_comments_version ON review_comments(version_id)`; } catch {}
    // Range comments: when end_timestamp_ms is set, the comment applies from
    // timestamp_ms .. end_timestamp_ms (inclusive). NULL = point-in-time comment.
    try { await sql`ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS end_timestamp_ms INTEGER`; } catch {}
    // Fix-note linkage: when an editor uploads a corrected version they can
    // attach a "what I fixed" note per original feedback comment. The note
    // is stored as a regular comment on the NEW version, with this column
    // pointing back to the original comment from the previous version. The
    // owner can then see the fix note alongside their original feedback on
    // the v2 timeline.
    try { await sql`ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS fix_for_comment_id UUID REFERENCES review_comments(id) ON DELETE SET NULL`; } catch {}
    // Migration 0050 adds posted_by_owner across the three comment tables for
    // the team-hub "Act as <collaborator>" escalation. The activity feed in
    // team-hub-activity-db reads c.posted_by_owner from review_comments, so
    // a database that hasn't yet run 0050 surfaces "column does not exist"
    // there. Heal it here on the same idempotent pattern.
    try { await sql`ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS posted_by_owner BOOLEAN NOT NULL DEFAULT false`; } catch {}

    await sql`
      CREATE TABLE IF NOT EXISTS review_share_links (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES review_projects(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        permission TEXT NOT NULL DEFAULT 'can-comment'
          CHECK (permission IN ('view-only', 'can-comment', 'can-annotate')),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_review_share_token ON review_share_links(token)`; } catch {}

    // Team management columns
    try { await sql`ALTER TABLE review_share_links ADD COLUMN IF NOT EXISTS collaborator_id UUID`; } catch {}
    try { await sql`ALTER TABLE review_share_links ADD COLUMN IF NOT EXISTS label TEXT`; } catch {}
    try { await sql`ALTER TABLE review_share_links ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`; } catch {}
    try { await sql`ALTER TABLE review_share_links ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0`; } catch {}

    reviewMigrated = true;
  } catch (err) {
    logger.error('ensureReviewSchema error', { detail: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

// -- Projects ----------------------------------------------------------------

export async function createProject(title: string, description: string | undefined, workspaceId: string) {
  await ensureReviewSchema();
  // workspace_id is NOT NULL on review_projects since migration 0013. Skipping
  // it here used to throw a Postgres NOT NULL violation on the editor's very
  // first upload — a 500 returned only after compression + thumbnail probe
  // had already eaten minutes in the browser, so it felt like a hang.
  const { rows } = await sql`
    INSERT INTO review_projects (title, description, workspace_id)
    VALUES (${title}, ${description ?? null}, ${workspaceId}::uuid)
    RETURNING *
  `;
  return rows[0];
}

export async function listProjects(workspaceId: string) {
  await ensureReviewSchema();
  // Tenant-scoped: review_projects.workspace_id is NOT NULL since 0013.
  const { rows } = await sql`
    SELECT p.*,
      (SELECT COUNT(*)::int FROM review_versions v WHERE v.project_id = p.id) AS version_count,
      (SELECT COUNT(*)::int FROM review_share_links s WHERE s.project_id = p.id) AS link_count
    FROM review_projects p
    WHERE p.workspace_id = ${workspaceId}::uuid
    ORDER BY p.updated_at DESC
  `;
  return rows;
}

export async function getProject(id: string) {
  await ensureReviewSchema();
  const { rows } = await sql`SELECT * FROM review_projects WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function updateProject(id: string, fields: { title?: string; description?: string; status?: string }) {
  await ensureReviewSchema();
  const { rows } = await sql`
    UPDATE review_projects
    SET title = COALESCE(${fields.title ?? null}, title),
        description = COALESCE(${fields.description ?? null}, description),
        status = COALESCE(${fields.status ?? null}, status),
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function deleteProject(id: string) {
  await ensureReviewSchema();
  await sql`DELETE FROM review_projects WHERE id = ${id}`;
}

// -- Versions ----------------------------------------------------------------

export async function createVersion(projectId: string, r2Key: string, uploadedBy: string, fileSize?: number) {
  await ensureReviewSchema();
  // Atomic version_number increment via subquery. workspace_id is NOT NULL
  // on review_versions since migration 0013 — copy it from the parent
  // review_project so callers don't need session context.
  const { rows } = await sql`
    INSERT INTO review_versions (project_id, version_number, r2_key, uploaded_by, file_size, workspace_id)
    SELECT ${projectId}::uuid,
           (SELECT COALESCE(MAX(version_number), 0) + 1 FROM review_versions WHERE project_id = ${projectId}::uuid),
           ${r2Key}, ${uploadedBy}, ${fileSize ?? null}, rp.workspace_id
      FROM review_projects rp WHERE rp.id = ${projectId}::uuid
    RETURNING *
  `;
  if (rows.length === 0) {
    throw new Error(`Review project ${projectId} not found — cannot create version`);
  }
  return rows[0];
}

export async function getVersions(projectId: string) {
  await ensureReviewSchema();
  const { rows } = await sql`
    SELECT * FROM review_versions
    WHERE project_id = ${projectId}
    ORDER BY version_number ASC
  `;
  return rows;
}

export async function getVersion(versionId: string) {
  await ensureReviewSchema();
  const { rows } = await sql`SELECT * FROM review_versions WHERE id = ${versionId}`;
  return rows[0] ?? null;
}

export async function updateVersion(versionId: string, fields: { thumbnail_url?: string; duration_ms?: number; width?: number; height?: number; video_url?: string }) {
  await ensureReviewSchema();
  const { rows } = await sql`
    UPDATE review_versions
    SET thumbnail_url = COALESCE(${fields.thumbnail_url ?? null}, thumbnail_url),
        duration_ms = COALESCE(${fields.duration_ms ?? null}, duration_ms),
        width = COALESCE(${fields.width ?? null}, width),
        height = COALESCE(${fields.height ?? null}, height),
        video_url = COALESCE(${fields.video_url ?? null}, video_url)
    WHERE id = ${versionId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// -- Comments ----------------------------------------------------------------

export async function createComment(fields: {
  version_id: string;
  timestamp_ms: number;
  /** When set, this is a RANGE comment applying from timestamp_ms..end_timestamp_ms. */
  end_timestamp_ms?: number | null;
  text: string;
  author_name: string;
  author_color: string;
  drawing_data?: unknown;
  drawing_thumbnail_url?: string;
  parent_id?: string;
}) {
  await ensureReviewSchema();
  // Validate range — end must be >= start. Silently coerce to null if reversed
  // so weird input doesn't end up as a hidden bug in the DB.
  let endMs: number | null = null;
  if (typeof fields.end_timestamp_ms === 'number' && fields.end_timestamp_ms > fields.timestamp_ms) {
    endMs = fields.end_timestamp_ms;
  }
  // workspace_id is NOT NULL on review_comments since migration 0013 — copy
  // it from the parent review_version so callers don't need session context.
  const { rows } = await sql`
    INSERT INTO review_comments (version_id, timestamp_ms, end_timestamp_ms, text, author_name, author_color, drawing_data, drawing_thumbnail_url, parent_id, workspace_id)
    SELECT ${fields.version_id}::uuid, ${fields.timestamp_ms}, ${endMs},
           ${fields.text}, ${fields.author_name}, ${fields.author_color},
           ${fields.drawing_data ? JSON.stringify(fields.drawing_data) : null}::jsonb,
           ${fields.drawing_thumbnail_url ?? null},
           ${fields.parent_id ?? null}::uuid,
           v.workspace_id
      FROM review_versions v WHERE v.id = ${fields.version_id}::uuid
    RETURNING *
  `;
  if (rows.length === 0) {
    throw new Error(`Review version ${fields.version_id} not found — cannot create comment`);
  }
  return rows[0];
}

export async function getComments(versionId: string) {
  await ensureReviewSchema();
  const { rows } = await sql`
    SELECT * FROM review_comments
    WHERE version_id = ${versionId}
    ORDER BY timestamp_ms ASC, created_at ASC
  `;
  return rows;
}

export async function getCommentsForProject(projectId: string) {
  await ensureReviewSchema();
  const { rows } = await sql`
    SELECT c.*, v.version_number
    FROM review_comments c
    JOIN review_versions v ON v.id = c.version_id
    WHERE v.project_id = ${projectId}
    ORDER BY c.timestamp_ms ASC, c.created_at ASC
  `;
  return rows;
}

export async function resolveComment(commentId: string, resolvedBy: string) {
  await ensureReviewSchema();
  const { rows } = await sql`
    UPDATE review_comments
    SET resolved = true, resolved_by = ${resolvedBy}, resolved_at = NOW()
    WHERE id = ${commentId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function unresolveComment(commentId: string) {
  await ensureReviewSchema();
  const { rows } = await sql`
    UPDATE review_comments
    SET resolved = false, resolved_by = NULL, resolved_at = NULL
    WHERE id = ${commentId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// -- Share Links -------------------------------------------------------------

export async function createShareLink(projectId: string, permission: string = 'can-comment', expiresAt?: string, collaboratorId?: string, label?: string) {
  await ensureReviewSchema();
  const token = crypto.randomUUID();
  // workspace_id is NOT NULL on review_share_links since migration 0013;
  // copy it from the parent review_project so callers don't need session
  // context. Mirrors the INSERT … SELECT pattern used in narrator-db.
  const { rows } = await sql`
    INSERT INTO review_share_links (project_id, token, permission, expires_at, collaborator_id, label, workspace_id)
    SELECT ${projectId}::uuid, ${token}, ${permission}, ${expiresAt ?? null}::timestamptz, ${collaboratorId ?? null}::uuid, ${label ?? null}, rp.workspace_id
      FROM review_projects rp WHERE rp.id = ${projectId}::uuid
    RETURNING *
  `;
  if (rows.length === 0) {
    throw new Error(`Review project ${projectId} not found — cannot create share link`);
  }
  return rows[0];
}

export async function getShareLinks(projectId: string) {
  await ensureReviewSchema();
  // Try to JOIN collaborators (may not exist yet on fresh DBs)
  try {
    const { rows } = await sql`
      SELECT s.*, c.name AS collaborator_name, c.role AS collaborator_role, c.color AS collaborator_color
      FROM review_share_links s
      LEFT JOIN collaborators c ON c.id = s.collaborator_id
      WHERE s.project_id = ${projectId}
      ORDER BY s.created_at DESC
    `;
    return rows;
  } catch {
    const { rows } = await sql`
      SELECT * FROM review_share_links WHERE project_id = ${projectId} ORDER BY created_at DESC
    `;
    return rows;
  }
}

export async function getShareLinkByToken(token: string) {
  await ensureReviewSchema();
  const { rows } = await sql`
    SELECT s.*, p.title AS project_title, p.description AS project_description, p.status AS project_status, p.id AS project_id
    FROM review_share_links s
    JOIN review_projects p ON p.id = s.project_id
    WHERE s.token = ${token}
  `;
  const link = rows[0] ?? null;
  if (!link) return null;
  // Check expiry
  if (link.expires_at && new Date(link.expires_at) < new Date()) return null;
  return link;
}

export async function deleteShareLink(linkId: string) {
  await ensureReviewSchema();
  await sql`DELETE FROM review_share_links WHERE id = ${linkId}`;
}
