import { NextRequest, NextResponse } from 'next/server';
import { stitchAssignmentVoiceover } from '@/lib/narrator-stitch';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Stitch all approved/selected takes for this assignment into a single
 * voiceover and publish it as a project media_asset.
 *
 * Owner-initiated manual trigger — re-stitches on every call. The
 * auto-stitch hook on the section approval PUT route checks for an
 * existing voiceover media_asset before invoking the same helper so
 * automatic runs don't multiply rows.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await stitchAssignmentVoiceover(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: result.status });
    }
    return NextResponse.json({ url: result.url, size: result.size, sections: result.sections });
  } catch (err) {
    logger.error('stitch error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to stitch audio' }, { status: 500 });
  }
}
