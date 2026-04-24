import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';

/** PATCH /api/channel-editors/[id] — rename or update contact details */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    const body = await req.json().catch(() => ({}));
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const name = has('name') ? String(body.name ?? '').trim() : undefined;
    if (name !== undefined && !name) {
      return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
    }
    const email = has('email') ? (body.email ? String(body.email).trim() : null) : undefined;
    const notes = has('notes') ? (body.notes ? String(body.notes).trim() : null) : undefined;

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
    console.error('PATCH /api/channel-editors/[id]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}

/** DELETE /api/channel-editors/[id] — FK ON DELETE SET NULL on schedule_items,
 *  so historical items stay but lose the editor link. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    await sql`DELETE FROM channel_editors WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/channel-editors/[id]', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
