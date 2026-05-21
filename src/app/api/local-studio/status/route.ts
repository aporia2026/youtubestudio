/**
 * GET /api/local-studio/status
 *
 * Reports whether ComfyUI on localhost:8188 is reachable. Used by the
 * `/local-studio` page to render a green/red status pill before the
 * user types a prompt — saves a wasted POST when the backend is down.
 *
 * Also surfaces the workflow lineup so the UI doesn't have to import
 * server-only modules to build its picker.
 *
 * Gated by `LOCAL_STUDIO=1`.
 */
import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { ComfyUILocalGenerator } from '@/lib/visual-generator/comfyui-local';
import { LOCAL_VIDEO_WORKFLOWS, LOCAL_WORKFLOWS } from '@/lib/comfyui/style-mapping';
import { BUILT_IN_STYLES } from '@/lib/production-doc-styles';

// Public route — local-studio is local-first by contract. The
// LOCAL_STUDIO=1 env flag is the gate. No session check (which would
// hit the cloud DB and break the page whenever Postgres is down).
// Built-in styles only for now; saved styles return in a later phase
// when production-doc integration lands and we have a clear path for
// resolving the workspace without a session lookup.
export const GET = apiRoute.public(async () => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const generator = new ComfyUILocalGenerator();
  const reachable = await generator.isReachable();

  return NextResponse.json({
    reachable,
    backend: 'comfyui-local' as const,
    workflows: LOCAL_WORKFLOWS,
    videoWorkflows: LOCAL_VIDEO_WORKFLOWS,
    styles: BUILT_IN_STYLES.map(s => ({
      id: s.id,
      label: s.label,
      description: s.description ?? null,
      origin: s.origin,
    })),
    stylesSource: 'built-in' as const,
    comfyuiUrl: 'http://127.0.0.1:8188',
  });
});
