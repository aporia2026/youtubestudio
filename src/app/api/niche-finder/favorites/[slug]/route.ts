import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  getFavorite,
  listFavoriteVideos,
  softDeleteFavorite,
  updateFavorite,
  isValidStatus,
  isValidVerdict,
  isValidOutcome,
  NOTES_MAX_LENGTH,
  REASON_MAX_LENGTH,
} from '@/lib/niche-finder/favorites';
import { slugifyNiche } from '@/lib/niche-finder/slug';

/**
 * GET    /api/niche-finder/favorites/[slug]   → { favorite, videos }
 * PATCH  /api/niche-finder/favorites/[slug]   → { favorite }
 *   Body: any subset of {
 *     notes?: string|null,
 *     status?: FavoriteStatus,
 *     verdict?: FavoriteVerdict|null,
 *     verdictReason?: string|null,
 *     outcome?: FavoriteOutcome|null,
 *     outcomeVideoId?: string|null,
 *     outcomeReason?: string|null,
 *   }
 * DELETE /api/niche-finder/favorites/[slug]   → { removed: boolean }
 *   Soft-delete only — the row sits in the 30-day restore bin until
 *   the cleanup cron purges it (PR3). Restore via POST [slug]/restore.
 *
 * Idempotent across the board.
 */
export const GET = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug: raw } = await params;
    const slug = slugifyNiche(raw);
    const favorite = await getFavorite(session.ws, slug);
    if (!favorite) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const videos = await listFavoriteVideos(session.ws, slug);
    return NextResponse.json({ favorite, videos });
  },
);

export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug: raw } = await params;
    const slug = slugifyNiche(raw);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    const raw_ = body as Record<string, unknown>;

    // Per-field validation — surface a friendly 400 instead of letting
    // the DB CHECK constraint or the favorites lib's throw bubble up
    // as a 500.
    const patch: Parameters<typeof updateFavorite>[0] = {
      workspaceId: session.ws,
      nicheSlug: slug,
    };

    if (raw_.notes !== undefined) {
      if (raw_.notes !== null && typeof raw_.notes !== 'string') {
        return NextResponse.json({ error: 'notes must be a string or null' }, { status: 400 });
      }
      if (typeof raw_.notes === 'string' && raw_.notes.length > NOTES_MAX_LENGTH) {
        return NextResponse.json(
          { error: `notes exceeds ${NOTES_MAX_LENGTH} chars` },
          { status: 400 },
        );
      }
      patch.notes = raw_.notes as string | null;
    }
    if (raw_.status !== undefined) {
      if (!isValidStatus(raw_.status)) {
        return NextResponse.json(
          { error: "status must be one of 'considering','committed','parked','passed'" },
          { status: 400 },
        );
      }
      patch.status = raw_.status;
    }
    if (raw_.verdict !== undefined) {
      if (raw_.verdict !== null && !isValidVerdict(raw_.verdict)) {
        return NextResponse.json(
          { error: "verdict must be one of 'accept','override','reject' or null" },
          { status: 400 },
        );
      }
      patch.verdict = raw_.verdict;
    }
    if (raw_.verdictReason !== undefined) {
      if (raw_.verdictReason !== null && typeof raw_.verdictReason !== 'string') {
        return NextResponse.json({ error: 'verdictReason must be string or null' }, { status: 400 });
      }
      if (typeof raw_.verdictReason === 'string' && raw_.verdictReason.length > REASON_MAX_LENGTH) {
        return NextResponse.json(
          { error: `verdictReason exceeds ${REASON_MAX_LENGTH} chars` },
          { status: 400 },
        );
      }
      patch.verdictReason = raw_.verdictReason as string | null;
    }
    if (raw_.outcome !== undefined) {
      if (raw_.outcome !== null && !isValidOutcome(raw_.outcome)) {
        return NextResponse.json(
          { error: "outcome must be one of 'producing','produced','parked','killed' or null" },
          { status: 400 },
        );
      }
      patch.outcome = raw_.outcome;
    }
    if (raw_.outcomeVideoId !== undefined) {
      if (raw_.outcomeVideoId !== null && typeof raw_.outcomeVideoId !== 'string') {
        return NextResponse.json({ error: 'outcomeVideoId must be string or null' }, { status: 400 });
      }
      // Cap to keep the column sane — YouTube ids are 11 chars; allow
      // 64 to accommodate any future "channel:video" composite without
      // a migration.
      if (typeof raw_.outcomeVideoId === 'string' && raw_.outcomeVideoId.length > 64) {
        return NextResponse.json({ error: 'outcomeVideoId too long' }, { status: 400 });
      }
      patch.outcomeVideoId = raw_.outcomeVideoId as string | null;
    }
    if (raw_.outcomeReason !== undefined) {
      if (raw_.outcomeReason !== null && typeof raw_.outcomeReason !== 'string') {
        return NextResponse.json({ error: 'outcomeReason must be string or null' }, { status: 400 });
      }
      if (typeof raw_.outcomeReason === 'string' && raw_.outcomeReason.length > REASON_MAX_LENGTH) {
        return NextResponse.json(
          { error: `outcomeReason exceeds ${REASON_MAX_LENGTH} chars` },
          { status: 400 },
        );
      }
      patch.outcomeReason = raw_.outcomeReason as string | null;
    }

    try {
      const favorite = await updateFavorite(patch);
      if (!favorite) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ favorite });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'niche-finder: favorite update',
        fallbackMessage: 'Could not update this favorite.',
      });
    }
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug: raw } = await params;
    const slug = slugifyNiche(raw);
    const removed = await softDeleteFavorite(session.ws, slug);
    return NextResponse.json({ removed });
  },
);
