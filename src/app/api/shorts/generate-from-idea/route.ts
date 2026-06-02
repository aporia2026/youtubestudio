import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { extractShortFromIdea } from '@/lib/shorts';

/**
 * POST /api/shorts/generate-from-idea
 *
 * Phase 15.5 — the true "create a Short from scratch" path. Takes a
 * hook-first idea (hook + title + payoff [+ thesis + shotConcept]) and
 * runs the existing Shorts extractor with the idea text as the source
 * content. Persists a `short_native` row that plugs into the voiceover
 * + render pipeline unchanged.
 *
 * Body:
 *   - niche:        required, trimmed
 *   - hook:         required, the literal first 1-3 second line
 *   - payoff:       required, the literal closing line
 *   - ideaTitle:    required, the 6-8 word display title
 *   - thesis?:      optional one-sentence "what it proves"
 *   - shotConcept?: optional visual notes
 *   - tone?:        optional tone override
 *   - projectId?:   optional workspace-scoped project to attach to
 *   - targetSeconds?: optional, 10-90, defaults to 45
 *
 * No source video, no source long-form script — this is the from-scratch
 * entry point used by both the Ideas surface ("Generate this Short" button)
 * and the /shorts Create tab.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: {
    niche?: string;
    hook?: string;
    payoff?: string;
    ideaTitle?: string;
    thesis?: string;
    shotConcept?: string;
    tone?: string;
    projectId?: string;
    targetSeconds?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.niche !== 'string' || body.niche.trim().length === 0) {
    return NextResponse.json({ error: 'niche required' }, { status: 400 });
  }
  if (typeof body.hook !== 'string' || body.hook.trim().length < 4) {
    return NextResponse.json({ error: 'hook required (at least 4 chars)' }, { status: 400 });
  }
  if (typeof body.payoff !== 'string' || body.payoff.trim().length < 4) {
    return NextResponse.json({ error: 'payoff required (at least 4 chars)' }, { status: 400 });
  }
  if (typeof body.ideaTitle !== 'string' || body.ideaTitle.trim().length === 0) {
    return NextResponse.json({ error: 'ideaTitle required' }, { status: 400 });
  }

  try {
    if (body.projectId) {
      const { rows } = await sql<{ id: string }>`
        SELECT id FROM projects
         WHERE id = ${body.projectId}::uuid
           AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (rows.length === 0) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
    }

    const result = await extractShortFromIdea({
      workspaceId: session.ws,
      projectId: body.projectId ?? null,
      niche: body.niche.trim(),
      hook: body.hook.trim(),
      payoff: body.payoff.trim(),
      ideaTitle: body.ideaTitle.trim(),
      thesis: body.thesis?.trim(),
      shotConcept: body.shotConcept?.trim(),
      tone: body.tone?.trim(),
      targetSeconds: body.targetSeconds,
    });

    logger.info('[shorts from-scratch] done', {
      workspaceId: session.ws,
      shortId: result.id,
      ideaTitle: body.ideaTitle.slice(0, 80),
    });

    return NextResponse.json({ id: result.id, short: result.short });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: from idea',
      fallbackMessage: 'Failed to generate the Short from this idea.',
    });
  }
});
