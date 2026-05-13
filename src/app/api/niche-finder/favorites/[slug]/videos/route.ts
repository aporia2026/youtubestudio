import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  addFavoriteVideo,
  getFavorite,
  listFavoriteVideos,
  type VideoClassification,
} from '@/lib/niche-finder/favorites';
import { slugifyNiche } from '@/lib/niche-finder/slug';

/**
 * GET  /api/niche-finder/favorites/[slug]/videos → { videos }
 *
 * POST /api/niche-finder/favorites/[slug]/videos
 *   Body: { video: {
 *     videoId, channelId, title,
 *     thumbnailUrl?, viewCount?, publishedAt?, outlierScore?,
 *     classification?, durationIso?, channelTitle?, subscriberCount?
 *   }}
 *   → { video: NicheFavoriteVideoRow }
 *
 * Idempotent — re-posting the same (slug, videoId) refreshes the
 * snapshotted fields rather than creating a duplicate (the table has
 * UNIQUE (workspace_id, niche_slug, video_id)).
 *
 * If the parent favorite doesn't exist yet, returns 404. The hybrid
 * niche-assignment UI is responsible for creating the favorite first
 * (or via the "new favorite from this video" modal path).
 */

const VALID_CLASSIFICATIONS: readonly VideoClassification[] = [
  'underperformer', 'normal', 'breakout', 'viral',
];

function isClassification(v: unknown): v is VideoClassification {
  return typeof v === 'string' && (VALID_CLASSIFICATIONS as readonly string[]).includes(v);
}

function parseRequiredString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function parseOptionalString(v: unknown, max: number): string | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  const parsed = parseRequiredString(v, max);
  return parsed ?? null;
}

function parseOptionalNumber(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export const GET = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug: raw } = await params;
    const slug = slugifyNiche(raw);
    const videos = await listFavoriteVideos(session.ws, slug);
    return NextResponse.json({ videos });
  },
);

export const POST = apiRoute.authed(
  async (session, req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug: rawSlug } = await params;
    const slug = slugifyNiche(rawSlug);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    const rawBody = body as Record<string, unknown>;
    const videoRaw = rawBody.video;
    if (!videoRaw || typeof videoRaw !== 'object') {
      return NextResponse.json({ error: 'video payload is required' }, { status: 400 });
    }
    const v = videoRaw as Record<string, unknown>;

    const videoId = parseRequiredString(v.videoId, 64);
    const channelId = parseRequiredString(v.channelId, 64);
    const title = parseRequiredString(v.title, 500);
    if (!videoId) return NextResponse.json({ error: 'videoId is required' }, { status: 400 });
    if (!channelId) return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
    if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });

    // Existence check up front so we can return a clean 404 instead of
    // letting the FK violation bubble out as a 502.
    const parent = await getFavorite(session.ws, slug);
    if (!parent) {
      return NextResponse.json(
        { error: 'Favorite niche not found. Create it first, then add videos.' },
        { status: 404 },
      );
    }

    // Classification: passed through only if valid; invalid values
    // silently become null rather than rejecting the whole request.
    // The classification is derived signal, not operator-typed.
    const classification = isClassification(v.classification) ? v.classification : null;

    try {
      const video = await addFavoriteVideo({
        workspaceId: session.ws,
        userId: session.uid,
        nicheSlug: slug,
        video: {
          videoId,
          channelId,
          title,
          thumbnailUrl: parseOptionalString(v.thumbnailUrl, 1000) ?? null,
          viewCount: parseOptionalNumber(v.viewCount) ?? null,
          publishedAt: parseOptionalString(v.publishedAt, 64) ?? null,
          outlierScore: parseOptionalNumber(v.outlierScore) ?? null,
          classification,
          durationIso: parseOptionalString(v.durationIso, 32) ?? null,
          channelTitle: parseOptionalString(v.channelTitle, 200) ?? null,
          subscriberCount: parseOptionalNumber(v.subscriberCount) ?? null,
        },
      });
      return NextResponse.json({ video });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'niche-finder: favorite video add',
        fallbackMessage: 'Could not add this video to the favorite.',
      });
    }
  },
);
