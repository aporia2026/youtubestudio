import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getAssignment } from '@/lib/narrator-db';
import {
  cancelPronunciationReview,
  getFullAudioTakeWithPronunciationReview,
  listPronunciationFlagsForTake,
} from '@/lib/pronunciation-review/db';
import { runPronunciationReviewForAssignment } from '@/lib/pronunciation-review/run';

export const runtime = 'nodejs';

/**
 * Pronunciation review orchestrator deadline.
 *
 * Whisper transcription on a 14-min audio file runs ~30 s; up to 60
 * Gemini judge calls at 5-way fan-out add another ~30 s; together with
 * audio fetch + ffmpeg slice spawns we comfortably fit under 200 s for
 * typical inputs. The cap is set high (800 s) for the same reason the
 * alignment route uses it — long-tail narrations and cold-start
 * latency shouldn't force a chunking refactor before we know we need
 * it. If a single take ever pushes past 800 s, the right next step is
 * concurrency tuning (raise JUDGE_CONCURRENCY) and audio chunking, not
 * bumping the cap.
 */
export const maxDuration = 800;

/**
 * Owner-side pronunciation review for a narrator assignment's
 * full-audio take. Mirrors the alignment route's surface (POST kicks +
 * awaits, GET polls status, DELETE cancels) so the UI can reuse the
 * same polling patterns it already implements for forced alignment.
 *
 * Synchronous on purpose. The orchestrator typically runs in 30–60 s
 * for a 14-min narration; awaiting here means the function lives long
 * enough to complete the work and write a terminal status. The earlier
 * fire-and-forget design couldn't guarantee completion on Vercel — a
 * reaped function instance would leave the row stuck at 'running'
 * until the 10-min stale-reclaim. Client-side, the UI calls this as
 * fire-and-forget and polls GET to render progress + the result.
 *
 * Idempotent: the orchestrator's atomic 'running' claim collapses
 * concurrent kicks (two browser tabs racing the button) into one
 * execution. The other tab gets `status='skipped' reason='lost claim
 * race'` and the GET poll picks up the same final result.
 *
 * Surfaces:
 *   - Manual "Check pronunciation" button on the Narration tab
 *     (planned for Phase 4).
 *   - Diagnostic curl from ops.
 *
 * NOTE: no auto-kick from the narrator upload route. Pronunciation
 * review is opt-in per the plan's manual-button design — see
 * `_plans/2026-06-01-pronunciation-review.md` §Q1.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const assignment = await getAssignment(id);
    if (!assignment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const take = await getFullAudioTakeWithPronunciationReview(id);
    if (!take) {
      return NextResponse.json(
        { error: 'No full-narration upload to review' },
        { status: 400 },
      );
    }

    const result = await runPronunciationReviewForAssignment(id);
    return NextResponse.json({ result });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('pronunciation-review route error', { detail });
    // Strip URL-shaped substrings before echoing — the same defense
    // the align route uses against signed R2 URLs leaking through
    // postgres errors.
    const safe = detail.replace(/https?:\/\/\S+/g, '<url>').slice(0, 240).trim();
    return NextResponse.json(
      { error: `Failed to run pronunciation review: ${safe}` },
      { status: 500 },
    );
  }
}

/**
 * GET — status read for the Narration tab's pronunciation panel.
 *   - Default: status + error + flag_count (cheap, suitable for
 *              polling while running).
 *   - `?include=flags` returns the full flag list. The UI fetches
 *              this once after status flips to 'ready'.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const take = await getFullAudioTakeWithPronunciationReview(id);
    if (!take) return NextResponse.json({ status: 'no-take' });

    const include = req.nextUrl.searchParams.get('include');
    const wantFlags = include === 'flags' && take.pronunciation_review_status === 'ready';

    // Flag count is cheap to compute even on the default path — it
    // drives the "3 flags found" chip on the button. The full flag
    // list is gated behind ?include=flags to keep the polling
    // payload small while running.
    const flags = take.pronunciation_review_status === 'ready'
      ? await listPronunciationFlagsForTake(take.take_id)
      : [];
    const flagCount = flags.length;

    return NextResponse.json({
      status: take.pronunciation_review_status,
      error: take.pronunciation_review_error,
      startedAt: take.pronunciation_review_started_at,
      costUsd: take.pronunciation_review_cost_usd,
      flagCount,
      ...(wantFlags ? { flags } : {}),
    });
  } catch (err) {
    logger.error('pronunciation-review status error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Failed to read status' }, { status: 500 });
  }
}

/**
 * Reviewer-initiated cancel. Flips a pending/running review to
 * 'cancelled' with reason "Cancelled by user" so the polling UI shows
 * a Retry chip instead of the in-progress spinner. The actual
 * in-flight Whisper / Gemini fetches keep running server-side (we
 * can't abort across function instances) but their eventual success
 * write is guarded by `status='running'` so the cancel sticks.
 *
 * Already-ready / already-failed reviews are left alone — re-cancelling
 * a settled state would be a UX bug.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const take = await getFullAudioTakeWithPronunciationReview(id);
    if (!take) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const cancelled = await cancelPronunciationReview(take.take_id);
    return NextResponse.json({ cancelled });
  } catch (err) {
    logger.error('pronunciation-review cancel error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Failed to cancel review' }, { status: 500 });
  }
}
