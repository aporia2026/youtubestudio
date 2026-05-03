import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureDraftsSchema } from '@/lib/db';
import { logger } from '@/lib/logger';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDraftsSchema();
    const { id } = await params;
    await sql`DELETE FROM workflow_drafts WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('DELETE /api/drafts/[id] error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to delete draft' }, { status: 500 });
  }
}
