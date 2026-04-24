import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';

/** GET /api/channels/[id]/editors — roster for a channel */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    const { rows } = await sql`
      SELECT id, channel_id, name, email, notes, created_at, updated_at
      FROM channel_editors
      WHERE channel_id = ${id}
      ORDER BY LOWER(name) ASC
    `;
    return NextResponse.json({ editors: rows });
  } catch (err) {
    console.error('GET /api/channels/[id]/editors', err);
    return NextResponse.json({ editors: [] });
  }
}

/** POST /api/channels/[id]/editors — add an editor to a channel roster */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;
    const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

    // De-dupe by (channel, case-insensitive name) so clicking "Add" twice from
    // two tabs doesn't create ghost rows.
    const existing = await sql`
      SELECT id FROM channel_editors
      WHERE channel_id = ${id} AND LOWER(name) = LOWER(${name})
      LIMIT 1
    `;
    if (existing.rows.length) {
      return NextResponse.json({ editor: { id: existing.rows[0].id }, existed: true });
    }

    const { rows } = await sql`
      INSERT INTO channel_editors (channel_id, name, email, notes)
      VALUES (${id}::uuid, ${name}, ${email}, ${notes})
      RETURNING id, channel_id, name, email, notes, created_at, updated_at
    `;
    return NextResponse.json({ editor: rows[0] });
  } catch (err) {
    console.error('POST /api/channels/[id]/editors', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
