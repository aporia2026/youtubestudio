/**
 * POST /api/production-doc/styles/[id]/refs/[refId]/validate
 *
 *   Triggers a post-upload content sniff on a freshly-uploaded ref:
 *   range-GETs the first 16 bytes from R2, magic-byte checks against
 *   the declared `mime_type`, and writes `content_validated` +
 *   `content_validation_error` + `content_validated_at` on the row.
 *
 *   Until this completes successfully (`content_validated = TRUE`),
 *   the ref is excluded from every dispatch path — the test-render
 *   endpoint and the production-doc image route both pass
 *   `excludeUnvalidated: true` to `loadStyleReferences`. A
 *   not-yet-validated ref (NULL) and a failed-validation ref (FALSE)
 *   are treated the same way at dispatch: skipped.
 *
 *   This route is idempotent — calling it on an already-validated
 *   ref re-checks and overwrites the row. Useful when the user has
 *   replaced the underlying R2 bytes (not a current flow, but
 *   future-compatible).
 *
 *   Auth: standard style-ownership guard. The validator helper
 *   itself binds the UPDATE to (refId, styleId) so even a bypassed
 *   helper call can't flip another style's row.
 *
 *   Response: 200 with { validated: boolean, error?: string }.
 *   The client uses this to update the ref grid's per-thumb badge.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { assertStyleOwnership } from '@/lib/production-doc-styles';
import { validateUploadedRef } from '@/lib/production-doc-styles-refs';
import { logger } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = apiRoute.authed(
  async (session, _req: NextRequest, ctx: { params: Promise<{ id: string; refId: string }> }) => {
    const { id: styleId, refId } = await ctx.params;
    if (!UUID_RE.test(styleId) || !UUID_RE.test(refId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Ownership of the parent style. validateUploadedRef ALSO binds
    // its UPDATE to (refId, styleId), so even if this guard somehow
    // missed a privilege escalation, the helper's WHERE clause
    // prevents flipping a row that doesn't match.
    try {
      await assertStyleOwnership(styleId, session.ws, session.uid);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'STYLE_NOT_FOUND') {
        return NextResponse.json({ error: 'Style not found' }, { status: 404 });
      }
      if (code === 'STYLE_FORBIDDEN') {
        return NextResponse.json({ error: 'Style is private to another user' }, { status: 403 });
      }
      throw err;
    }

    const result = await validateUploadedRef(refId, styleId);
    logger.info('[style refs content-validate]', {
      style_id: styleId,
      ref_id: refId,
      validated: result.validated,
      error_slice: result.error?.slice(0, 200),
    });
    return NextResponse.json(result, { status: result.validated ? 200 : 422 });
  },
);
