/**
 * POST /api/generate/production-doc/motion-collage/bulk-regen
 *
 * Queue a batch of motion-collage rows for server-side asynchronous
 * regeneration via the existing auto-pipeline. Returns in under a
 * second; the actual panel generation happens on subsequent
 * auto-pipeline ticks. Browser tab can close.
 *
 * Why this exists: the editor's previous bulk "Regenerate all motion
 * collages" path fired N sequential fetches against
 * /api/generate/production-doc/motion-collage from the browser. Each
 * fetch is bound by Vercel's 300 s function timeout, and the entire
 * batch is bound by the browser tab staying open. User reported
 * clicking regen, walking away, coming back hours later to find
 * nothing changed — the in-flight fetches died when they navigated
 * away.
 *
 * Phase 1 of `_plans/2026-06-09-motion-collage-async-bulk-regen.md`.
 *
 * ─── Behavior ───────────────────────────────────────────────────────
 * 1. Authenticate; verify the caller's workspace owns the project.
 * 2. Resolve the project → latest pipeline_run_video_id (one query).
 * 3. Load the latest `production_doc` artefact for that video.
 * 4. For each `rowIndex` in the request body:
 *      - Validate the row exists, is `shot_kind === 'motion_collage'`,
 *        has a valid grid + non-blank prompts.
 *      - Clear `motion_collage_panel_urls`, `motion_collage_image_url`,
 *        `image_url`, `attempts`, `last_error` so the auto-pipeline's
 *        image-gen stage partitioner picks the row up on the next tick.
 *      - Reject (don't throw) on any validation failure — the response
 *        carries a `rejected[]` array so the editor can surface
 *        per-row reasons.
 * 5. Write the updated artefact back via UPDATE on
 *    `pipeline_stage_artefacts`.
 * 6. If the video's `pipeline_run_videos.stage` is in a terminal
 *    failed state (`production_doc_images_failed`), flip it back to
 *    `generating_production_doc_images` so the cron picks it up.
 * 7. Kick `/api/auto-pipeline/tick` internally so the work starts now
 *    instead of waiting for the next scheduled cron run (worst case
 *    ~10 minutes).
 * 8. Respond with `{ ok, queued, rejected, kickedTick }`.
 *
 * ─── Security (rule 13) ─────────────────────────────────────────────
 * - Auth: `apiRoute.authed` session cookie.
 * - Workspace scoping: the artefact and video lookups filter on
 *   `prv.workspace_id = session.ws`. Cross-workspace ids 404.
 * - Rate limit: 5/min per uid + 10/min per IP. A bulk batch is
 *   expensive; this matches the "I want to queue work" cadence, not
 *   a per-row cadence.
 * - Cost cap: total estimated cost across all queued panels is
 *   checked against `MOTION_COLLAGE_BULK_REGEN_CAP_USD` (default $10).
 *   Caller must split larger batches into multiple requests.
 *
 * ─── Observability (rule 14) ────────────────────────────────────────
 * - `[motion-collage bulk-regen request]` on entry.
 * - `[motion-collage bulk-regen rejected]` per rejected row.
 * - `[motion-collage bulk-regen queued]` on success.
 * - The auto-pipeline tick emits its own `[motion-collage pipeline]`
 *   logs when it processes each row.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export const maxDuration = 30;

/** Per-call cap on total estimated cost. A 16-panel collage at the
 *  most-expensive vendor (~$0.05/panel on Kie) caps a single row at
 *  ~$0.80, so $10 fits ~12 max-grid rows or many more small ones.
 *  Env-overridable so we can raise it for power users without a
 *  redeploy. */
const DEFAULT_BULK_REGEN_CAP_USD = 10;

interface BulkRegenRequestBody {
  projectId?: string;
  rowIndices?: number[];
}

interface RejectedRow {
  rowIndex: number;
  reason: string;
}

interface ArtefactRow {
  attempt_number: number;
  metadata_jsonb: Record<string, unknown> | null;
  pipeline_run_video_id: string;
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Two-layer rate limit. Per-IP guards against unauthenticated
  // (impossible here, but defense-in-depth) and shared-machine cases;
  // per-uid is the real ceiling for a single account.
  const ipLimit = checkRateLimit(`bulk-regen-mc:${getClientIP(req)}`, 10, 60_000);
  if (ipLimit.limited) {
    return NextResponse.json({ error: 'Rate limited (IP)' }, { status: 429 });
  }
  const userLimit = checkRateLimit(`bulk-regen-mc-uid:${session.uid}`, 5, 60_000);
  if (userLimit.limited) {
    return NextResponse.json(
      { error: 'Rate limited (account) — wait a minute before queueing another batch.' },
      { status: 429 },
    );
  }

  let body: BulkRegenRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const projectId = body.projectId?.trim();
  const rowIndices = body.rowIndices;
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  if (!Array.isArray(rowIndices) || rowIndices.length === 0) {
    return NextResponse.json(
      { error: 'rowIndices must be a non-empty array of integers' },
      { status: 400 },
    );
  }
  if (rowIndices.length > 200) {
    return NextResponse.json(
      { error: 'rowIndices cannot exceed 200 per request — split larger batches.' },
      { status: 400 },
    );
  }
  for (const idx of rowIndices) {
    if (!Number.isInteger(idx) || idx < 0) {
      return NextResponse.json(
        { error: `rowIndices contains an invalid index: ${idx}` },
        { status: 400 },
      );
    }
  }
  const uniqueIndices = Array.from(new Set(rowIndices)).sort((a, b) => a - b);

  logger.info('[motion-collage bulk-regen request]', {
    user_id: session.uid,
    workspace_id: session.ws,
    project_id: projectId,
    row_count: uniqueIndices.length,
    indices_preview: uniqueIndices.slice(0, 10),
  });

  // ─── Resolve project → latest pipeline_run_video + artefact ───
  // The video record is workspace-scoped via prv.workspace_id; the
  // join filters out cross-workspace ids so anonymous probing returns
  // a clean 404 instead of leaking existence.
  const { rows: artefactRows } = await sql.query<ArtefactRow>(
    `
    SELECT psa.attempt_number,
           psa.metadata_jsonb,
           prv.id AS pipeline_run_video_id
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
    return NextResponse.json(
      { error: 'no production-doc artefact for this project (workspace-scoped lookup)' },
      { status: 404 },
    );
  }
  const { attempt_number: attemptNumber, metadata_jsonb: metadata, pipeline_run_video_id: pipelineVideoId } = artefactRows[0];

  const doc = (metadata as Record<string, unknown>).doc as
    | { rows?: Record<string, unknown>[] }
    | undefined;
  const docRows = doc?.rows;
  if (!doc || !Array.isArray(docRows)) {
    return NextResponse.json({ error: 'artefact has no rows array' }, { status: 500 });
  }

  // ─── Validate + clear matching rows ─────────────────────────────────
  // Each rejection carries a machine-readable reason so the editor can
  // surface a per-row tooltip. A row that's already missing URLs is
  // accepted (clearing the field on a no-op is harmless and gives a
  // consistent "queued" state in the editor regardless of prior state).
  const rejected: RejectedRow[] = [];
  let queued = 0;
  let estCostUsd = 0;
  for (const rowIndex of uniqueIndices) {
    if (rowIndex >= docRows.length) {
      rejected.push({ rowIndex, reason: 'index_out_of_range' });
      continue;
    }
    const row = docRows[rowIndex] as Record<string, unknown>;
    if (row.shot_kind !== 'motion_collage') {
      rejected.push({ rowIndex, reason: 'not_motion_collage' });
      continue;
    }
    const grid = row.motion_collage_grid as { cols?: number; rows?: number } | undefined;
    if (
      !grid
      || !Number.isInteger(grid.cols)
      || !Number.isInteger(grid.rows)
      || (grid.cols ?? 0) < 1
      || (grid.rows ?? 0) < 1
    ) {
      rejected.push({ rowIndex, reason: 'invalid_grid' });
      continue;
    }
    const panelPrompts = row.motion_collage_panel_prompts as string[] | undefined;
    const expectedN = (grid.cols as number) * (grid.rows as number);
    if (!Array.isArray(panelPrompts) || panelPrompts.length !== expectedN) {
      rejected.push({ rowIndex, reason: 'panel_prompts_length_mismatch' });
      continue;
    }
    if (panelPrompts.some((p) => typeof p !== 'string' || p.trim().length === 0)) {
      rejected.push({ rowIndex, reason: 'panel_prompt_empty' });
      continue;
    }
    // Cost estimate: ~$0.054 for 4-panel Atlas, scales linearly with
    // panel count. Conservative ($0.054 / 4 * N) — the actual vendor
    // mix decides exact spend but this caps the worst case.
    estCostUsd += expectedN * 0.0135;
    delete row.image_url;
    delete row.motion_collage_image_url;
    delete row.motion_collage_panel_urls;
    delete row.attempts;
    delete row.last_error;
    queued += 1;
  }

  if (queued === 0) {
    logger.warn('[motion-collage bulk-regen rejected]', {
      user_id: session.uid,
      project_id: projectId,
      rejected_count: rejected.length,
      rejected_reasons: rejected.slice(0, 10),
    });
    return NextResponse.json(
      { error: 'no rows accepted for regen', rejected },
      { status: 400 },
    );
  }

  const capUsd = Number.parseFloat(process.env.MOTION_COLLAGE_BULK_REGEN_CAP_USD ?? '')
    || DEFAULT_BULK_REGEN_CAP_USD;
  if (estCostUsd > capUsd) {
    logger.warn('[motion-collage bulk-regen rejected]', {
      user_id: session.uid,
      project_id: projectId,
      est_cost_usd: estCostUsd,
      cap_usd: capUsd,
      reason: 'cost_cap_exceeded',
    });
    return NextResponse.json(
      {
        error: `estimated cost $${estCostUsd.toFixed(2)} exceeds per-batch cap of $${capUsd.toFixed(2)} — split into smaller batches.`,
        estCostUsd,
        capUsd,
      },
      { status: 400 },
    );
  }

  // ─── Persist the artefact ───────────────────────────────────────────
  await sql.query(
    `
    UPDATE pipeline_stage_artefacts
       SET metadata_jsonb = $1::jsonb
     WHERE pipeline_run_video_id = $2::uuid
       AND stage = 'generating_production_doc'
       AND attempt_number = $3
       AND artefact_kind = 'production_doc'
    `,
    [JSON.stringify(metadata), pipelineVideoId, attemptNumber],
  );

  // ─── Re-activate the video if it's in a terminal-failed stage ───────
  // Same pattern the change-model endpoint uses (see
  // image-progress/change-model/route.ts:194-208). Without this the
  // artefact updates would sit there with no cron attention.
  await sql.query(
    `
    UPDATE pipeline_run_videos
       SET stage = 'generating_production_doc_images',
           failure_class = NULL,
           failure_message = NULL,
           claimed_at = NULL,
           claimed_by_tick = NULL,
           updated_at = NOW()
     WHERE id = $1::uuid
       AND workspace_id = $2::uuid
       AND stage = 'production_doc_images_failed'
    `,
    [pipelineVideoId, session.ws],
  );

  // ─── Kick the tick ──────────────────────────────────────────────────
  // The auto-pipeline tick endpoint is session-authenticated and
  // idempotent under the withCronLock single-flight guard. Firing it
  // here jumps the queue ahead of the next scheduled cron run (worst
  // case ~10 minutes wait). Failure is non-fatal — the cron will pick
  // up the queued rows regardless on its next sweep.
  let kickedTick = false;
  try {
    const origin = new URL(req.url).origin;
    const cookieHeader = req.headers.get('cookie') ?? '';
     
    const kickRes = await fetch(`${origin}/api/auto-pipeline/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      // 5 s — the tick endpoint claims work and returns; the actual
      // generation runs to its own 300 s budget inside the claim.
      signal: AbortSignal.timeout(5_000),
    });
    kickedTick = kickRes.ok;
  } catch (err) {
    logger.warn('[motion-collage bulk-regen kick-failed]', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('[motion-collage bulk-regen queued]', {
    user_id: session.uid,
    workspace_id: session.ws,
    project_id: projectId,
    pipeline_run_video_id: pipelineVideoId,
    queued,
    rejected_count: rejected.length,
    est_cost_usd: estCostUsd,
    kicked_tick: kickedTick,
  });

  return NextResponse.json({
    ok: true,
    queued,
    rejected,
    estCostUsd,
    kickedTick,
  });
});
