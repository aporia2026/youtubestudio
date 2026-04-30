import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

// Self-healing migration for newer per-project columns. Cheap (single
// IF NOT EXISTS ALTER per Lambda lifetime) so it's safe to keep here.
let columnsEnsured = false;
async function ensureColumns() {
  if (columnsEnsured) return;
  try {
    await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS youtube_description TEXT`;
    columnsEnsured = true;
  } catch {}
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureColumns();
    const result = await sql`SELECT * FROM projects WHERE id = ${id}`;
    if (!result.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ project: result.rows[0] });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { title, status, niche, topic } = await req.json();
  try {
    await sql`
      UPDATE projects SET
        title = COALESCE(${title}, title),
        status = COALESCE(${status}, status),
        niche = COALESCE(${niche}, niche),
        topic = COALESCE(${topic}, topic),
        updated_at = NOW()
      WHERE id = ${id}
    `;
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await sql`DELETE FROM projects WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
