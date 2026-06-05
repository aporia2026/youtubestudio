/**
 * Per-job channel-clone page at /channel-clone/[id].
 *
 * Resumes an existing channel-clone job — same panel, but seeded
 * with the supplied jobId so the panel's poller picks up where the
 * user left off (across browser refreshes, deep links from the
 * job list, etc.).
 */

import type { Metadata } from 'next';
import { ChannelClonePanel } from '@/components/channel-clone/ChannelClonePanel';

export const metadata: Metadata = {
  title: 'Channel Clone — Resume',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ChannelCloneResumePage({ params }: PageProps) {
  const { id } = await params;
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-100">Channel Clone — Job</h1>
        <p className="font-mono text-xs text-neutral-500">{id}</p>
      </header>
      <ChannelClonePanel initialJobId={id} />
    </div>
  );
}
