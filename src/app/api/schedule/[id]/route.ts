import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    const result = await sql`
      SELECT si.*,
             COALESCE(
               (SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'account_color', c.account_color))
                FROM schedule_item_channels sic
                JOIN channels c ON c.id = sic.channel_id
                WHERE sic.item_id = si.id),
               '[]'::json
             ) AS channels
      FROM schedule_items si WHERE si.id = ${id}
    `;
    if (!result.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ item: result.rows[0] });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = await req.json();
  try {
    await ensureScheduleSchema();

    // Whitelist + individual COALESCE-style updates so clients can send partial patches.
    const hasField = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);

    // Status transition side-effects: stage_entered_at reset + optional checklist injection.
    let stageAdvanced = false;
    // stage is optional because existing DB rows may predate the field.
    let injectedChecklist: Array<{ id: string; text: string; done: boolean; stage?: string }> | null = null;
    if (hasField('status') && patch.status) {
      const prev = await sql`SELECT status, checklist FROM schedule_items WHERE id = ${id}`;
      const prevStatus = prev.rows[0]?.status;
      stageAdvanced = prevStatus !== patch.status;

      if (stageAdvanced) {
        // Find the best-matching template: exact channel match first, then channel-null (global default).
        const channelRows = await sql`SELECT channel_id FROM schedule_item_channels WHERE item_id = ${id} LIMIT 1`;
        const channelId = channelRows.rows[0]?.channel_id ?? null;
        const tpl = await sql`
          SELECT items FROM schedule_checklist_templates
          WHERE (channel_id = ${channelId} OR channel_id IS NULL) AND status = ${patch.status}
          ORDER BY channel_id NULLS LAST LIMIT 1
        `;
        const tplItems = (tpl.rows[0]?.items ?? []) as Array<{ text: string }>;
        if (tplItems.length > 0) {
          const existingChecklist = (prev.rows[0]?.checklist ?? []) as Array<{ id: string; text: string; done: boolean; stage?: string }>;
          const newOnes = tplItems.map(t => ({
            id: crypto.randomUUID(),
            text: t.text,
            done: false,
            stage: patch.status,
          }));
          injectedChecklist = [...existingChecklist, ...newOnes];
        }
      }
    }

    if (hasField('channel_ids')) {
      const channelIds: string[] = patch.channel_ids ?? [];
      // Atomic reassignment via a single CTE: delete rows not in the new set,
      // then upsert the new set. One statement = no partial state on crash.
      await sql.query(
        `WITH new_ids AS (SELECT unnest($2::uuid[]) AS cid),
              pruned AS (
                DELETE FROM schedule_item_channels
                WHERE item_id = $1::uuid
                  AND channel_id NOT IN (SELECT cid FROM new_ids)
              )
         INSERT INTO schedule_item_channels (item_id, channel_id)
         SELECT $1::uuid, cid FROM new_ids
         ON CONFLICT DO NOTHING`,
        [id, channelIds],
      );
    }

    const checklistValue = injectedChecklist
      ? JSON.stringify(injectedChecklist)
      : (hasField('checklist') ? JSON.stringify(patch.checklist ?? []) : null);
    const checklistProvided = injectedChecklist != null || hasField('checklist');

    await sql`
      UPDATE schedule_items SET
        title            = CASE WHEN ${hasField('title')}         THEN ${patch.title ?? null}         ELSE title END,
        scheduled_for    = CASE WHEN ${hasField('scheduled_for')} THEN ${patch.scheduled_for ?? null}::timestamptz ELSE scheduled_for END,
        status           = CASE WHEN ${hasField('status')}        THEN ${patch.status ?? null}        ELSE status END,
        stage_entered_at = CASE WHEN ${stageAdvanced}             THEN NOW()                          ELSE stage_entered_at END,
        notes            = CASE WHEN ${hasField('notes')}         THEN ${patch.notes ?? null}         ELSE notes END,
        tags             = CASE WHEN ${hasField('tags')}          THEN ${JSON.stringify(patch.tags ?? [])}::jsonb ELSE tags END,
        custom_fields    = CASE WHEN ${hasField('custom_fields')} THEN ${JSON.stringify(patch.custom_fields ?? {})}::jsonb ELSE custom_fields END,
        position         = CASE WHEN ${hasField('position')}      THEN ${patch.position ?? 0}         ELSE position END,
        idea_id          = CASE WHEN ${hasField('idea_id')}       THEN ${patch.idea_id ?? null}::uuid  ELSE idea_id END,
        project_id       = CASE WHEN ${hasField('project_id')}    THEN ${patch.project_id ?? null}::uuid ELSE project_id END,
        script_id        = CASE WHEN ${hasField('script_id')}     THEN ${patch.script_id ?? null}::uuid ELSE script_id END,
        recurrence       = CASE WHEN ${hasField('recurrence')}    THEN ${patch.recurrence ? JSON.stringify(patch.recurrence) : null}::jsonb ELSE recurrence END,
        pillar           = CASE WHEN ${hasField('pillar')}        THEN ${patch.pillar ?? null}        ELSE pillar END,
        checklist        = CASE WHEN ${checklistProvided}         THEN ${checklistValue}::jsonb       ELSE checklist END,
        thumbnail_a_url  = CASE WHEN ${hasField('thumbnail_a_url')} THEN ${patch.thumbnail_a_url ?? null} ELSE thumbnail_a_url END,
        thumbnail_b_url  = CASE WHEN ${hasField('thumbnail_b_url')} THEN ${patch.thumbnail_b_url ?? null} ELSE thumbnail_b_url END,
        thumbnail_winner = CASE WHEN ${hasField('thumbnail_winner')} THEN ${patch.thumbnail_winner ?? null} ELSE thumbnail_winner END,
        yt_description   = CASE WHEN ${hasField('yt_description')} THEN ${patch.yt_description ?? null} ELSE yt_description END,
        yt_tags          = CASE WHEN ${hasField('yt_tags')}       THEN ${JSON.stringify(patch.yt_tags ?? [])}::jsonb ELSE yt_tags END,
        updated_at       = NOW()
      WHERE id = ${id}
    `;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/schedule/[id]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const alsoChildren = searchParams.get('children') === 'true';
  try {
    await ensureScheduleSchema();
    if (alsoChildren) {
      await sql`DELETE FROM schedule_items WHERE recurrence_parent_id = ${id}`;
    }
    await sql`DELETE FROM schedule_items WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
