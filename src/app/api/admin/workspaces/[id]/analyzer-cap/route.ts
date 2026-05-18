import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { extractIp, writeAudit } from '@/lib/audit';

/**
 * Admin endpoint to read and set the per-workspace override for the
 * deep video analyzer's daily-cap-per-user (Phase 4 of
 * `_plans/2026-05-18-youtube-deep-analyzer.md`).
 *
 * GET  → { override: number | null, defaultCap: number }
 *        `override` is the value stored on the workspace row; null
 *        means "use default." `defaultCap` is what the route uses
 *        when the override is null — surfaced so the admin UI can
 *        show "Default is 20" without hardcoding it.
 *
 * PUT  body: { override: number | null }
 *      Validates 0 ≤ override ≤ 1000, OR override === null (clear
 *      the override → fall back to default). 1000 is a sanity ceiling
 *      so a typo can't accidentally lift the daily spend by orders
 *      of magnitude.
 *
 * Writes a `workspace.update` audit row capturing actor, target, the
 * old + new values, and request IP. Append-only — there is no
 * "history" surface yet, but the audit log is the source of truth
 * for future "who raised this cap" questions.
 */

// Keep in sync with DEFAULT_DAILY_ANALYSIS_CAP_PER_USER in
// src/app/api/analyze/youtube-video/route.ts. If you raise/lower one,
// raise/lower the other — the admin UI shows this number to admins as
// "Default cap is N/day."
const DEFAULT_DAILY_ANALYSIS_CAP_PER_USER = 20;

// Sanity ceiling for the override. A workspace running 1000
// analyses/user/day across, say, 10 users could spend up to
// 10 × 1000 × $3.90 = $39,000/day in the worst case. The ceiling
// stops a slipped-zero typo (raising 50 to 5000 instead of 500).
// Real overrides are typically 50-200.
const MAX_DAILY_CAP_OVERRIDE = 1000;

interface PutBody {
  override?: unknown;
}

export const GET = apiRoute.admin(
  async (_session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { rows } = await sql<{ override: number | null }>`
      SELECT analyses_per_user_per_day_override AS override
        FROM workspaces
       WHERE id = ${id}::uuid
       LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    return NextResponse.json({
      override: rows[0].override,
      defaultCap: DEFAULT_DAILY_ANALYSIS_CAP_PER_USER,
    });
  },
);

export const PUT = apiRoute.admin(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    let body: PutBody;
    try {
      body = (await req.json()) as PutBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // override must be either null or a non-negative integer within the
    // sanity ceiling. Reject floats, strings, booleans, negatives, and
    // anything above MAX_DAILY_CAP_OVERRIDE.
    let next: number | null;
    if (body.override === null) {
      next = null;
    } else if (typeof body.override === 'number' && Number.isInteger(body.override)) {
      if (body.override < 0) {
        return NextResponse.json({ error: 'override must be 0 or higher' }, { status: 400 });
      }
      if (body.override > MAX_DAILY_CAP_OVERRIDE) {
        return NextResponse.json(
          { error: `override must be ≤ ${MAX_DAILY_CAP_OVERRIDE}. Contact engineering if a higher cap is genuinely needed.` },
          { status: 400 },
        );
      }
      next = body.override;
    } else {
      return NextResponse.json(
        { error: 'override must be an integer or null' },
        { status: 400 },
      );
    }

    // Read the current value first so the audit log captures the
    // before/after pair, and so we 404 cleanly when the workspace
    // doesn't exist.
    const { rows: existing } = await sql<{ override: number | null }>`
      SELECT analyses_per_user_per_day_override AS override
        FROM workspaces
       WHERE id = ${id}::uuid
       LIMIT 1
    `;
    if (existing.length === 0) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    const previous = existing[0].override;

    await sql`
      UPDATE workspaces
         SET analyses_per_user_per_day_override = ${next},
             updated_at = NOW()
       WHERE id = ${id}::uuid
    `;

    await writeAudit({
      actorUserId: session.uid,
      action: 'workspace.update',
      targetWorkspaceId: id,
      ipAddress: extractIp(req),
      metadata: {
        field: 'analyses_per_user_per_day_override',
        previous,
        next,
        default_cap: DEFAULT_DAILY_ANALYSIS_CAP_PER_USER,
      },
    });

    return NextResponse.json({
      override: next,
      defaultCap: DEFAULT_DAILY_ANALYSIS_CAP_PER_USER,
    });
  },
);
