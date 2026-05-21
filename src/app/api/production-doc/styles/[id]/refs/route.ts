/**
 * POST /api/production-doc/styles/[id]/refs
 *   Body: { fileName, contentType, fileSize, position? }
 *   Returns: { uploadUrl, ref: { id, position, r2_key, ... } }
 *
 *   Mints a presigned R2 PUT URL for direct browser → R2 upload, then
 *   inserts a `style_reference_images` row pointing at the destination
 *   key. The client is expected to PUT the file bytes to `uploadUrl`
 *   immediately after; failures there are silent on the server side
 *   (the row stays but the object never lands, surfacing as a 404 on
 *   the next download). Mirrors the project-scoped image-refs route
 *   convention exactly so the upload helpers can be reused unchanged.
 *
 *   Hard cap 8 refs per style — enforced inside addStyleReference so
 *   a concurrent upload race can't squeeze past it.
 *
 *   Editing a ref-bearing style bumps the style's `version` (handled
 *   by the parent PATCH), but uploading / removing refs ALSO bumps
 *   it here — the ref set is part of the style's identity. Pinning
 *   on `style_version` in test renders depends on this.
 *
 * GET /api/production-doc/styles/[id]/refs
 *   Returns: { refs: [...] }
 *
 *   Lists every ref attached to the style with freshly-minted
 *   presigned download URLs (7-day TTL via the bucket default), so
 *   the editor can render previews without re-signing per-image on
 *   the client.
 *
 * Ownership: both routes require the caller own the style (or it's
 * workspace-wide). Ref upload to another user's private style 403s.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { sql } from '@vercel/postgres';
import { assertStyleOwnership } from '@/lib/production-doc-styles';
import {
  addStyleReference,
  loadStyleReferences,
  MAX_REFS_PER_STYLE,
  type StyleReferenceImage,
} from '@/lib/production-doc-styles-refs';
import {
  buildImageRefKey,
  getDownloadUrlForBucket,
  getImagesBucket,
  getImagesUploadUrl,
  isR2Configured,
} from '@/lib/r2';
import { logger } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_REF_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_REF_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB — matches image-refs

interface UploadRefBody {
  fileName?: unknown;
  contentType?: unknown;
  fileSize?: unknown;
  position?: unknown;
}

export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id: styleId } = await ctx.params;
    if (!UUID_RE.test(styleId)) {
      return NextResponse.json({ error: 'Refs can only be attached to saved styles' }, { status: 404 });
    }
    if (!isR2Configured()) {
      return NextResponse.json({
        error: 'Cloudflare R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_IMAGES_BUCKET_NAME.',
        code: 'R2_NOT_CONFIGURED',
      }, { status: 503 });
    }

    // Ownership guard.
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

    let body: UploadRefBody;
    try {
      body = (await req.json()) as UploadRefBody;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (typeof body.fileName !== 'string' || body.fileName.trim().length === 0) {
      return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
    }
    if (typeof body.contentType !== 'string' || !ALLOWED_REF_MIME.has(body.contentType)) {
      return NextResponse.json(
        { error: `Unsupported image type. Allowed: ${[...ALLOWED_REF_MIME].join(', ')}` },
        { status: 400 },
      );
    }
    // Note: this validates the client-DECLARED contentType at presign
    // time. R2 presigned PUTs only enforce what the client puts on
    // the wire, so a client can declare image/jpeg and then PUT
    // arbitrary bytes. Post-upload magic-byte sniff is the only
    // bulletproof guard; deferred to a follow-up because it requires
    // a HEAD + range-GET round trip per upload + a new "validated"
    // state column on style_reference_images. Tracked in
    // _plans/2026-05-22-v2-styles-onboarding.md.
    // fileSize is now REQUIRED + must be a positive finite number
    // within the cap. Previously omission silently bypassed the size
    // check, and since R2 presigned PUTs don't sign Content-Length,
    // a client could PUT arbitrarily large bytes after the presign.
    if (typeof body.fileSize !== 'number' || !Number.isFinite(body.fileSize) || body.fileSize <= 0) {
      return NextResponse.json(
        { error: 'fileSize is required and must be a positive number of bytes' },
        { status: 400 },
      );
    }
    if (body.fileSize > MAX_REF_SIZE_BYTES) {
      return NextResponse.json({ error: 'Reference image too large (max 25 MB)' }, { status: 400 });
    }
    const explicitPosition = typeof body.position === 'number' && Number.isFinite(body.position)
      ? Math.floor(body.position)
      : undefined;

    // Build R2 key under a style-scoped prefix so a future "list all
    // refs for a workspace" sweeper can walk a single subtree.
    const r2Key = `style-refs/${session.ws}/${styleId}/${buildImageRefKey('', body.fileName).replace(/^references\//, '')}`;
    const bucket = getImagesBucket();

    let uploadUrl: string;
    try {
      uploadUrl = await getImagesUploadUrl(r2Key, body.contentType);
    } catch (err) {
      logger.error('[style refs upload] R2 presign failed', {
        style_id: styleId,
        detail: err instanceof Error ? err.message : String(err),
      });
      const msg = err instanceof Error ? err.message : 'Unknown R2 error';
      return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
    }

    let ref: StyleReferenceImage;
    try {
      ref = await addStyleReference({
        styleId,
        workspaceId: session.ws,
        r2Bucket: bucket,
        r2Key,
        mimeType: body.contentType,
        // Validated above as a positive finite number — direct pass-through.
        sizeBytes: body.fileSize as number,
        position: explicitPosition,
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'REFS_LIMIT') {
        return NextResponse.json(
          { error: `This style already has the maximum of ${MAX_REFS_PER_STYLE} reference images`, code: 'REFS_LIMIT' },
          { status: 409 },
        );
      }
      throw err;
    }

    // Bump the style's version — the ref set is part of the style's
    // identity, so adding a ref changes what the style "is" and any
    // test render or generation after this point should pin to a new
    // version number.
    await sql`
      UPDATE production_doc_styles
         SET version = version + 1, updated_at = NOW()
       WHERE id = ${styleId}
    `;

    logger.info('[style refs upload]', {
      style_id: styleId,
      ref_id: ref.id,
      position: ref.position,
      mime_type: ref.mime_type,
      size_bytes: ref.size_bytes,
    });

    return NextResponse.json({ uploadUrl, ref }, { status: 201 });
  },
);

export const GET = apiRoute.authed(
  async (session, _req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id: styleId } = await ctx.params;
    if (!UUID_RE.test(styleId)) {
      return NextResponse.json({ error: 'Refs can only be listed for saved styles' }, { status: 404 });
    }

    // Visibility guard. We use assertStyleOwnership rather than a
    // looser visibility check because right now refs are only consumed
    // by the editor (owner-only) — when Phase 4 wires up generation,
    // the dispatcher loads refs server-side via loadStyleReferences
    // after its own resolveStyle visibility check. So this route stays
    // owner-scoped without leaking refs to other workspace members.
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

    const refs = await loadStyleReferences(styleId, { workspaceId: session.ws });
    // Always presign — NEVER serve refs through the unsigned public
    // URL even when R2_IMAGES_PUBLIC_URL is configured for the bucket.
    // Ref keys are deterministic (`style-refs/<ws>/<style>/...`) and
    // enumerable; without presigning, anyone who can guess the key
    // pattern can fetch private refs. Pass `publicBaseUrl: undefined`
    // explicitly to force the signed-URL branch in
    // `getDownloadUrlForBucket`. Cheap (no R2 round-trip per ref —
    // the SDK signs locally).
    const bucket = getImagesBucket();
    const refsWithUrls = await Promise.all(
      refs.map(async (r) => ({
        ...r,
        download_url: await getDownloadUrlForBucket(r.r2_bucket || bucket, r.r2_key, undefined),
      })),
    );

    return NextResponse.json({ refs: refsWithUrls });
  },
);
