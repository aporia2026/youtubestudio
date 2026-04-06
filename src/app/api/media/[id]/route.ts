import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { del } from '@vercel/blob';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await sql`SELECT * FROM media_assets WHERE id = ${id}`;
    const asset = result.rows[0];
    if (!asset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Delete from Vercel Blob if it was uploaded
    if (asset.blob_pathname) {
      try { await del(asset.blob_pathname); } catch { /* ok */ }
    }

    await sql`DELETE FROM media_assets WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
