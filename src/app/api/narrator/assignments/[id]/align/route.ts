import { NextRequest, NextResponse } from 'next/server';
import { getAssignment, getFullAudioTakeWithAlignment } from '@/lib/narrator-db';
import { runAlignmentForAssignment } from '@/lib/alignment';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
// Forced alignment on a ~14min file finishes in well under a minute in
// practice, but Vercel's default is 60s — bump to the same envelope the
// stitch route uses so we have headroom for the occasional slow request.
export const maxDuration = 300;

/**
 * Owner-side route. Runs (or re-runs) forced alignment for the assignment's
 * full-audio take and writes the result to `narrator_takes.alignment_json`.
 *
 * Idempotent — the orchestrator's atomic 'running' claim means parallel
 * invocations resolve to one execution.
 *
 * Surfaces:
 *   - "Retry sync" button on the Narration tab's synced player when
 *     alignment_status='failed'.
 *   - Manual diagnostic (curl) for ops.
 *
 * The auto-trigger from a narrator upload completion lives in
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

    const result = await runAlignmentForAssignment(id);
    return NextResponse.json({ result });
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
