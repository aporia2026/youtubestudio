import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_NOTES = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/channels/[id]/editors — roster for a channel */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ editors: [], error: 'Invalid channel id' }, { status: 400 });
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
    return NextResponse.json({ editors: [], error: 'Failed' }, { status: 500 });
  }
}

/** POST /api/channels/[id]/editors — add an editor to a channel roster */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid channel id' }, { status: 400 });
  try {
    const { limited } = checkRateLimit(`editors:${getClientIP(req)}`, 30, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    await ensureScheduleSchema();
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;
    const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    if (name.length > MAX_NAME)        return NextResponse.json({ error: `Name exceeds ${MAX_NAME} chars` }, { status: 400 });
    if (email && email.length > MAX_EMAIL) return NextResponse.json({ error: `Email exceeds ${MAX_EMAIL} chars` }, { status: 400 });
    if (notes && notes.length > MAX_NOTES) return NextResponse.json({ error: `Notes exceed ${MAX_NOTES} chars` }, { status: 400 });

    // De-dupe by (channel, case-insensitive name) so clicking "Add" twice from
    // two tabs doesn't create ghost rows.
    const existing = await sql`
      SELECT id, channel_id, name, email, notes, created_at, updated_at
      FROM channel_editors
      WHERE channel_id = ${id} AND LOWER(name) = LOWER(${name})
      LIMIT 1
    `;
    if (existing.rows.length) {
      return NextResponse.json({ editor: existing.rows[0], existed: true });
    }

    const { rows } = await sql`
      INSERT INTO channel_editors (channel_id, name, email, notes)
      VALUES (${id}::uuid, ${name}, ${email}, ${notes})
      RETURNING id, channel_id, name, email, notes, created_at, updated_at
    `;
    return NextResponse.json({ editor: rows[0], existed: false });
  } catch (err) {
    console.error('POST /api/channels/[id]/editors', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
