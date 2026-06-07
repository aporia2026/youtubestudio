/**
 * Channel Clone — Templates landing page (Plan 2).
 *
 * Lists every live saved template in the workspace with its
 * created-at, video count, total bytes, and a one-click delete.
 *
 * Separate from the channel-clone landing page (where the
 * `<UseTemplateDropdown>` lives) so the operator has a dedicated
 * surface for management: "show me ALL my templates so I can audit
 * what's eating storage and clean up the stale ones."
 *
 * Storage-cost transparency (rule 8): every row shows the byte
 * count, plus a running total at the bottom so the operator knows
 * exactly what these templates are costing them.
 */

import type { Metadata } from 'next';
import { ChannelCloneTemplatesList } from '@/components/channel-clone/ChannelCloneTemplatesList';

export const metadata: Metadata = {
  title: 'Channel Clone Templates',
  description:
    'Saved channel-clone configurations including the uploaded reference videos. Re-spin new runs from any template without re-uploading.',
};

export default function ChannelCloneTemplatesPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-100">Channel Clone Templates</h1>
        <p className="text-sm text-neutral-400">
          Saved configurations from past upload-intake runs. Each template owns its own copies of
          the reference videos so it survives deletion of the source job.
        </p>
        <p className="text-xs text-neutral-500">
          To save a template: complete an upload-intake run on the{' '}
          <a href="/channel-clone" className="text-blue-400 hover:underline">
            channel-clone page
          </a>
          , then press "Save as template" on the run header.
        </p>
      </header>

      <ChannelCloneTemplatesList />
    </div>
  );
}
