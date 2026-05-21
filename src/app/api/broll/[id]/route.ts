import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deleteBrollClip, getAndAdvanceBrollClip, getBrollClip } from '@/lib/broll';
import { getAndAdvanceLocalBrollClip } from '@/lib/local-broll';

export const maxDuration = 30;

/**
 * GET /api/broll/[id]
 *
 * Read the clip and, if it's still 'generating', do ONE provider status
 * check inline (cheap, ~1s) and persist the result. Clients poll this
 * endpoint every 5-10s until status === 'ready' | 'failed'.
 *
 * Dispatch on provider:
 *   - 'kie'           → Kie cloud poll (needs KIE_API_KEY)
 *   - 'comfyui-local' → ComfyUI history poll (needs LOCAL_STUDIO=1)
 *
 * If the integration is offline (no API key for Kie, no LOCAL_STUDIO
 * for local) the row is returned as-is — the UI keeps working in
 * read-only mode for historical clips.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // Read once first so we know which provider to advance against.
    const existing = await getBrollClip(id, session.ws);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    let clip = existing;
    if (existing.status === 'generating') {
      if (existing.provider === 'comfyui-local') {
        if (process.env.LOCAL_STUDIO === '1') {
          const advanced = await getAndAdvanceLocalBrollClip(id, session.ws);
          if (advanced) clip = advanced;
        }
      } else {
        const apiKey = process.env.KIE_API_KEY;
        if (apiKey) {
          const advanced = await getAndAdvanceBrollClip(id, session.ws, apiKey);
          if (advanced) clip = advanced;
        }
      }
    }
    return NextResponse.json({ clip });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ok = await deleteBrollClip(id, session.ws);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
