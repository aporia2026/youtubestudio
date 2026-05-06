import { NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { deleteSavedView } from '@/lib/catalog-explorer';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid view id.' }, { status: 400 });
    }
    try {
      const ok = await deleteSavedView({ workspaceId: session.ws, id });
      if (!ok) {
        // 404, not 403 — keeps cross-tenant existence private (matches
        // the rest of the audit-hardened routes).
        return NextResponse.json({ error: 'Saved view not found.' }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'catalog: delete saved view',
        fallbackMessage: 'Could not delete saved view.',
      });
    }
  },
);
