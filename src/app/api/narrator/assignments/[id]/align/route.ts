import { NextRequest, NextResponse } from 'next/server';
import {
  cancelTakeAlignment,
  getAssignment,
  getFullAudioTakeWithAlignment,
} from '@/lib/narrator-db';
import { runAlignmentForAssignment } from '@/lib/alignment';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
// ElevenLabs' published processing-time formula for Scribe-family
// endpoints is roughly `duration × 0.3 + overhead`. For a 14-min file
// that's ~3-4 min of pure processing; add R2 download + multipart
// upload + the response trip and we routinely exceed 300s. Use the Pro
// plan's Fluid Compute ceiling (800s) so the function lives long enough
// for any narration under ~30 min. If a longer audio file ever needs
// alignment, the right next step is chunking — not bumping past 800s.
export const maxDuration = 800;

/**
 * Owner-side route. Runs forced alignment for the assignment's full-audio
 * take and writes the result to `narrator_takes.alignment_json`.
 *
 * **Synchronous on purpose.** A 14-min file's forced alignment takes
 * roughly `duration × 0.3 + overhead` per ElevenLabs' published formula
 * — that's ~3-4 minutes for our typical input. The earlier fire-and-
 * forget version returned in <1s but the orchestrator's background work
 * had no guarantee of completing: without `waitUntil`, Vercel may reap
 * a function instance after the response is sent, leaving the row stuck
 * at 'running' until the 5-min stale-reclaim. Awaiting here means the
 * function lives for the full maxDuration (300s = 5 min) and the work
 * actually finishes.
 *
 * Client-side callers (polling auto-kick, "Retry" button) treat the
 * fetch as fire-and-forget so the UI doesn't block — the GET status
 * poll keeps the user informed of progress.
 *
 * Idempotent: the orchestrator's atomic 'running' claim collapses
 * concurrent kicks into one execution.
 *
 * Surfaces:
 *   - Auto-kick from the Narration tab's polling effect when status
 *     starts at 'pending'.
 *   - "Retry sync" button when alignment_status='failed'.
 *   - Manual diagnostic (curl) for ops.
 *
 * The auto-trigger from a fresh narrator upload completion lives in
 * /api/narrate/[token]/full-audio PATCH — that path also calls
 * `runAlignmentForAssignment`, fire-and-forget there because the PATCH
 * needs to return promptly to the narrator. If the PATCH-side run gets
 * reaped, the reviewer's auto-kick is the backstop.
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

    const result = await runAlignmentForAssignment(id);
    return NextResponse.json({ result });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('align route error', { detail });
    // Strip URL-shaped substrings before echoing the underlying error to
    // the client. Without this a Postgres error that includes a signed R2
    // URL in its detail field would leak to the browser. The truncation
    // is a hard upper bound — pg error messages routinely run to 1KB+.
    const safe = detail.replace(/https?:\/\/\S+/g, '<url>').slice(0, 240).trim();
    return NextResponse.json({
      error: `Failed to run alignment: ${safe}`,
    }, { status: 500 });
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
      // ISO string of when the orchestrator most recently claimed
      // 'running'. The UI uses this to render an elapsed-time counter
      // so the reviewer can see how long the sync has been working
      // (helps decide whether to wait or hit Stop).
      startedAt: take.alignment_started_at,
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
