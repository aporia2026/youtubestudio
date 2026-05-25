import { NextResponse, type NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { fetchChannelVideos, listMyVideosOAuth } from '@/lib/youtube';
import { getValidAccessToken, revokeOAuth } from '@/lib/google-oauth';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';

/** Cap on persisted channel-description size. YouTube's About field tops out
 *  around 1000 chars, but users sometimes draft longer drafts and trim by
 *  hand before publishing, so we allow headroom and only reject pathological
 *  pastes that would balloon the row. */
const MAX_DESCRIPTION_CHARS = 5000;
const MAX_BRIEF_CHARS = 4000;

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const ch = await sql`
        SELECT * FROM channels
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (!ch.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const channel = ch.rows[0]!;
      let videos: Array<{ video_id: string; title: string; thumbnail_url: string }> = [];

      // Try OAuth first
      const accessToken = await getValidAccessToken(id);
      if (accessToken) {
        try {
          const fetched = await listMyVideosOAuth(accessToken, 30);
          videos = fetched.map(v => ({ video_id: v.id, title: v.title, thumbnail_url: v.thumbnailUrl }));
        } catch { /* fall through to API key */ }
      }

      // Fall back to API key if no OAuth videos
      if (!videos.length && channel.channel_id) {
        const creds = typeof channel.api_credentials === 'string' ? JSON.parse(channel.api_credentials) : channel.api_credentials;
        const apiKey = creds?.youtube_api_key;
        try {
          const fetched = await fetchChannelVideos(channel.channel_id as string, 30, apiKey || undefined);
          videos = fetched.map(v => ({ video_id: v.id, title: v.title, thumbnail_url: v.thumbnailUrl }));
        } catch {
          // Videos fetch failed — return channel without videos
        }
      }

      // Strip sensitive fields before sending to client
      const { api_credentials: _, ...safeChannel } = channel as Record<string, unknown>;
      return NextResponse.json({ channel: safeChannel, videos });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'channels: get',
        fallbackMessage: 'Could not load channel — please try again.',
      });
    }
  },
);

/**
 * PATCH /api/channels/[id]
 *
 * Scoped patch for the channel's description fields only. Accepts:
 *   - `description`:       string | null — the YouTube About copy
 *   - `descriptionBrief`:  string | null — the brief that produced it
 *
 * Other fields (name, niche, brand_kit, …) have their own dedicated routes
 * — keeping this endpoint scoped prevents accidental mass-updates from a
 * partial client payload and means the audit trail of "which route touched
 * what" stays legible.
 *
 * `null` explicitly clears a field; `undefined` leaves it untouched.
 */
export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== 'object') {
        return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Normalize each field through the same shape: undefined = leave alone,
    // null = clear, string = set (trimmed + capped).
    function normalizeText(raw: unknown, cap: number): string | null | undefined {
      if (raw === undefined) return undefined;
      if (raw === null) return null;
      if (typeof raw !== 'string') return undefined;
      const trimmed = raw.slice(0, cap).trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    const description = normalizeText(body.description, MAX_DESCRIPTION_CHARS);
    const descriptionBrief = normalizeText(body.descriptionBrief, MAX_BRIEF_CHARS);

    if (description === undefined && descriptionBrief === undefined) {
      return NextResponse.json(
        { error: 'No supported fields in body — provide description and/or descriptionBrief' },
        { status: 400 },
      );
    }

    try {
      // Verify ownership before mutating. Same pattern as DELETE above.
      const own = await sql`
        SELECT 1 FROM channels
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (own.rows.length === 0) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }

      // Two-field patch with COALESCE so omitted fields keep their current
      // value; explicit null is preserved (NULLIF re-introduces it). The
      // parameterized SQL keeps strings out of the query text.
      const result = await sql`
        UPDATE channels
           SET description = CASE
                               WHEN ${description === undefined} THEN description
                               ELSE ${description}
                             END,
               description_brief = CASE
                                     WHEN ${descriptionBrief === undefined} THEN description_brief
                                     ELSE ${descriptionBrief}
                                   END
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
         RETURNING id, description, description_brief
      `;
      const row = result.rows[0];
      return NextResponse.json({
        id: row?.id,
        description: row?.description ?? null,
        description_brief: row?.description_brief ?? null,
      });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'channels: patch description',
        fallbackMessage: 'Could not save description — please try again.',
      });
    }
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      // Verify the channel belongs to the workspace before destructive action.
      const own = await sql`
        SELECT 1 FROM channels
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (own.rows.length === 0) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      // Revoke OAuth tokens with Google before deleting (best-effort).
      try { await revokeOAuth(id); } catch { /* best effort */ }
      await sql`
        DELETE FROM channels
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
      `;
      return NextResponse.json({ success: true });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'channels: delete',
        fallbackMessage: 'Could not delete channel — please try again.',
      });
    }
  },
);
