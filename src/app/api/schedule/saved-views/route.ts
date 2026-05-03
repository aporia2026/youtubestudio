import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    await ensureScheduleSchema();
    const rows = await sql`SELECT * FROM schedule_saved_views ORDER BY created_at DESC`;
    return NextResponse.json({ views: rows.rows });
  } catch (err) {
    logger.error('error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ views: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const { name, channel_id, config } = await req.json();
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const row = await sql`
      INSERT INTO schedule_saved_views (name, channel_id, config)
      VALUES (${name}, ${channel_id ?? null}, ${JSON.stringify(config ?? {})}::jsonb)
      RETURNING *
    `;
    return NextResponse.json({ view: row.rows[0] });
  } catch (err) {
    logger.error('error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
