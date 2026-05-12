/**
 * Stage handler: thumbnail generation. **STUB** in v1.
 *
 * The real handler will:
 *   1. Read `preset.thumbnail_template_id` to find the configured
 *      `thumbnail_template_presets` row (or fall back to a
 *      workspace default when null).
 *   2. Build the image-gen prompt from the template's
 *      `context_description` + idea/script title.
 *   3. If `template.include_text`, render with text overlay using
 *      the configured overlay config.
 *   4. Call the image-gen chain (text-to-image fallback chain;
 *      analogous to `generateTextWithFallback` but for Kie image
 *      gen — TBD lib).
 *   5. Persist the resulting URL to `pipeline_run_videos.thumbnail_url`.
 *
 * Tuesday's stub: no-op advance. The state-machine ships complete
 * so the orchestrator can dispatch on this stage from day 1; the
 * real implementation lands in a follow-up push when the
 * thumbnail-template CRUD UI is also ready.
 */
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';

export async function handleGenerateThumbnail(ctx: StageHandlerContext): Promise<StageOutcome> {
  logger.info('auto-pipeline: thumbnail stub — advancing without generating', {
    pipeline_video_id: ctx.video.id,
    thumbnail_template_id: ctx.preset.thumbnail_template_id,
    note: 'real impl ships in a follow-up push',
  });
  return {
    kind: 'advance',
    nextStage: 'assigning_to_editor',
    // Leaving thumbnail_url null is intentional — the UI must
    // surface "no thumbnail yet" instead of pretending one was
    // produced. When the real handler ships, this update writes
    // the generated URL.
  };
}
