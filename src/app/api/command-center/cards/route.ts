/**
 * GET /api/command-center/cards
 *
 * Returns the same payload the server component computes on mount, just
 * fetched live so the page can refresh without a router.refresh()
 * round-trip (which would re-run every loader on the page, including
 * the channel list query).
 *
 * Used by the Command Center's 30-second poll. Cheap by design: one
 * SQL round-trip via loadCommandCenterCards.
 */
import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { loadCommandCenterCards } from '@/lib/command-center';

export const GET = apiRoute.authed(async (session) => {
  const cards = await loadCommandCenterCards(session.ws);
  return NextResponse.json({ cards });
});
