import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { getShort, deleteShort } from '@/lib/shorts';
import { countSpokenWords, estimateShortDurationSeconds } from '@/lib/shorts';

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const short = await getShort(id, session.ws);
    if (!short) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ short });
  },
);

/**
 * PATCH /api/shorts/[id]
 *
 * Lets the new Shorts editor (/shorts/[id]) edit the four caption-bearing
 * fields without going through the extractor again: title, short_script,
 * hook, payoff. word_count + estimated_duration_seconds are recomputed
 * server-side when short_script changes so the renderer + the inbox stay
 * accurate. All fields optional — partial patches supported.
 *
 * Workspace-scoped: cross-tenant ids return 404 (no info leak).
 */
export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: {
      title?: unknown;
      short_script?: unknown;
      hook?: unknown;
      payoff?: unknown;
    } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Tenant gate before any write.
    const existing = await getShort(id, session.ws);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Coerce + clamp each field. null = "leave existing value".
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null;
    const shortScript =
      typeof body.short_script === 'string' ? body.short_script.trim().slice(0, 8000) : null;
    const hook = typeof body.hook === 'string' ? body.hook.trim().slice(0, 600) : null;
    const payoff = typeof body.payoff === 'string' ? body.payoff.trim().slice(0, 600) : null;

    try {
      // Recompute derived fields when the script changes.
      const wc = shortScript ? countSpokenWords(shortScript) : null;
      const est = wc != null ? estimateShortDurationSeconds(wc) : null;
      await sql`
        UPDATE shorts
           SET title = COALESCE(${title}, title),
               short_script = COALESCE(${shortScript}, short_script),
               hook = COALESCE(${hook}, hook),
               payoff = COALESCE(${payoff}, payoff),
               word_count = COALESCE(${wc}, word_count),
               estimated_duration_seconds = COALESCE(${est}, estimated_duration_seconds),
               updated_at = NOW()
         WHERE id = ${id}::uuid AND workspace_id = ${session.ws}::uuid
      `;
      const updated = await getShort(id, session.ws);
      return NextResponse.json({ short: updated });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: edit short',
        fallbackMessage: 'Failed to save your edits.',
      });
    }
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteShort(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
