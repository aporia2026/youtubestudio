/**
 * POST /api/production-doc/styles/[id]/test-render
 *
 *   Body: { test_prompt: string }
 *   Returns: { render: { id, output_url, model_used, duration_ms, ... } }
 *
 *   Generates one image through the style's preferred cloud i2i model
 *   using the style's currently-attached refs (excluding any flagged
 *   `rejected_by_provider`). Persists the result in `style_test_renders`
 *   with the current `style.version` pinned so the gallery can show
 *   which incarnation of the style produced which thumb. Caps the
 *   gallery at MAX_TEST_RENDERS — older rows are evicted (R2 + DB)
 *   when a new one lands.
 *
 *   Returns 409 with `{ rejectedRefIds, suggestRegenerate: true }` when
 *   the provider refused one or more refs — the editor surfaces a
 *   "Regenerate without rejected refs" button using this payload.
 *
 *   Errors that aren't reference rejections (transient infra, bad
 *   prompt, etc.) come back as a generic 500 with an error message.
 *
 *   Cost: roughly one cloud i2i call per request — surfaced inline
 *   on the "Run test" button in the editor (rule 8: cost preview
 *   before paid actions).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { sql } from '@vercel/postgres';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { assertStyleOwnership } from '@/lib/production-doc-styles';
import {
  loadStyleReferences,
  markReferenceRejected,
} from '@/lib/production-doc-styles-refs';
import {
  generateImageWithRefs,
  ReferenceRejectedError,
} from '@/lib/image-gen-i2i';
import { DEFAULT_CLOUD_I2I_MODEL } from '@/lib/image-models-i2i';
import { deleteImagesObject } from '@/lib/r2';
import { logger } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEST_PROMPT_LEN = 2000;
/** Per-style cap on retained test renders. Older rows get evicted
 *  (best-effort R2 cleanup + hard DB delete) when a new one lands.
 *  6 = enough to compare a few prompts, small enough that bucket
 *  storage cost stays trivial. */
const MAX_TEST_RENDERS = 6;

interface TestRenderBody {
  test_prompt?: unknown;
}

export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id: styleId } = await ctx.params;
    if (!UUID_RE.test(styleId)) {
      return NextResponse.json(
        { error: 'Test render is only available on saved styles' },
        { status: 404 },
      );
    }

    // Two-layer rate limit — paid action ($0.05/call on cloud). The
    // gallery cap (`MAX_TEST_RENDERS = 6`) bounds STORAGE growth but
    // not spend; without these limits a malicious authenticated user
    // can fire test renders in a tight loop. Tighter than the image
    // route (10/min vs 30/min) because test renders are explicitly a
    // preview surface — power users don't need 30 of them.
    const ipLimit = checkRateLimit(`style-test:${getClientIP(req)}`, 10, 60_000);
    if (ipLimit.limited) return NextResponse.json({ error: 'Rate limited (IP)' }, { status: 429 });
    const userLimit = checkRateLimit(`style-test-uid:${session.uid}`, 10, 60_000);
    if (userLimit.limited) return NextResponse.json({ error: 'Rate limited (account) — wait a minute between test renders' }, { status: 429 });

    // Ownership guard.
    let style;
    try {
      style = await assertStyleOwnership(styleId, session.ws, session.uid);
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

    let body: TestRenderBody;
    try {
      body = (await req.json()) as TestRenderBody;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (typeof body.test_prompt !== 'string') {
      return NextResponse.json({ error: 'test_prompt is required' }, { status: 400 });
    }
    const testPrompt = body.test_prompt.trim();
    if (testPrompt.length === 0) {
      return NextResponse.json({ error: 'test_prompt cannot be empty' }, { status: 400 });
    }
    if (testPrompt.length > MAX_TEST_PROMPT_LEN) {
      return NextResponse.json(
        { error: `test_prompt must be ≤ ${MAX_TEST_PROMPT_LEN} chars` },
        { status: 400 },
      );
    }

    // Load the refs (excluding any flagged by a prior generation). If
    // the style has no usable refs we still let the call proceed: the
    // generateImageWithRefs path requires at least one ref, but we
    // can short-circuit with a clear error here rather than dispatch
    // a doomed Kie task.
    const refs = await loadStyleReferences(styleId, {
      excludeRejected: true,
      // Migration 0082 — only refs that passed the post-upload MIME
      // sniff are eligible for dispatch. Recently-uploaded refs whose
      // validation hasn't completed yet are also excluded (they show
      // `content_validated = NULL` until the validator runs). The
      // editor calls the validate endpoint immediately after PUT
      // completion, so the gap is small but non-zero.
      excludeUnvalidated: true,
      workspaceId: session.ws,
    });
    if (refs.length === 0) {
      return NextResponse.json(
        {
          error: 'No active reference images for this style — upload at least one before running a test render',
          code: 'NO_REFS',
        },
        { status: 400 },
      );
    }

    const modelValue = style.preferred_cloud_model ?? DEFAULT_CLOUD_I2I_MODEL;
    // Local-pinned styles route through the unified dispatcher
    // (image-gen-i2i.ts) — `generateImageWithRefs` branches on
    // `spec.provider` and calls `generateImageWithRefsLocal` for
    // ComfyUI-backed models. Pre-flight LOCAL_STUDIO=1 + reachability
    // checks happen inside the helper and throw plain Errors with
    // user-actionable messages that bubble up to the catch block
    // below as a 500 with the message preserved.

    // Combine the style's plain-English descriptor with the test
    // prompt. The dispatcher's i2i path doesn't auto-append the
    // legacy ai_image_suffix (refs are doing that work now), but the
    // descriptor is the user's primary intent — folding it in gives
    // a fairer test of what the style actually produces.
    const composedPrompt = style.style_prompt
      ? `${testPrompt}\n\n${style.style_prompt}`
      : testPrompt;

    let result;
    try {
      result = await generateImageWithRefs(modelValue, composedPrompt, refs, {
        r2KeyPrefix: `style-test-renders/${styleId}`,
      });
    } catch (err) {
      if (err instanceof ReferenceRejectedError) {
        // Mark the offending refs as rejected. Even when the index
        // isn't known (rejectedRefIds may cover all sent refs),
        // flipping the flag is the right default — the user clicks
        // "Clear rejection" in the editor to override.
        for (const refId of err.rejectedRefIds) {
          await markReferenceRejected(refId, styleId, err.reason, err.provider).catch(() => {
            // Marking failure shouldn't shadow the original refusal
            // surface — log and move on.
            logger.warn('[style refs rejection mark failed]', {
              style_id: styleId,
              ref_id: refId,
            });
          });
        }
        logger.info('[style test-render rejected-refs]', {
          style_id: styleId,
          ref_ids: err.rejectedRefIds,
          provider: err.provider,
        });
        return NextResponse.json(
          {
            error: err.message,
            code: 'REFERENCE_REJECTED',
            rejectedRefIds: err.rejectedRefIds,
            suggestRegenerate: true,
          },
          { status: 409 },
        );
      }
      logger.error('[style test-render error]', {
        style_id: styleId,
        detail: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Test render failed' },
        { status: 500 },
      );
    }

    // Persist the result + evict older rows past the cap.
    //
    // `style_version` is intentionally pinned to `style.version`
    // captured at handler entry by `assertStyleOwnership` — NOT to
    // a fresh sub-SELECT at INSERT time. The generation just ran
    // against the refs + prompt + model that were active at handler
    // entry; if a concurrent PATCH bumped the version mid-call
    // (cloud renders take 60–150s), the OLD version is what this
    // render actually reflects. Tagging it with the new version
    // would falsely imply the render included the post-PATCH state.
    //
    // `r2_key` captures the R2 location so the eviction SELECT
    // below can identify which blob to delete. Without it every
    // evicted row orphans its image because the presigned URL
    // alone isn't usable for DELETE.
    const { rows: insertRows } = await sql<{ id: string; created_at: string }>`
      INSERT INTO style_test_renders (
        style_id, workspace_id, style_version,
        test_prompt, output_url, r2_key, model_used,
        duration_ms, cost_usd
      ) VALUES (
        ${styleId}, ${session.ws}, ${style.version},
        ${testPrompt}, ${result.imageUrl}, ${result.r2Key ?? null}, ${result.modelUsed},
        ${result.durationMs}, ${null}
      )
      RETURNING id, created_at
    `;
    const insertedId = insertRows[0]?.id;

    // Evict oldest rows past the cap. We pull r2_key on the way out
    // so the best-effort R2 cleanup can fire after the response is
    // sent — no need to await it on the user path.
    const { rows: stale } = await sql<{ id: string; r2_key: string | null }>`
      SELECT id, r2_key FROM style_test_renders
       WHERE style_id = ${styleId}
       ORDER BY created_at DESC
       OFFSET ${MAX_TEST_RENDERS}
    `;
    if (stale.length > 0) {
      const staleIds = stale.map((r) => r.id);
      await sql.query(
        `DELETE FROM style_test_renders WHERE id = ANY($1::uuid[])`,
        [staleIds],
      );
      for (const r of stale) {
        if (r.r2_key) {
          deleteImagesObject(r.r2_key).catch((cleanupErr) => {
            logger.warn('[style test-render r2-evict failed]', {
              style_id: styleId,
              r2_key: r.r2_key,
              detail: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          });
        }
      }
    }

    logger.info('[style test-render complete]', {
      style_id: styleId,
      render_id: insertedId,
      version: style.version,
      model: result.modelUsed,
      duration_ms: result.durationMs,
      refs_sent: result.refsSent,
      evicted: stale.length,
    });

    return NextResponse.json(
      {
        render: {
          id: insertedId,
          style_id: styleId,
          style_version: style.version,
          test_prompt: testPrompt,
          output_url: result.imageUrl,
          model_used: result.modelUsed,
          duration_ms: result.durationMs,
          refs_sent: result.refsSent,
        },
      },
      { status: 201 },
    );
  },
);

/**
 * GET /api/production-doc/styles/[id]/test-render
 *
 *   Returns: { renders: [...] } — last MAX_TEST_RENDERS in descending
 *   creation order. Used by the editor to populate the test-render
 *   gallery when the user opens an existing style.
 */
export const GET = apiRoute.authed(
  async (session, _req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id: styleId } = await ctx.params;
    if (!UUID_RE.test(styleId)) {
      return NextResponse.json({ renders: [] });
    }
    try {
      await assertStyleOwnership(styleId, session.ws, session.uid);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'STYLE_NOT_FOUND') {
        return NextResponse.json({ renders: [] });
      }
      if (code === 'STYLE_FORBIDDEN') {
        return NextResponse.json({ error: 'Style is private to another user' }, { status: 403 });
      }
      throw err;
    }
    const { rows } = await sql<{
      id: string;
      style_version: number;
      test_prompt: string;
      output_url: string;
      model_used: string;
      duration_ms: number;
      created_at: string;
    }>`
      SELECT id, style_version, test_prompt, output_url, model_used,
             duration_ms, created_at
      FROM style_test_renders
      WHERE style_id = ${styleId}
      ORDER BY created_at DESC
      LIMIT ${MAX_TEST_RENDERS}
    `;
    return NextResponse.json({ renders: rows });
  },
);
