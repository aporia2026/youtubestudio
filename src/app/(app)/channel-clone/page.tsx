/**
 * Standalone Channel Clone page.
 *
 * First-class destination at `/channel-clone` — independent of the
 * auto-pipeline. Users land here, paste a competitor URL, and walk
 * through the eight-stage workflow without needing to spawn a
 * pipeline_run_videos row first.
 *
 * The panel can later also be embedded inside the production-doc
 * page (M5) so a user already inside a production-doc can clone
 * a channel in-context, but the canonical entry point is here.
 */

import type { Metadata } from 'next';
import { ChannelClonePanel } from '@/components/channel-clone/ChannelClonePanel';

export const metadata: Metadata = {
  title: 'Channel Clone',
  description:
    'Paste a competitor YouTube URL, analyze its style DNA, and walk the V2.0 prompt through topic, hook, script audit, and rowification — all in one place.',
};

export default function ChannelClonePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-100">Channel Clone</h1>
        <p className="text-sm text-neutral-400">
          Turn any explainer YouTube channel into a ready-to-render production-doc draft.
          The pipeline walks through intake, deep style/audience analysis, topic ideation,
          hook engineering, script generation, and the 10-point audit fix-loop — sourced
          from your ULTIMATE AI YOUTUBE CONTENT ENGINE V2.0 system prompt.
        </p>
        <p className="text-xs text-neutral-500">
          Intake runs locally (yt-dlp + ffmpeg) and only works in dev mode. The LLM stages
          run anywhere. See _plans/2026-06-05-channel-clone-pipeline.md.
        </p>
      </header>
      <ChannelClonePanel />
    </div>
  );
}
