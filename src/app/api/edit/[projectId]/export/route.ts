import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { EDITOR_V1_ENABLED } from '@/lib/feature-flags';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import { buildOtioTimeline } from '@/lib/editor/otio';
import type { ProductionDoc } from '@/remotion/utils';

/**
 * OTIO export endpoint — Phase 4 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * `GET /api/edit/:projectId/export?format=otio` reads the saved
 * payload from `user_history` (workspace + owner scoped) and
 * returns the timeline serialised to OpenTimelineIO JSON. The
 * response carries a Content-Disposition: attachment header so the
 * browser downloads it as `<title>.otio`.
 *
 * v1 supports only `format=otio` (the plan's choice — OTIO is the
 * modern Pixar-led standard with importers in Resolve, Premiere,
 * Final Cut via otioconvert). Future formats (EDL, FCPXML, JSON)
 * can branch on the query parameter without changing the endpoint.
 *
 * No PII / no workspace ids in the output — see `lib/editor/otio.ts`
 * for the redaction rules. The exported file can be shared with
 * collaborators outside the workspace safely.
 */

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export const GET = apiRoute.authed(async (
  session,
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) => {
  if (!EDITOR_V1_ENABLED) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { projectId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  const format = new URL(req.url).searchParams.get('format') ?? 'otio';
  if (format !== 'otio') {
    return NextResponse.json(
      { error: `Unsupported format: ${format}. Supported: otio` },
      { status: 400 },
    );
  }

  const { rows } = await sql<{ payload: unknown; version: number }>`
    SELECT payload, version
      FROM user_history
     WHERE id = ${projectId}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     LIMIT 1
  `;

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const payload = rows[0].payload;
  if (!isPlainObject(payload)) {
    return NextResponse.json({ error: 'Payload not parseable' }, { status: 500 });
  }
  const doc = isPlainObject(payload.doc) ? (payload.doc as unknown as ProductionDoc) : null;
  if (!doc || !Array.isArray(doc.rows)) {
    return NextResponse.json({ error: 'Doc payload missing rows' }, { status: 500 });
  }
  const rowImages = isPlainObject(payload.rowImages)
    ? (payload.rowImages as Record<number, string>)
    : {};
  const voiceoverUrl =
    typeof payload.voiceoverUrl === 'string' && payload.voiceoverUrl
      ? payload.voiceoverUrl
      : undefined;
  const title =
    typeof payload.title === 'string' && payload.title
      ? payload.title
      : doc.title || 'Untitled project';

  const timeline = buildOtioTimeline({
    title,
    doc,
    rowImages,
    voiceoverUrl,
  });

  logger.info('[editor export] otio', {
    project_id: projectId,
    shot_count: doc.rows.length,
    bytes_estimated: JSON.stringify(timeline).length,
  });

  const filename = `${title.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80) || 'project'}.otio`;
  return new NextResponse(JSON.stringify(timeline, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});
