import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureDraftsSchema } from '@/lib/db';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDraftsSchema();
    const { id } = await params;
    await sql`DELETE FROM workflow_drafts WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/drafts/[id] error:', err);
    return NextResponse.json({ error: 'Failed to delete draft' }, { status: 500 });
  }
}
