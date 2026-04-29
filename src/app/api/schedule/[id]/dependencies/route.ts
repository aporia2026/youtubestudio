import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';

/** GET /api/schedule/[id]/dependencies — returns both directions:
 *  outgoing (this item depends on …) and incoming (… depends on this item). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    const out = await sql`
      SELECT d.id, d.kind, d.note, d.to_id AS other_id, si.title AS other_title, si.status AS other_status
      FROM schedule_dependencies d JOIN schedule_items si ON si.id = d.to_id
      WHERE d.from_id = ${id}
    `;
    const inc = await sql`
      SELECT d.id, d.kind, d.note, d.from_id AS other_id, si.title AS other_title, si.status AS other_status
      FROM schedule_dependencies d JOIN schedule_items si ON si.id = d.from_id
      WHERE d.to_id = ${id}
    `;
    return NextResponse.json({ outgoing: out.rows, incoming: inc.rows });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ outgoing: [], incoming: [] });
  }
}

/** POST /api/schedule/[id]/dependencies — body: { to_id, kind, note? }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    const { to_id, kind = 'relates_to', note = null } = await req.json();
    if (!to_id) return NextResponse.json({ error: 'to_id required' }, { status: 400 });
    if (to_id === id) return NextResponse.json({ error: 'Cannot depend on self' }, { status: 400 });
    const row = await sql`
      INSERT INTO schedule_dependencies (from_id, to_id, kind, note)
      VALUES (${id}, ${to_id}, ${kind}, ${note})
      ON CONFLICT (from_id, to_id, kind) DO NOTHING
      RETURNING *
    `;
    return NextResponse.json({ edge: row.rows[0] ?? null });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}

/** DELETE /api/schedule/[id]/dependencies?edge_id=<uuid> */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await params; // unused but required by signature
  try {
    await ensureScheduleSchema();
    const edgeId = req.nextUrl.searchParams.get('edge_id');
    if (!edgeId) return NextResponse.json({ error: 'edge_id required' }, { status: 400 });
    await sql`DELETE FROM schedule_dependencies WHERE id = ${edgeId}`;
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
