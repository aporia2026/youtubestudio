import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { deletePreset } from '@/lib/niche-finder/presets-db';

/**
 * DELETE /api/niche-finder/outliers/presets/[id]
 *
 * Idempotent. Cross-workspace ids return `{ removed: false }`
 * rather than 403 to avoid existence-leaks.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      // Treat as not-found rather than 400 — the UI can rely on a
      // single "row not present" code path.
      return NextResponse.json({ removed: false }, { status: 200 });
    }
    const removed = await deletePreset(session.ws, id);
    return NextResponse.json({ removed });
  },
);
