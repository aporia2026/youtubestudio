/**
 * Standalone CapCut-style timeline editor demo at /timeline-editor.
 *
 * M1 of the plan: shows the timeline reading a sample ProductionDoc
 * so the user can see the visual surface render correctly. M2 wires
 * trim/drag-resize; M3 adds split/cut; M4 reorder; M5 undo/redo;
 * M6 audio (waveform + voiceover_segments). Once those land, this
 * page can either stay as a demo or be replaced by inline mounts
 * on /production-doc and /video-studio.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md.
 */

import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import type { ProductionDoc } from '@/remotion/utils';

const TimelineEditorDemo = dynamic(
  () => import('@/components/timeline-editor/TimelineEditorDemo').then((m) => m.TimelineEditorDemo),
  { ssr: false, loading: () => <p className="text-xs text-neutral-500">Loading editor…</p> },
);

export const metadata: Metadata = {
  title: 'Timeline editor (M1 demo)',
};

const SAMPLE_DOC: ProductionDoc = {
  title: 'Sample — Why Do We Cry?',
  niche: 'Existential Explainer',
  total_duration: '0:30',
  total_words: 100,
  speaking_pace_wpm: 120,
  rows: [
    {
      timecode: '0:00-0:04',
      script_text: 'Right now, you are the only creature on this planet that can do something strange.',
      visual_type: 'ai_image',
      visual_description: 'Stick figure looking up at the sky.',
      stock_search_terms: '',
      ai_image_prompt: 'Hand-drawn stick figure in awe under a vast sky, minimal black ink on white.',
      on_screen_text: 'YOU',
      notes: 'Hook.',
    },
    {
      timecode: '0:04-0:08',
      script_text: 'You can leak salt water from your eyes when your heart breaks.',
      visual_type: 'ai_image',
      visual_description: 'Close-up of a single tear running down a stick figure.',
      stock_search_terms: '',
      ai_image_prompt: 'Doodle close-up of a tear streaming down a stick face, marker on white.',
      on_screen_text: 'CRYING',
      notes: 'Twist.',
    },
    {
      timecode: '0:08-0:13',
      script_text: 'A dog whimpers, a wolf howls, but not one of them has ever cried a single emotional tear.',
      visual_type: 'ai_image',
      visual_description: 'Dog, wolf, monkey side by side in line-art style.',
      stock_search_terms: '',
      ai_image_prompt: 'Hand-drawn dog wolf monkey lined up looking at viewer, minimal black ink doodle.',
      on_screen_text: '',
      notes: 'Comparison.',
    },
    {
      timecode: '0:13-0:18',
      script_text: 'Only you. And the reason is far stranger than we get sad.',
      visual_type: 'ai_image',
      visual_description: 'Stick figure pointing at viewer.',
      stock_search_terms: '',
      ai_image_prompt: 'Hand-drawn stick figure pointing forward, dramatic angle, marker on white.',
      on_screen_text: 'ONLY YOU',
      notes: 'Callback.',
    },
    {
      timecode: '0:18-0:24',
      script_text: 'It might be one of the most sophisticated things your species ever evolved.',
      visual_type: 'ai_image',
      visual_description: 'Brain with intricate connections, doodle style.',
      stock_search_terms: '',
      ai_image_prompt: 'Doodle of a brain with connecting wires, marker on white, slight curiosity.',
      on_screen_text: 'EVOLVED',
      notes: 'Setup for the payoff.',
    },
    {
      timecode: '0:24-0:30',
      script_text: 'Most people assume crying is simple — something bad happens, water comes out.',
      visual_type: 'ai_image',
      visual_description: 'Stick figure shrugging.',
      stock_search_terms: '',
      ai_image_prompt: 'Hand-drawn stick figure shrugging, marker on white, neutral expression.',
      on_screen_text: 'SIMPLE?',
      notes: 'Reframe.',
    },
  ],
};

export default function TimelineEditorDemoPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-100">Timeline Editor</h1>
        <p className="text-sm text-neutral-400">
          CapCut-style cut · trim · split · drag-resize for the production-doc rows.
          M1 shows the timeline rendering a sample doc — interactions land in M2–M6.
        </p>
        <p className="text-xs text-neutral-500">
          Plan: <code className="rounded bg-neutral-900 px-1 py-0.5 text-[10px]">_plans/2026-06-05-capcut-timeline-editor.md</code>
        </p>
      </header>
      <TimelineEditorDemo initialDoc={SAMPLE_DOC} />
    </div>
  );
}
