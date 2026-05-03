import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken } from '@/lib/review-db';
import { logger } from '@/lib/logger';

/**
 * 302 redirect from the review page to the linked narrator's personal portal.
 *
 * Doing this on the server lets us deep-link narrators to their own
 * dashboard without exposing their personal_token to the client (the
 * personal_token grants access to ALL their assignments, so we don't want
 * it leaking through a JSON response that anyone with the share link
 * could read).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const link = await getShareLinkByToken(token);
    if (!link?.collaborator_id) {
      return NextResponse.json({ error: 'No linked collaborator' }, { status: 404 });
    }
    const { rows } = await sql`
      SELECT personal_token, role, roles FROM collaborators WHERE id = ${link.collaborator_id} LIMIT 1
    `;
    const collab = rows[0];
    if (!collab) return NextResponse.json({ error: 'Collaborator not found' }, { status: 404 });
    const allRoles: string[] = Array.isArray(collab.roles) && collab.roles.length > 0
      ? collab.roles
      : (collab.role ? [collab.role] : []);
    if (!allRoles.includes('narrator')) {
      return NextResponse.json({ error: 'Not a narrator' }, { status: 403 });
    }
    if (!collab.personal_token) {
      return NextResponse.json({ error: 'No portal token' }, { status: 500 });
    }
    return NextResponse.redirect(new URL(`/narrator/${collab.personal_token}`, _req.url));
  } catch (err) {
    logger.error('narrator-portal redirect error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
