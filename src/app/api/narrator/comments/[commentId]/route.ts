import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';

/** Owner-side delete — can remove any narrator_comment regardless of author. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ commentId: string }> }) {
  try {
    const { commentId } = await params;
    const { rows } = await sql`SELECT id FROM narrator_comments WHERE id = ${commentId} LIMIT 1`;
    if (rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await sql`DELETE FROM narrator_comments WHERE id = ${commentId}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('DELETE owner narrator comment error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 });
  }
}
