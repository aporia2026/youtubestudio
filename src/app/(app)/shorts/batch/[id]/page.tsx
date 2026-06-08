import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { getBatchWithShorts } from '@/lib/shorts-batches';
import { ResumeBatchClient } from './ResumeBatchClient';

/**
 * /shorts/batch/[id] — resume an existing batch. Loads the batch
 * server-side and dispatches to the right step based on its status.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Refresh-safe: every state is server-backed (the `shorts_batches`
 * row + the child `shorts` rows), so reopening this URL from any
 * browser drops the user back into exactly where the batch is.
 */
export default async function ResumeBatchPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireUser();

  const bundle = await getBatchWithShorts(id, session.ws);
  if (!bundle) {
    notFound();
  }

  return <ResumeBatchClient batchId={id} initialStatus={bundle.batch.status} channelId={bundle.batch.channel_id ?? ''} />;
}
