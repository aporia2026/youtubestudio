import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';

/** GET /api/schedule/checklist-templates?channel_id= — returns every template
 *  for that channel (or global-default templates when no channel is given). */
export async function GET(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const { searchParams } = new URL(req.url);
    const channelId = searchParams.get('channel_id');
    const rows = channelId
      ? await sql`SELECT * FROM schedule_checklist_templates WHERE channel_id = ${channelId} OR channel_id IS NULL`
      : await sql`SELECT * FROM schedule_checklist_templates WHERE channel_id IS NULL`;
    return NextResponse.json({ templates: rows.rows });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ templates: [] });
  }
}

/** PUT /api/schedule/checklist-templates — upsert a single (channel, status) template.
 *  body: { channel_id: string | null, status: string, items: [{ text }] } */
export async function PUT(req: NextRequest) {
  try {
    await ensureScheduleSchema();
    const { channel_id, status, items } = await req.json() as {
      channel_id: string | null;
      status: string;
      items: Array<{ text: string }>;
    };
    if (!status) return NextResponse.json({ error: 'status required' }, { status: 400 });
    const itemsJson = JSON.stringify(items ?? []);

    // Separate paths because UNIQUE(channel_id, status) treats NULL channel as "not equal" to any other NULL,
    // so we can't rely on ON CONFLICT for the global-default case — we emulate an upsert.
    if (channel_id == null) {
      const existing = await sql`SELECT id FROM schedule_checklist_templates WHERE channel_id IS NULL AND status = ${status}`;
      if (existing.rows.length > 0) {
        await sql`UPDATE schedule_checklist_templates SET items = ${itemsJson}::jsonb, updated_at = NOW() WHERE id = ${existing.rows[0].id}`;
      } else {
        await sql`INSERT INTO schedule_checklist_templates (channel_id, status, items) VALUES (NULL, ${status}, ${itemsJson}::jsonb)`;
      }
    } else {
      await sql`
        INSERT INTO schedule_checklist_templates (channel_id, status, items)
        VALUES (${channel_id}, ${status}, ${itemsJson}::jsonb)
        ON CONFLICT (channel_id, status)
        DO UPDATE SET items = EXCLUDED.items, updated_at = NOW()
      `;
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
