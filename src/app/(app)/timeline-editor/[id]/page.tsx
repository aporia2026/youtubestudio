/**
 * Per-doc timeline editor at /timeline-editor/[id].
 *
 * Loads a saved ProductionDoc by user_history id, mounts the
 * editor, and lets the user save back. Server component for the
 * page shell + metadata; the client wrapper handles loading,
 * mutation, undo/redo, and persistence.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md (M5).
 */

import type { Metadata } from 'next';
import { TimelineEditorByIdClient } from '@/components/timeline-editor/TimelineEditorByIdClient';

export const metadata: Metadata = {
  title: 'Timeline editor',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TimelineEditorByIdPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-100">Timeline Editor</h1>
        <p className="text-xs font-mono text-neutral-500">{id}</p>
      </header>
      <TimelineEditorByIdClient historyEntryId={id} />
    </div>
  );
}
