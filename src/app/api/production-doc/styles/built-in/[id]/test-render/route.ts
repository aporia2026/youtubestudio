/**
 * POST /api/production-doc/styles/built-in/[id]/test-render
 *
 *   Body: { test_prompt: string }
 *   Returns: { render: { output_url, model_used, duration_ms, refs_sent } }
 *
 *   Ephemeral test renders for BUILT-IN styles. The saved-style
 *   endpoint at `/api/production-doc/styles/[id]/test-render` is
 *   gated on a UUID id, a DB ownership row, and persists each result
 *   into `style_test_renders` (which has a FK to `production_doc_styles.id`).
 *   None of that applies to built-ins:
 *
 *   - ids are slugs (`doodle_explainer_2`), not UUIDs
 *   - there's no DB row to own
 *   - built-ins can't be edited per-workspace, so a persisted gallery
 *     adds storage cost for zero iteration value (no descriptor or ref
 *     change can land that would be worth comparing against past runs)
 *
 *   So this route runs the i2i call, returns the image URL inline, and
 *   forgets the result. The dialog keeps recent renders in component
 *   state for the duration of the modal session.
 *
 *   Cost: roughly one cloud i2i call per request — same per-render
 *   spend as the saved-style flow. Surfaced inline on the "Run test"
 *   button.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { getBuiltInStyle } from '@/lib/production-doc-styles';
import { loadStyleReferences } from '@/lib/production-doc-styles-refs';
import {
  generateImageWithRefs,
  ReferenceRejectedError,
} from '@/lib/image-gen-i2i';
import { DEFAULT_CLOUD_I2I_MODEL } from '@/lib/image-models-i2i';
import { logger } from '@/lib/logger';

const MAX_TEST_PROMPT_LEN = 2000;

interface TestRenderBody {
  test_prompt?: unknown;
}

export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id: builtInId } = await ctx.params;

    // Resolve the built-in. Unknown ids → 404 (would also fail later
    // at `loadStyleReferences` returning [], but a clear early 404 is
    // friendlier than the "no usable refs" message that path produces).
    const builtIn = getBuiltInStyle(builtInId);
    if (!builtIn) {
      return NextResponse.json(
        { error: 'Unknown built-in style id' },
        { status: 404 },
      );
    }
    if (!builtIn.built_in_refs?.length) {
      // Refless built-ins (legacy text-only) can't run i2i test
      // renders — the dispatcher requires at least one ref.
      return NextResponse.json(
        {
          error: 'This built-in style has no bundled reference images, so it can\'t be test-rendered through the i2i path.',
          code: 'NO_REFS',
        },
        { status: 400 },
      );
    }

    // Same two-layer rate limit as the saved-style endpoint — paid
    // action ($0.05/call on cloud). 10/min per IP and per user.
    const ipLimit = checkRateLimit(`style-test-builtin:${getClientIP(req)}`, 10, 60_000);
    if (ipLimit.limited) return NextResponse.json({ error: 'Rate limited (IP)' }, { status: 429 });
    const userLimit = checkRateLimit(`style-test-builtin-uid:${session.uid}`, 10, 60_000);
    if (userLimit.limited) return NextResponse.json({ error: 'Rate limited (account) — wait a minute between test renders' }, { status: 429 });

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

    // `loadStyleReferences` short-circuits on built-in slugs and
    // synthesizes the ref rows from `built_in_refs`. The exclude
    // filters are irrelevant to built-ins (no per-workspace rejection
    // state, no upload validation gap) but we pass FALSE explicitly
    // for clarity.
    const refs = await loadStyleReferences(builtInId, {
      excludeRejected: false,
      excludeUnvalidated: false,
    });
    if (refs.length === 0) {
      return NextResponse.json(
        { error: 'No reference images resolved for this built-in style', code: 'NO_REFS' },
        { status: 500 },
      );
    }

    const modelValue = builtIn.preferred_cloud_model ?? DEFAULT_CLOUD_I2I_MODEL;

    // For built-ins the descriptor lives in `ai_image_suffix` (legacy
    // field; built-ins never had `style_prompt`). Combining it with
    // the test prompt mirrors the saved-style path's intent: the user
    // gets a fair preview of what the style produces, not just what
    // the bare refs do.
    const composedPrompt = builtIn.ai_image_suffix
      ? `${testPrompt}\n\n${builtIn.ai_image_suffix}`
      : testPrompt;

    let result;
    try {
      result = await generateImageWithRefs(modelValue, composedPrompt, refs, {
        // Ephemeral: prefix isolates test outputs from real generation
        // and from saved-style test renders, so a future R2 sweep can
        // identify these blobs by prefix.
        r2KeyPrefix: `style-test-renders/built-in/${builtInId}`,
      });
    } catch (err) {
      if (err instanceof ReferenceRejectedError) {
        // Built-in refs are bundled in the deploy and shared across
        // every workspace — we can't flip a per-workspace rejection
        // flag on them. Surface the refusal so the user knows it
        // happened, but don't pretend the next call will be cleaner.
        logger.info('[builtin test-render rejected-refs]', {
          builtin_id: builtInId,
          provider: err.provider,
          reason: err.reason,
        });
        return NextResponse.json(
          {
            error: `${err.provider} refused the built-in refs for this prompt — try a different test prompt or a different style.`,
            code: 'REFERENCE_REJECTED',
          },
          { status: 409 },
        );
      }
      logger.error('[builtin test-render error]', {
        builtin_id: builtInId,
        detail: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Test render failed' },
        { status: 500 },
      );
    }

    logger.info('[builtin test-render complete]', {
      builtin_id: builtInId,
      model: result.modelUsed,
      duration_ms: result.durationMs,
      refs_sent: result.refsSent,
    });

    return NextResponse.json(
      {
        render: {
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
