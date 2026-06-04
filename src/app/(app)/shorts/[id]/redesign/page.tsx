/**
 * Static prototype of the redesigned Shorts editor. Renders alongside the
 * working editor at `/shorts/[id]/redesign` so the layout can be reviewed
 * against a real Short before any control logic moves.
 *
 * Plan: `_plans/2026-06-04-shorts-editor-redesign-split-tabs.md`.
 * Delete this route once Phase 2 ships the real refactor.
 */
import { ShortEditorRedesignPreview } from '@/components/shorts/ShortEditorRedesignPreview';

export default async function ShortEditorRedesignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ShortEditorRedesignPreview shortId={id} />;
}
