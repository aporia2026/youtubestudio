import { NextRequest, NextResponse } from 'next/server';
import {
  cancelTakeAlignment,
  getAssignment,
  getFullAudioTakeWithAlignment,
} from '@/lib/narrator-db';
import { runAlignmentForAssignment } from '@/lib/alignment';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
// Forced alignment on a ~14min file finishes in well under a minute in
// practice, but Vercel's default is 60s — bump to the same envelope the
// stitch route uses so we have headroom for the occasional slow request.
export const maxDuration = 300;

/**
 * Owner-side route. Kicks off (or re-kicks) forced alignment for the
 * assignment's full-audio take. Returns immediately — the orchestrator
 * runs asynchronously and writes its result to
 * `narrator_takes.alignment_json`; callers poll the GET below for
 * status. Idempotent: the orchestrator's atomic 'running' claim
 * collapses concurrent kicks into one execution.
 *
 * Returning fast matters because forced alignment of a 14-min file takes
 * 10-30s. If the browser awaits the response, a page navigation aborts
 * the fetch and (under some Vercel runtime configurations) the function
 * — leaving the take stuck at 'running' until the 5-minute stale-claim
 * reclaim. Fire-and-forget on the server side, with the 5-minute reclaim
 * as the backstop, sidesteps that whole class of failure.
 *
 * Surfaces:
 *   - Auto-kick from the Narration tab's polling effect when status
 *     starts at 'pending' (covers takes uploaded before migration 0051
 *     went live).
 *   - "Retry sync" button when alignment_status='failed'.
 *   - Manual diagnostic (curl) for ops.
 *
 * The auto-trigger from a fresh narrator upload completion lives in
 * /api/narrate/[token]/full-audio PATCH — that path calls
 * `runAlignmentForAssignment` directly without going through this route.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const assignment = await getAssignment(id);
    if (!assignment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const take = await getFullAudioTakeWithAlignment(id);
    if (!take) {
      return NextResponse.json(
        { error: 'No full-narration upload to align' },
        { status: 400 },
      );
    }

    // Fire-and-forget: the orchestrator owns the state machine and never
    // throws (errors are caught + recorded as alignment_error). The
    // client polls GET for the result.
    runAlignmentForAssignment(id).catch((e) => {
      logger.error('align trigger background error', {
        assignmentId: id,
        detail: e instanceof Error ? e.message : String(e),
      });
    });

    return NextResponse.json({ ok: true, started: true });
  } catch (err) {
    logger.error('align route error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to run alignment' }, { status: 500 });
  }
}

/**
 * GET: status read for the Narration tab's synced player.
 *   - Default: status + error only (cheap, suitable for polling while
 *     status is 'pending' / 'running').
 *   - `?include=alignment` returns the full alignment_json too. The UI
 *     issues this once after the status flips to 'ready'.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const take = await getFullAudioTakeWithAlignment(id);
    if (!take) return NextResponse.json({ status: 'no-take' });

    const include = req.nextUrl.searchParams.get('include');
    const wantAlignment = include === 'alignment' && take.alignment_status === 'ready';

    return NextResponse.json({
      status: take.alignment_status,
      error: take.alignment_error,
      hasAlignment: take.alignment_json != null,
      ...(wantAlignment ? { alignment: take.alignment_json } : {}),
    });
  } catch (err) {
    logger.error('align status error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to read status' }, { status: 500 });
  }
}

/**
 * Reviewer-initiated cancel. Flips a pending/running alignment to
 * 'failed' with reason "Cancelled by user" so the polling UI offers a
 * Retry chip instead of the "Building word-level sync…" spinner. The
 * actual in-flight ElevenLabs fetch keeps running server-side — we
 * can't abort it across function instances — but its eventual success
 * write is guarded by status='running' so the cancel sticks.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const take = await getFullAudioTakeWithAlignment(id);
    if (!take) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const cancelled = await cancelTakeAlignment(take.take_id);
    return NextResponse.json({ cancelled });
  } catch (err) {
    logger.error('align cancel error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to cancel alignment' }, { status: 500 });
  }
}
