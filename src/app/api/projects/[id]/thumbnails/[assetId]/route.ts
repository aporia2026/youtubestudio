import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { deleteImagesObject } from '@/lib/r2';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; assetId: string }> }) {
  try {
    const { id: projectId, assetId } = await params;
    const { rows } = await sql`
      SELECT id, r2_key FROM media_assets
      WHERE id = ${assetId} AND project_id = ${projectId} AND type = 'image' AND metadata->>'kind' = 'thumbnail'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (row.r2_key) {
      try { await deleteImagesObject(row.r2_key); } catch (e) { console.warn('R2 delete failed:', e); }
    }
    await sql`DELETE FROM media_assets WHERE id = ${assetId}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE thumbnail error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
