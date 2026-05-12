import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureScheduleSchema, DEFAULT_SCHEDULE_STATUSES } from '@/lib/db';
import { createEditorAssignment } from '@/lib/editor-db';
import { notifyEditorAssigned } from '@/lib/notify';
import { logger } from '@/lib/logger';

// youtube_url guard: accept only http/https URLs on youtube hosts. Rejecting
// javascript:/file:/data: scheme URLs prevents a stored-XSS sink when the
// column is later rendered or followed.
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
function isValidYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return YOUTUBE_HOSTS.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureScheduleSchema();
    const result = await sql`
      SELECT si.*,
             ed.name AS editor_name,
             ed.channel_id AS editor_channel_id,
             ec.name AS editor_collaborator_name,
             ec.color AS editor_collaborator_color,
             ec.personal_token AS editor_collaborator_token,
             nc.name AS narrator_collaborator_name,
             nc.color AS narrator_collaborator_color,
             nc.personal_token AS narrator_collaborator_token,
             COALESCE(
               (SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'account_color', c.account_color, 'niche', c.niche))
                FROM schedule_item_channels sic
                JOIN channels c ON c.id = sic.channel_id
                WHERE sic.item_id = si.id),
               '[]'::json
             ) AS channels
      FROM schedule_items si
      LEFT JOIN channel_editors ed ON ed.id = si.editor_id
      LEFT JOIN collaborators ec ON ec.id = si.editor_collaborator_id
      LEFT JOIN collaborators nc ON nc.id = si.narrator_collaborator_id
      WHERE si.id = ${id}
    `;
    if (!result.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ item: result.rows[0] });
  } catch (err) {
    logger.error('GET /api/schedule/[id]', { detail: err instanceof Error ? err.message : String(err) });
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

    // --- youtube_url format guard --------------------------------------------
    if (hasField('youtube_url') && patch.youtube_url != null && patch.youtube_url !== '') {
      if (typeof patch.youtube_url !== 'string' || !isValidYouTubeUrl(patch.youtube_url)) {
        return NextResponse.json({ error: 'youtube_url must be a https youtube.com or youtu.be URL' }, { status: 400 });
      }
    }

    // --- editor_id cross-channel guard ---------------------------------------
    // An editor may only be assigned if they belong to one of the item's
    // currently-linked channels. Prevents accidental cross-tenant leakage
    // where channel A's item points to channel B's editor.
    if (hasField('editor_id') && patch.editor_id) {
      const valid = await sql`
        SELECT 1 FROM channel_editors ed
        JOIN schedule_item_channels sic ON sic.channel_id = ed.channel_id
        WHERE ed.id = ${patch.editor_id}::uuid AND sic.item_id = ${id}
        LIMIT 1
      `;
      if (!valid.rows.length) {
        return NextResponse.json({ error: 'Editor does not belong to this item\'s channels' }, { status: 400 });
      }
    }

    // Single SELECT for the pieces the rest of the handler needs.
    const prev = await sql`
      SELECT status, checklist, custom_fields, project_id, title, editor_collaborator_id
      FROM schedule_items WHERE id = ${id}
    `;
    if (!prev.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const prevStatus: string = prev.rows[0]?.status;
    const prevProjectId: string | null = prev.rows[0]?.project_id ?? null;
    const prevEditorCollaboratorId: string | null = prev.rows[0]?.editor_collaborator_id ?? null;
    const itemTitle: string | null = prev.rows[0]?.title ?? null;

    // --- Server-side auto-advance --------------------------------------------
    // Caller passes `auto_advance_to: 'scripting'`; server decides whether
    // the item's channel pipeline allows moving from prevStatus → target, and
    // the decision becomes part of this single PATCH — no client-side pipeline
    // knowledge, no TOCTOU between a read and a write.
    let advanced: { prev_status: string; new_status: string } | null = null;
    if (hasField('auto_advance_to') && typeof patch.auto_advance_to === 'string') {
      // Fetch the pipeline for this item's primary channel (or global default).
      const channelRows = await sql`SELECT channel_id FROM schedule_item_channels WHERE item_id = ${id} LIMIT 1`;
      const channelId: string | null = channelRows.rows[0]?.channel_id ?? null;
      let pipeline: Array<{ key: string; position: number }> = [];
      if (channelId) {
        const r = await sql`SELECT key, position FROM channel_statuses WHERE channel_id = ${channelId} ORDER BY position ASC`;
        pipeline = r.rows as Array<{ key: string; position: number }>;
      }
      if (pipeline.length === 0) {
        pipeline = DEFAULT_SCHEDULE_STATUSES.map((s, i) => ({ key: s.key, position: i }));
      }
      const fromIdx = pipeline.findIndex(s => s.key === prevStatus);
      const toIdx = pipeline.findIndex(s => s.key === patch.auto_advance_to);
      if (fromIdx >= 0 && toIdx > fromIdx) {
        // Promote it into a regular status change so the existing side-effects
        // (stage_entered_at reset + checklist injection) run naturally.
        patch.status = patch.auto_advance_to;
        advanced = { prev_status: prevStatus, new_status: patch.auto_advance_to };
      }
    }

    // Status-change side-effects: stage_entered_at reset + optional checklist injection.
    let stageAdvanced = false;
    let injectedChecklist: Array<{ id: string; text: string; done: boolean; stage?: string }> | null = null;
    if (hasField('status') && patch.status) {
      stageAdvanced = prevStatus !== patch.status;
      if (stageAdvanced) {
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
      // Atomic reassignment via a single CTE.
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

    // custom_fields_merge: shallow-merge ($existing || $merge) on the server so
    // two concurrent feature completions don't clobber each other's keys. The
    // explicit `custom_fields` whole-object write still works; if both are
    // supplied, the whole-object write applies first and the merge stamps on
    // top (same SQL expression order).
    const customFieldsMergeJson = hasField('custom_fields_merge')
      ? JSON.stringify(patch.custom_fields_merge ?? {})
      : null;

    await sql`
      UPDATE schedule_items SET
        title            = CASE WHEN ${hasField('title')}         THEN ${patch.title ?? null}         ELSE title END,
        scheduled_for    = CASE WHEN ${hasField('scheduled_for')} THEN ${patch.scheduled_for ?? null}::timestamptz ELSE scheduled_for END,
        status           = CASE WHEN ${hasField('status')}        THEN ${patch.status ?? null}        ELSE status END,
        stage_entered_at = CASE WHEN ${stageAdvanced}             THEN NOW()                          ELSE stage_entered_at END,
        notes            = CASE WHEN ${hasField('notes')}         THEN ${patch.notes ?? null}         ELSE notes END,
        tags             = CASE WHEN ${hasField('tags')}          THEN ${JSON.stringify(patch.tags ?? [])}::jsonb ELSE tags END,
        custom_fields    = CASE
                             WHEN ${hasField('custom_fields')}       THEN ${JSON.stringify(patch.custom_fields ?? {})}::jsonb
                             WHEN ${customFieldsMergeJson !== null}  THEN COALESCE(custom_fields, '{}'::jsonb) || ${customFieldsMergeJson}::jsonb
                             ELSE custom_fields
                           END,
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
        youtube_url      = CASE WHEN ${hasField('youtube_url')}   THEN ${patch.youtube_url ?? null}   ELSE youtube_url END,
        series_id        = CASE WHEN ${hasField('series_id')}     THEN ${patch.series_id ?? null}::uuid ELSE series_id END,
        part_number      = CASE WHEN ${hasField('part_number')}   THEN ${patch.part_number ?? null}   ELSE part_number END,
        editor_id        = CASE WHEN ${hasField('editor_id')}     THEN ${patch.editor_id ?? null}::uuid ELSE editor_id END,
        editor_collaborator_id   = CASE WHEN ${hasField('editor_collaborator_id')}   THEN ${patch.editor_collaborator_id ?? null}::uuid   ELSE editor_collaborator_id END,
        narrator_collaborator_id = CASE WHEN ${hasField('narrator_collaborator_id')} THEN ${patch.narrator_collaborator_id ?? null}::uuid ELSE narrator_collaborator_id END,
        updated_at       = NOW()
      WHERE id = ${id}
    `;

    // Mirror editor_collaborator_id into editor_assignments so the picked
    // editor sees this item on their dashboard. Mirrors the narrator
    // auto-create flow that runs client-side in ItemDetail. Conditions:
    //  - the patch actually touched editor_collaborator_id
    //  - a project_id resolves (editor_assignments is project-scoped). The
    //    "resolved" project_id is the patched value if present, else the
    //    previous one — so a compound patch that sets both project_id +
    //    editor_collaborator_id in one call still mirrors correctly.
    // Failures are logged but never block the patch — the pointer column on
    // schedule_items is still authoritative.
    if (hasField('editor_collaborator_id')) {
      const next: string | null = patch.editor_collaborator_id ?? null;
      const nextProjectId: string | null = hasField('project_id')
        ? (patch.project_id ?? null)
        : prevProjectId;
      const titleForEmail: string = (hasField('title') && typeof patch.title === 'string'
        ? patch.title
        : itemTitle) || 'a project';
      try {
        // If the editor changed (or was cleared), drop the previous link.
        // The cleanup uses prevProjectId since that's where the old link lived,
        // even if the project pointer is being moved in the same patch.
        if (prevProjectId && prevEditorCollaboratorId && prevEditorCollaboratorId !== next) {
          await sql`
            DELETE FROM editor_assignments
            WHERE project_id = ${prevProjectId} AND editor_id = ${prevEditorCollaboratorId}
          `;
        }
        if (next && nextProjectId) {
          await createEditorAssignment({ project_id: nextProjectId, editor_id: next });
          if (next !== prevEditorCollaboratorId) {
            notifyEditorAssigned({
              editorId: next,
              projectId: nextProjectId,
              projectTitle: titleForEmail,
            }).catch(e => logger.error('notifyEditorAssigned failed', { detail: e instanceof Error ? e.message : String(e) }));
          }
        }
      } catch (e) {
        logger.error('mirror editor_collaborator_id → editor_assignments failed', { detail: e instanceof Error ? e.message : String(e) });
      }
    }

    return NextResponse.json({ success: true, advanced });
  } catch (err) {
    logger.error('PATCH /api/schedule/[id]', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
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
    logger.error('DELETE /api/schedule/[id]', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
