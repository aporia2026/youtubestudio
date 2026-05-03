import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  getCollaboratorByPersonalToken,
  updateCollaboratorAvailability,
  updateCollaboratorNotificationPrefs,
} from '@/lib/team-db';
import { sql } from '@vercel/postgres';

/**
 * GET — collaborator's current preferences (availability, status note,
 * notification opt-outs, master notifications_enabled). Used to seed the
 * dashboard settings UI.
 *
 * PATCH — update any subset of:
 *   - availability: 'available' | 'recording' | 'editing' | 'busy' | 'out' | null
 *   - status_note: free-form string (one-liner)
 *   - notifications_enabled: boolean (master switch)
 *   - notification_prefs: { [event_key]: boolean }  // shallow-merged
 */

const ALLOWED_AVAILABILITY = new Set(['available', 'recording', 'editing', 'busy', 'out']);

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const me = await getCollaboratorByPersonalToken(token);
    if (!me) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });
    return NextResponse.json({
      availability: me.availability ?? null,
      status_note: me.status_note ?? null,
      availability_updated_at: me.availability_updated_at ?? null,
      notifications_enabled: me.notifications_enabled,
      notification_prefs: me.notification_prefs ?? {},
    });
  } catch (err) {
    logger.error('GET prefs error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const me = await getCollaboratorByPersonalToken(token);
    if (!me) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const body = await req.json().catch(() => ({}));

    if (typeof body.availability === 'string' || body.availability === null) {
      const a = body.availability;
      if (a !== null && !ALLOWED_AVAILABILITY.has(a)) {
        return NextResponse.json({ error: `Invalid availability: ${a}` }, { status: 400 });
      }
      await updateCollaboratorAvailability(me.id as string, {
        availability: a,
        status_note: typeof body.status_note === 'string' ? body.status_note : (me.status_note ?? null),
      });
    } else if (typeof body.status_note === 'string') {
      await updateCollaboratorAvailability(me.id as string, { status_note: body.status_note });
    }

    if (typeof body.notifications_enabled === 'boolean') {
      await sql`
        UPDATE collaborators SET notifications_enabled = ${body.notifications_enabled}
        WHERE id = ${me.id as string}
      `;
    }

    if (body.notification_prefs && typeof body.notification_prefs === 'object') {
      // Whitelist the keys we care about so a malicious client can't bloat the blob.
      const allowed = ['review_comment', 'comment_resolved', 'version_uploaded', 'status_changed', 'retake_requested', 'editor_assigned', 'narrator_assigned', 'deadline_reminder'];
      const patch: Record<string, boolean> = {};
      for (const k of allowed) {
        if (typeof (body.notification_prefs as Record<string, unknown>)[k] === 'boolean') {
          patch[k] = (body.notification_prefs as Record<string, boolean>)[k];
        }
      }
      if (Object.keys(patch).length > 0) {
        await updateCollaboratorNotificationPrefs(me.id as string, patch);
      }
    }

    const updated = await getCollaboratorByPersonalToken(token);
    return NextResponse.json({
      availability: updated?.availability ?? null,
      status_note: updated?.status_note ?? null,
      availability_updated_at: updated?.availability_updated_at ?? null,
      notifications_enabled: updated?.notifications_enabled,
      notification_prefs: updated?.notification_prefs ?? {},
    });
  } catch (err) {
    logger.error('PATCH prefs error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
