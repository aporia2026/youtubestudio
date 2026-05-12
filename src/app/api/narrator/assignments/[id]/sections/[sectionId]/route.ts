import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { updateSection, createNarratorComment } from '@/lib/narrator-db';
import { notifyRetakeRequested } from '@/lib/notify';
import { dispatchNarrationHookFireAndForget } from '@/lib/auto-pipeline/narrator-hook';
import { stitchAssignmentVoiceover } from '@/lib/narrator-stitch';
import { logger } from '@/lib/logger';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; sectionId: string }> }) {
  try {
    const { id: assignmentId, sectionId } = await params;
    const body = await req.json();
    const { status, director_notes, pronunciation_notes, approved_take_id, retake_notes } = body;

    // If requesting retake, also create a comment
    if (status === 'retake' && retake_notes) {
      await createNarratorComment({
        assignment_id: assignmentId,
        section_id: sectionId,
        text: `Retake requested: ${retake_notes}`,
        author_name: 'Owner',
        author_role: 'owner',
      });
    }

    const section = await updateSection(sectionId, {
      status,
      director_notes,
      pronunciation_notes,
      approved_take_id,
    });

    if (!section) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Auto-pipeline bridge: when this approval completes the
    // narration set for a linked pipeline_run_video, advance it
    // to narration_complete. Fire-and-forget — the narrator
    // response shouldn't wait on the pipeline. The hook itself
    // short-circuits when there's no linked pipeline or sections
    // remain pending.
    if (status === 'approved') {
      dispatchNarrationHookFireAndForget(assignmentId);
      dispatchAutoStitchIfReady(assignmentId);
    }

    // Fire-and-forget: notify narrator on retake
    if (status === 'retake') {
      sql`
        SELECT a.narrator_id, a.share_token, s.label
        FROM narrator_assignments a
        JOIN narrator_sections s ON s.id = ${sectionId}
        WHERE a.id = ${assignmentId}
        LIMIT 1
      `.then(r => {
        const row = r.rows[0];
        if (!row?.narrator_id) return;
        notifyRetakeRequested({
          narratorId: row.narrator_id,
          shareToken: row.share_token,
          sectionLabel: row.label || 'a section',
          notes: retake_notes,
        }).catch(e => logger.error('notifyRetakeRequested failed', { detail: e instanceof Error ? e.message : String(e) }));
      }).catch(() => {});
    }

    return NextResponse.json(section);
  } catch (err) {
    logger.error('PUT section error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update section' }, { status: 500 });
  }
}

/**
 * Auto-stitch the assignment's voiceover when this section approval was
 * the last one outstanding. Fire-and-forget — the narrator response
 * returns immediately and the stitch (download + concat + Vercel Blob
 * upload + media_asset insert) runs on the same instance.
 *
 * Why this exists: the team-hub UI only calls this PUT route to approve
 * sections; it never hits the manual stitch endpoint. Without this hook,
 * an assignment can be fully approved per-section yet leave the project
 * with no voiceover media_asset — so the Voiceover panel stays empty
 * and the workspace-wide library can't reuse it.
 *
 * Single round-trip predicate: every real section (section_number != 0)
 * is approved AND no voiceover media_asset already exists for this
 * assignment (covers both stitched and full-narration uploads).
 */
function dispatchAutoStitchIfReady(assignmentId: string): void {
  void (async () => {
    const { rows } = await sql<{ should_stitch: boolean }>`
      SELECT (
        (SELECT COUNT(*) FROM narrator_sections s
          WHERE s.assignment_id = ${assignmentId}::uuid
            AND s.section_number != 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM narrator_sections s
           WHERE s.assignment_id = ${assignmentId}::uuid
             AND s.section_number != 0
             AND s.status != 'approved'
        )
        AND NOT EXISTS (
          SELECT 1 FROM media_assets m
           WHERE m.type = 'voiceover'
             AND m.metadata->>'assignment_id' = ${assignmentId}
             AND (m.metadata->>'stitched' = 'true'
                  OR m.metadata->>'full_narration' = 'true')
        )
      ) AS should_stitch
    `;
    if (!rows[0]?.should_stitch) return;

    const result = await stitchAssignmentVoiceover(assignmentId);
    if (result.ok) {
      logger.info('auto-stitch published voiceover', {
        assignment_id: assignmentId,
        sections: result.sections,
        size: result.size,
      });
    } else {
      logger.warn('auto-stitch skipped', {
        assignment_id: assignmentId,
        reason: result.reason,
      });
    }
  })().catch((err) => {
    logger.error('auto-stitch dispatch threw', {
      assignment_id: assignmentId,
      detail: err instanceof Error ? err.message : String(err),
    });
  });
}
