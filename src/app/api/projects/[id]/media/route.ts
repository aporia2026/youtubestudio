import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await sql`
      SELECT * FROM media_assets WHERE project_id = ${id} ORDER BY created_at DESC
    `;
    return NextResponse.json({ assets: result.rows });
  } catch {
    return NextResponse.json({ assets: [] });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { type, source, name, url, blob_pathname, size_bytes, duration_seconds, notes, metadata } = await req.json();

  if (!url || !type) return NextResponse.json({ error: 'url and type required' }, { status: 400 });

  try {
    const result = await sql`
      INSERT INTO media_assets (project_id, type, source, name, url, blob_pathname, size_bytes, duration_seconds, notes, metadata)
      VALUES (
        ${id}, ${type}, ${source || 'url'}, ${name || url.split('/').pop()},
        ${url}, ${blob_pathname || null}, ${size_bytes || 0}, ${duration_seconds || null},
        ${notes || ''}, ${JSON.stringify(metadata || {})}
      )
      RETURNING *
    `;
    await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${id}`;
    return NextResponse.json({ asset: result.rows[0] });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
