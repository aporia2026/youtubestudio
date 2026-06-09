/**
 * GET /api/generate/production-doc/motion-collage/progress?projectId=X
 *
 * Slim polling endpoint for the editor's motion-collage cards. The
 * existing image-progress endpoint
 * (/api/auto-pipeline/videos/[id]/image-progress) returns every row's
 * full status payload — useful for the pipeline-progress page but
 * heavier than the editor needs. This endpoint returns ONLY the
 * fields the editor's inspector + thumbnail strip render for
 * motion-collage rows, keyed by row index for easy diff-against-
 * local-state patching.
 *
 * Phase 3 of `_plans/2026-06-09-motion-collage-async-bulk-regen.md`.
 *
 * ─── Behavior ───────────────────────────────────────────────────────
 * 1. Authenticate; workspace-scope the artefact lookup.
 * 2. Resolve projectId → latest pipeline_run_video + production_doc
 *    artefact (same query the bulk-regen endpoint uses).
 * 3. Walk the doc's rows. For each row with `shot_kind === 'motion_collage'`,
 *    emit a slim record:
 *      { rowIndex, motionCollagePanelUrls, motionCollageImageUrl,
 *        imageUrl, attempts, lastErrorMessage }
 * 4. Return the array. Editor compares this against its in-memory
 *    state and PATCH_ROW's any row whose data changed.
 *
 * ─── Security (rule 13) ─────────────────────────────────────────────
 * - Auth via `apiRoute.authed`.
 * - Workspace scoping: artefact JOIN filters on prv.workspace_id =
 *   session.ws. Cross-workspace ids 404.
 * - Rate limit: 30/min/uid + 60/min/IP. Editor polls every 8 s, so
 *   the per-uid cap allows ~4 simultaneous editor sessions per
 *   workspace before tripping the limit.
 *
 * ─── Observability (rule 14) ────────────────────────────────────────
 * - `[motion-collage progress]` info log every poll with row count
 *   and elapsed ms.
 * - 404 path emits `[motion-collage progress] artefact-missing` so
 *   support can grep "is the editor polling a project that lost its
 *   artefact?"
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export const maxDuration = 10;

interface DocRow {
  shot_kind?: string;
  motion_collage_panel_urls?: string[];
  motion_collage_image_url?: string;
  image_url?: string;
  attempts?: number;
  last_error?: { class: string; message: string; at: string } | null;
}

interface ArtefactRow {
  attempt_number: number;
  metadata_jsonb: Record<string, unknown> | null;
}

interface SlimMotionCollageRow {
  rowIndex: number;
  motionCollagePanelUrls: string[];
  motionCollageImageUrl: string | null;
  imageUrl: string | null;
  attempts: number;
  lastErrorMessage: string | null;
}

export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const ipLimit = checkRateLimit(`mc-progress:${getClientIP(req)}`, 60, 60_000);
  if (ipLimit.limited) {
    return NextResponse.json({ error: 'Rate limited (IP)' }, { status: 429 });
  }
  const userLimit = checkRateLimit(`mc-progress-uid:${session.uid}`, 30, 60_000);
  if (userLimit.limited) {
    return NextResponse.json({ error: 'Rate limited (account)' }, { status: 429 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId')?.trim();
  if (!projectId) {
    return NextResponse.json({ error: 'projectId query param is required' }, { status: 400 });
  }

  const t0 = Date.now();
  const { rows: artefactRows } = await sql.query<ArtefactRow>(
    `
    SELECT psa.attempt_number, psa.metadata_jsonb
      FROM pipeline_stage_artefacts psa
      JOIN pipeline_run_videos prv ON prv.id = psa.pipeline_run_video_id
     WHERE prv.project_id = $1::uuid
       AND prv.workspace_id = $2::uuid
       AND psa.stage = 'generating_production_doc'
       AND psa.artefact_kind = 'production_doc'
     ORDER BY prv.created_at DESC, psa.attempt_number DESC
     LIMIT 1
    `,
    [projectId, session.ws],
  );
  if (artefactRows.length === 0 || !artefactRows[0].metadata_jsonb) {
    logger.warn('[motion-collage progress] artefact-missing', {
      user_id: session.uid,
      project_id: projectId,
    });
    return NextResponse.json(
      { error: 'no production-doc artefact for this project' },
      { status: 404 },
    );
  }
  const metadata = artefactRows[0].metadata_jsonb as Record<string, unknown>;
  const doc = metadata.doc as { rows?: DocRow[] } | undefined;
  const docRows = doc?.rows;
  if (!doc || !Array.isArray(docRows)) {
    return NextResponse.json({ error: 'artefact has no rows array' }, { status: 500 });
  }

  const slim: SlimMotionCollageRow[] = [];
  for (let i = 0; i < docRows.length; i++) {
    const row = docRows[i];
    if (row.shot_kind !== 'motion_collage') continue;
    slim.push({
      rowIndex: i,
      motionCollagePanelUrls: Array.isArray(row.motion_collage_panel_urls)
        ? row.motion_collage_panel_urls
        : [],
      motionCollageImageUrl: typeof row.motion_collage_image_url === 'string'
        ? row.motion_collage_image_url
        : null,
      imageUrl: typeof row.image_url === 'string' ? row.image_url : null,
      attempts: typeof row.attempts === 'number' ? row.attempts : 0,
      lastErrorMessage: row.last_error?.message ?? null,
    });
  }

  logger.info('[motion-collage progress]', {
    user_id: session.uid,
    project_id: projectId,
    motion_collage_rows: slim.length,
    elapsed_ms: Date.now() - t0,
  });

  return NextResponse.json({ rows: slim });
});
