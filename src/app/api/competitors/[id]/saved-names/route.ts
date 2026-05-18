import { NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema, ensureChannelNamesSchema } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';

/**
 * Reverse-panel lookup for the competitor → channel-naming bridge
 * (per `_plans/2026-05-18-competitor-to-channel-naming-bridge.md`).
 *
 * Returns the saved channel names that were generated while studying
 * this competitor (source_competitor_id = id). Workspace-scoped on
 * BOTH the competitor row AND the saved-names rows — a stolen
 * competitor id from another tenant returns 404, and even on a
 * legitimate hit only this workspace's saved names are listed.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    await ensureCompetitorSchema();
    await ensureChannelNamesSchema();

    // Verify the competitor belongs to this workspace before exposing
    // any joined data. Same 404 posture as the other competitor routes.
    const owns = await sql`
      SELECT 1 FROM competitor_channels
       WHERE id = ${id}::uuid
         AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (owns.rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const res = await sql`
      SELECT id, name, handle, niche,
             seo_score, brand_score, memorability_score, combined_score,
             reasoning, risks, was_available, ai_model, saved_at
        FROM saved_channel_names
       WHERE source_competitor_id = ${id}::uuid
         AND workspace_id = ${session.ws}::uuid
       ORDER BY saved_at DESC
       LIMIT 100
    `;
    const saved = res.rows.map(r => ({
      ...r,
      seo_score: Number(r.seo_score) || 0,
      brand_score: Number(r.brand_score) || 0,
      memorability_score: Number(r.memorability_score) || 0,
      combined_score: Number(r.combined_score) || 0,
    }));
    return NextResponse.json({ saved });
  },
);
