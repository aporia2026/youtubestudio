/**
 * Stage handler: thumbnail generation.
 *
 * Reads the configured `thumbnail_template_presets` row (or falls
 * back to a sensible default when `preset.thumbnail_template_id`
 * is null), builds an image prompt from the template's
 * `context_description` + the idea title + niche, and runs the
 * Kie image-gen chain (`generateImageWithFallback`).
 *
 * The image fallback chain matches the production-doc model
 * defaults from `image-models.ts`. v1 doesn't expose a per-preset
 * thumbnail image-model chain — that's a v1.1 surface alongside
 * the production-doc image picker rework.
 *
 * On success: thumbnail_url set on the video row, advance to
 * `assigning_to_editor`. On chain exhaustion: terminal
 * `thumbnail_failed` with the failure class from the last attempt.
 */
import { sql } from '@vercel/postgres';
import { generateImageWithFallback, ImageGenerationFailure } from '../image-gen';
import { IMAGE_MODELS } from '../../image-models';
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';

/**
 * Default fallback chain for pipeline thumbnails. Cross-family
 * primaries → Flux as a quality backup → NanoBanana for cheap
 * last resort. Mirrors the spirit of DEFAULT_FALLBACK_CHAINS for
 * text but constrained to t2i image models.
 */
const DEFAULT_THUMBNAIL_CHAIN: readonly string[] = ['grok-imagine-t2i', 'flux2-pro-t2i', 'nano-banana'];

interface ThumbnailTemplate {
  context_description: string | null;
  include_text: boolean;
  text_overlay_config_jsonb: Record<string, unknown> | null;
  image_references_jsonb: unknown;
}

export async function handleGenerateThumbnail(ctx: StageHandlerContext): Promise<StageOutcome> {
  const { video, preset } = ctx;

  if (!video.idea_id || !video.project_id) {
    return {
      kind: 'fail',
      terminalStage: 'thumbnail_failed',
      failureClass: 'invariant_violation',
      failureMessage: 'thumbnail handler reached without idea_id / project_id.',
    };
  }

  // Load the idea title + niche for the prompt.
  const { rows: ideaRows } = await sql.query<{ title: string; niche: string | null }>(
    `
    SELECT title, niche
      FROM video_ideas
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [video.idea_id, video.workspace_id],
  );
  if (ideaRows.length === 0) {
    return {
      kind: 'fail',
      terminalStage: 'thumbnail_failed',
      failureClass: 'idea_missing',
      failureMessage: `Idea ${video.idea_id} not found.`,
    };
  }
  const { title, niche: ideaNiche } = ideaRows[0];
  const niche = ideaNiche || preset.niche || '';

  // Load the template if configured.
  let template: ThumbnailTemplate | null = null;
  if (preset.thumbnail_template_id) {
    const { rows: templateRows } = await sql.query<ThumbnailTemplate>(
      `
      SELECT context_description,
             include_text,
             text_overlay_config_jsonb,
             image_references_jsonb
        FROM thumbnail_template_presets
       WHERE id = $1::uuid AND workspace_id = $2::uuid
      `,
      [preset.thumbnail_template_id, video.workspace_id],
    );
    if (templateRows.length > 0) {
      template = templateRows[0];
    } else {
      logger.warn('auto-pipeline: thumbnail_template_id set but template not found', {
        pipeline_video_id: video.id,
        thumbnail_template_id: preset.thumbnail_template_id,
      });
    }
  }

  const prompt = buildThumbnailPrompt({ title, niche, template });

  let result: Awaited<ReturnType<typeof generateImageWithFallback>>;
  try {
    result = await generateImageWithFallback(DEFAULT_THUMBNAIL_CHAIN, prompt, {
      blobPathPrefix: 'pipeline-thumbnails',
    });
  } catch (err) {
    if (err instanceof ImageGenerationFailure) {
      return {
        kind: 'fail',
        terminalStage: 'thumbnail_failed',
        failureClass: err.lastFailureClass,
        failureMessage: err.message.slice(0, 500),
      };
    }
    throw err;
  }

  logger.info('auto-pipeline: thumbnail generated', {
    pipeline_video_id: video.id,
    model_used: result.modelUsed,
    attempts: result.attempts.length,
  });

  return {
    kind: 'advance',
    nextStage: 'assigning_to_editor',
    persist: { thumbnail_url: result.imageUrl },
  };
}

/**
 * Build the image prompt from the (optional) template + idea
 * metadata. The output is plain text the Kie image API consumes.
 *
 * When no template is configured, the prompt is just the title +
 * niche with a sensible style suffix. When a template IS
 * configured:
 *   - prepend the template's free-text `context_description`
 *   - if `include_text=true`, add a text-overlay instruction
 *     reading the title (or the configured override)
 *   - if `image_references_jsonb` has reference URLs, include them
 *     as inspiration cues — Kie's t2i models don't accept
 *     reference-image inputs (that's i2i, v2 territory), so we
 *     describe them in the prompt instead.
 */
function buildThumbnailPrompt(args: {
  title: string;
  niche: string;
  template: ThumbnailTemplate | null;
}): string {
  const { title, niche, template } = args;
  const parts: string[] = [];

  if (template?.context_description) {
    parts.push(template.context_description.trim());
  }

  parts.push(`YouTube thumbnail for a video titled "${title}".`);
  if (niche) parts.push(`Topic / niche: ${niche}.`);

  parts.push(
    '16:9 aspect ratio, eye-catching composition, high contrast, optimised for small-screen viewing on the YouTube watch-next sidebar.',
  );

  if (template?.include_text) {
    const overlay = template.text_overlay_config_jsonb as Record<string, unknown> | null;
    const overrideText = typeof overlay?.text === 'string' ? overlay.text : null;
    const position = typeof overlay?.position === 'string' ? overlay.position : 'centered';
    const textToShow = overrideText || shortenTitleForOverlay(title);
    parts.push(`Include large bold text overlay reading "${textToShow}", positioned ${position}.`);
  } else if (template) {
    parts.push('No text overlay — image-only thumbnail.');
  }

  // Inspiration cues — short, lightweight. Real image-to-image
  // reference would use the i2i variants (v2).
  if (Array.isArray(template?.image_references_jsonb)) {
    const refs = (template.image_references_jsonb as unknown[])
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 3);
    if (refs.length > 0) {
      parts.push(
        `Style inspiration cues (not literal references — describe similar mood / composition): ${refs.length} reference image(s) supplied by the user.`,
      );
    }
  }

  return parts.join(' ');
}

/**
 * YouTube thumbnails generally read better with 4-6 words of
 * overlay text. The full title might be 70-100 chars. Pick the
 * first short clause if possible.
 */
function shortenTitleForOverlay(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= 40) return trimmed;
  // Break on first colon, em-dash, or end of the first 5-6 words.
  const onColon = trimmed.split(/[:—\-—]/)[0].trim();
  if (onColon.length >= 8 && onColon.length <= 40) return onColon;
  const words = trimmed.split(/\s+/);
  return words.slice(0, 6).join(' ');
}

// Export for tests.
export { buildThumbnailPrompt, shortenTitleForOverlay, DEFAULT_THUMBNAIL_CHAIN };
// Re-export needed so any cron callable can pin IMAGE_MODELS knowledge
// once thumbnail-template UI ships. Currently unused by tests.
export { IMAGE_MODELS };
