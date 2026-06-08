import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { uploadBatchReadyShorts } from '@/lib/shorts-batch-uploader';
import { getBatch, updateBatchStatus, BatchStateTransitionError } from '@/lib/shorts-batches';

/**
 * POST /api/shorts/batches/[id]/upload-all
 *
 * Drain every upload-ready short in the batch sequentially to
 * YouTube. Transitions the batch into 'uploading' before draining and
 * back into 'done' afterwards (regardless of per-short success — the
 * outcome array carries which uploads worked).
 *
 * Pre-flight: batch must be in 'review' status (post-generation,
 * pre-upload). Returns 409 on any other status to make the call site
 * unambiguous.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const batch = await getBatch(id, session.ws);
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.status !== 'review') {
      return NextResponse.json(
        { error: `Batch is in '${batch.status}'; upload-all is only valid from 'review'.` },
        { status: 409 },
      );
    }

    try {
      await updateBatchStatus(id, session.ws, 'uploading');
    } catch (err) {
      if (err instanceof BatchStateTransitionError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }

    const outcome = await uploadBatchReadyShorts({ batchId: id, workspaceId: session.ws });

    // Always move to 'done' after draining — per-short failures live
    // on the short row, not the batch. The user retries failed shorts
    // individually from the review queue.
    try {
      await updateBatchStatus(id, session.ws, 'done');
    } catch {
      // If the state machine refused (e.g. the user re-triggered the
      // upload while we were running), leave the status as-is rather
      // than masking the underlying drift.
    }

    return NextResponse.json(outcome);
  },
);
