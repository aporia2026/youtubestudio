import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { logger } from '@/lib/logger';

function genToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // URL-safe base64
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function GET() {
  try {
    await ensureScheduleSchema();
    const rows = await sql`SELECT id, token, channel_id, label, expires_at, created_at FROM schedule_share_tokens ORDER BY created_at DESC`;
    return NextResponse.json({ shares: rows.rows });
  } catch (err) {
    logger.error('error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ shares: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const { channel_id, label, expires_at } = await req.json();
    const token = genToken();
    const row = await sql`
      INSERT INTO schedule_share_tokens (token, channel_id, label, expires_at)
      VALUES (${token}, ${channel_id ?? null}, ${label ?? null}, ${expires_at ?? null}::timestamptz)
      RETURNING *
    `;
    return NextResponse.json({ share: row.rows[0] });
  } catch (err) {
    logger.error('error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await sql`DELETE FROM schedule_share_tokens WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
