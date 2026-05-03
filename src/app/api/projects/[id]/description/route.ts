import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';

// Self-healing migration: makes sure the youtube_description column exists.
// Idempotent — IF NOT EXISTS guards the ALTER, and the in-process flag
// avoids retrying on every request in the same Lambda lifetime.
let columnEnsured = false;
async function ensureColumn() {
  if (columnEnsured) return;
  try {
    await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS youtube_description TEXT`;
    columnEnsured = true;
  } catch (e) {
    console.warn('ensureColumn(youtube_description) failed:', e);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await ensureColumn();
    const body = await req.json();
    const description: string | null = typeof body.description === 'string' ? body.description : null;
    await sql`
      UPDATE projects
      SET youtube_description = ${description},
          updated_at = NOW()
      WHERE id = ${id}
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('PUT description error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await ensureColumn();
    await sql`UPDATE projects SET youtube_description = NULL, updated_at = NOW() WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('DELETE description error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
