/**
 * Standalone Channel Clone landing page.
 *
 * Two sections:
 *   1. New job — the ChannelClonePanel with empty initial state.
 *   2. Recent jobs — the workspace's last N channel-clone runs,
 *      each linking to /channel-clone/[id] for resume.
 *
 * First-class destination, no auto-pipeline dependency required.
 * The panel can also be embedded inside the production-doc page
 * later (M5+) but the canonical entry is here.
 */

import type { Metadata } from 'next';
import { ChannelClonePanel } from '@/components/channel-clone/ChannelClonePanel';
import { ChannelCloneJobList } from '@/components/channel-clone/ChannelCloneJobList';
import { ChannelCloneConfigView } from '@/components/channel-clone/ChannelCloneConfigView';
import { NewSessionButton } from '@/components/channel-clone/NewSessionButton';

export const metadata: Metadata = {
  title: 'Channel Clone',
  description:
    'Paste a competitor YouTube URL, analyze its style DNA, and walk the V2.0 prompt through topic, hook, script audit, and rowification — all in one place.',
};

export default function ChannelClonePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold text-neutral-100">Channel Clone</h1>
          <NewSessionButton />
        </div>
        <p className="text-sm text-neutral-400">
          Turn any explainer YouTube channel into a ready-to-render production-doc draft.
          The pipeline walks through intake, deep style/audience analysis, topic ideation,
          hook engineering, script generation, the 10-point audit fix-loop, rowification,
          publish pack, and optional handoff to the auto-pipeline — sourced from your
          ULTIMATE AI YOUTUBE CONTENT ENGINE V2.0 system prompt.
        </p>
        <p className="text-xs text-neutral-500">
          Intake runs locally (yt-dlp + ffmpeg) and only works in dev mode. The LLM stages
          run anywhere.
        </p>
      </header>

      <ChannelCloneConfigView />

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-neutral-200">Recent runs</h2>
        <ChannelCloneJobList />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-neutral-200">Start a new run</h2>
        <ChannelClonePanel />
      </section>
    </div>
  );
}
