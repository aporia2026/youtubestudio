import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_NOTES = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH /api/channel-editors/[id] — rename or update contact details */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  try {
    const { limited } = checkRateLimit(`editors-patch:${getClientIP(req)}`, 30, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    await ensureScheduleSchema();
    const body = await req.json().catch(() => ({}));
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const name = has('name') ? String(body.name ?? '').trim() : undefined;
    if (name !== undefined) {
      if (!name) return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
      if (name.length > MAX_NAME) return NextResponse.json({ error: `Name exceeds ${MAX_NAME} chars` }, { status: 400 });
    }
    const email = has('email') ? (body.email ? String(body.email).trim() : null) : undefined;
    if (email !== undefined && email && email.length > MAX_EMAIL) {
      return NextResponse.json({ error: `Email exceeds ${MAX_EMAIL} chars` }, { status: 400 });
    }
    const notes = has('notes') ? (body.notes ? String(body.notes).trim() : null) : undefined;
    if (notes !== undefined && notes && notes.length > MAX_NOTES) {
      return NextResponse.json({ error: `Notes exceed ${MAX_NOTES} chars` }, { status: 400 });
    }

    await sql`
      UPDATE channel_editors SET
        name       = CASE WHEN ${name !== undefined}  THEN ${name ?? null}  ELSE name END,
        email      = CASE WHEN ${email !== undefined} THEN ${email ?? null} ELSE email END,
        notes      = CASE WHEN ${notes !== undefined} THEN ${notes ?? null} ELSE notes END,
        updated_at = NOW()
      WHERE id = ${id}
    `;
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('PATCH /api/channel-editors/[id]', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

/** DELETE /api/channel-editors/[id] — FK ON DELETE SET NULL on schedule_items,
 *  so historical items stay but lose the editor link. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  try {
    await ensureScheduleSchema();
    await sql`DELETE FROM channel_editors WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('DELETE /api/channel-editors/[id]', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
