import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit } from '@/lib/rate-limit';
import { optimizeAndSaveShortSeo } from '@/lib/shorts-seo';

export const maxDuration = 60;

interface SourceVideoRow {
  title: string | null;
  niche: string | null;
  script: string | null;
}

/**
 * POST /api/shorts/seo
 *
 * Body: {
 *   title: string,            // the existing Short's current title
 *   description: string,      // its current description
 *   lengthSeconds: number,    // its length (1-600s)
 *   sourceVideoId?: string,   // optional — a projects row to pull context from
 *   niche?: string,           // optional override; defaults to the source
 *                             //   video's niche, then 'General'
 *   modelId?: string,
 * }
 *
 * Optimizes the Short's SEO (graded title / description / hashtag options),
 * persists an `external_seo` shorts row, and returns { id, result } so the
 * UI can render without a follow-up GET.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited, resetIn } = checkRateLimit(`shorts-seo:${session.ws}`, 10, 60_000);
  if (limited) {
    return NextResponse.json(
      { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const title = typeof b.title === 'string' ? b.title.trim().slice(0, 300) : '';
  const description = typeof b.description === 'string' ? b.description.trim().slice(0, 5000) : '';
  const lengthSeconds =
    typeof b.lengthSeconds === 'number' && Number.isFinite(b.lengthSeconds)
      ? Math.max(1, Math.min(600, Math.round(b.lengthSeconds)))
      : 0;
  const sourceVideoId = typeof b.sourceVideoId === 'string' && b.sourceVideoId.trim() ? b.sourceVideoId.trim() : null;
  const nicheOverride = typeof b.niche === 'string' && b.niche.trim() ? b.niche.trim().slice(0, 200) : '';
  const modelId = typeof b.modelId === 'string' && b.modelId.trim() ? b.modelId.trim() : undefined;

  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });
  if (!description) return NextResponse.json({ error: 'description is required' }, { status: 400 });
  if (!lengthSeconds) return NextResponse.json({ error: 'lengthSeconds is required (1-600)' }, { status: 400 });

  // When a source video is supplied, verify it belongs to this workspace
  // before using any of its content — never trust a client-supplied id —
  // and pull its title + niche + active script as optimizer context.
  let sourceVideoTitle: string | undefined;
  let sourceVideoScript: string | undefined;
  let resolvedNiche = nicheOverride;
  let projectId: string | null = null;

  if (sourceVideoId) {
    const { rows } = await sql<SourceVideoRow>`
      SELECT
        p.title,
        p.niche,
        (
          SELECT s.content
            FROM scripts s
           WHERE s.project_id = p.id
           ORDER BY s.is_active DESC, s.version DESC
           LIMIT 1
        ) AS script
      FROM projects p
      WHERE p.id = ${sourceVideoId}::uuid
        AND p.workspace_id = ${session.ws}::uuid
      LIMIT 1
    `;
    const video = rows[0];
    if (!video) {
      return NextResponse.json({ error: 'Source video not found in this workspace' }, { status: 404 });
    }
    projectId = sourceVideoId;
    sourceVideoTitle = video.title?.trim() || undefined;
    sourceVideoScript = video.script?.trim() || undefined;
    if (!resolvedNiche) resolvedNiche = video.niche?.trim() || '';
  }

  if (!resolvedNiche) resolvedNiche = 'General';

  try {
    const { id, result } = await optimizeAndSaveShortSeo({
      workspaceId: session.ws,
      projectId,
      enteredTitle: title,
      enteredDescription: description,
      lengthSeconds,
      niche: resolvedNiche,
      sourceVideoTitle,
      sourceVideoScript,
      modelId,
    });
    return NextResponse.json({ id, result }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
});
