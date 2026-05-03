import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { countWords, estimateDuration } from '@/lib/utils';
import { resyncAssignmentSectionsIfStale } from '@/lib/narrator-db';
import { logger } from '@/lib/logger';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';

/**
 * Audit C1: previously had ZERO auth and ZERO workspace filter — anyone
 * who guessed a project UUID could dump every script in the DB. Now
 * wrapped in apiRoute.authed and every query is scoped via the parent
 * project's workspace_id (matched against session.ws). Returns 404
 * for projects in other workspaces (no info leak via 403).
 */
export const GET = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // The project ownership check is folded into the WHERE clause:
    // join scripts → projects, only return rows whose parent project
    // belongs to this workspace.
    const result = await sql`
      SELECT s.*
        FROM scripts s
        JOIN projects p ON p.id = s.project_id
       WHERE s.project_id = ${id}::uuid
         AND p.workspace_id = ${session.ws}::uuid
       ORDER BY s.version DESC
    `;
    return NextResponse.json({ scripts: result.rows });
  },
);

export const POST = apiRoute.authed(
  async (session, req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const { content, modelId } = await req.json();

    if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 });

    try {
      // Verify the project belongs to this workspace before any
      // mutating writes — no side-effects on a 404.
      const projectCheck = await sql`
        SELECT 1 FROM projects
         WHERE id = ${id}::uuid
           AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (projectCheck.rows.length === 0) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }

      // Get next version number
      const versionResult = await sql`
        SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM scripts WHERE project_id = ${id}
      `;
      const nextVersion = versionResult.rows[0].next_version;

      const words = countWords(content);
      const duration = estimateDuration(words);

      // INSERT first, deactivate-others second. Order matters: if the second
      // statement fails we briefly have two active rows (recoverable on the
      // next save), but if we deactivated first and the INSERT failed we'd
      // leave the project with zero active rows and the UI would render
      // "(no script yet)" despite versions existing in the table.
      //
      // workspace_id pulled from the parent project (verified above).
      const result = await sql`
        INSERT INTO scripts (project_id, version, content, word_count, estimated_duration_seconds, ai_model, is_active, workspace_id)
        SELECT ${id}::uuid, ${nextVersion}, ${content}, ${words}, ${duration}, ${modelId || null}, true, p.workspace_id
          FROM projects p
         WHERE p.id = ${id}::uuid
           AND p.workspace_id = ${session.ws}::uuid
        RETURNING *
      `;
      if (result.rows.length === 0) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      const newId = result.rows[0].id;
      await sql`UPDATE scripts SET is_active = false WHERE project_id = ${id} AND id <> ${newId}`;

      await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${id}`;

      // Re-sync any narrator assignments for this project against the freshly
      // saved script. The helper handles guardrails (skip if takes exist, skip
      // if past recording) and is also called lazily on the narrator-portal
      // load — calling it here just gets the update in front of the owner
      // immediately on the Narration tab without waiting for the next portal
      // visit.
      try {
        const { rows: assignments } = await sql`
          SELECT id FROM narrator_assignments
          WHERE project_id = ${id}
            AND status IN ('assigned', 'received', 'recording')
        `;
        for (const a of assignments) {
          await resyncAssignmentSectionsIfStale(a.id);
        }
      } catch (e) {
        logger.warn('narrator section resync on script save failed', {
          detail: e instanceof Error ? e.message : String(e),
        });
      }

      return NextResponse.json({ script: result.rows[0] });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'projects: save-script',
        knownPatterns: [
          { match: /content required|Project not found/i, status: 400 },
        ],
        fallbackMessage: 'Failed to save the script.',
      });
    }
  },
);
