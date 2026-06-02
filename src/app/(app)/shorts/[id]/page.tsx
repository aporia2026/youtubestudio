/**
 * Shorts editor — Phase 15.10. Mirrors the production-doc page's shape:
 * Remotion preview at the top + sectioned editor below. The client
 * component owns all the state, fetches, and Remotion mounts.
 *
 * Server component here is just a thin params-passing wrapper.
 */
import { ShortEditor } from '@/components/shorts/ShortEditor';

export default async function ShortEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ShortEditor shortId={id} />;
}
