/**
 * OpenAI GPT Image 2 — direct API helpers.
 *
 * Built as an "emergency" fast-path alongside the existing Kie.ai route.
 * OpenAI's image endpoints are SYNCHRONOUS — they return the rendered image
 * inline in a single round-trip — whereas Kie's gpt-image-2-image-to-image
 * task takes ~30-300s with polling and occasionally times out the function.
 * Hitting OpenAI direct typically returns in 20-60s for a 16:9 thumbnail.
 *
 * Two endpoints wrapped:
 *   - POST /v1/images/generations  → text-to-image
 *   - POST /v1/images/edits        → image-to-image (multipart, with the
 *                                    reference image as a file upload)
 *
 * Pricing (verified 2026-05-19 from developers.openai.com/api/docs):
 *   - 1536×1024 low:    $0.005 / image
 *   - 1536×1024 medium: $0.041 / image  (default for this app)
 *   - 1536×1024 high:   $0.165 / image
 * Medium is roughly equivalent to Kie's price; high is ~2-3× more.
 *
 * The OpenAI Node SDK is already imported elsewhere in the codebase (see
 * src/lib/ai.ts) — we reuse the same import + key resolution pattern.
 */

import type { Buffer } from 'node:buffer';

export type OpenAIImageQuality = 'low' | 'medium' | 'high' | 'auto';
export type OpenAIImageSize = '1024x1024' | '1536x1024' | '1024x1536' | 'auto';

export interface OpenAIImageOptions {
  prompt: string;
  /** Output size. For YouTube thumbnails use `1536x1024` (16:9 landscape).
   *  All values must be in the validated set per OpenAI's docs. */
  size?: OpenAIImageSize;
  /** Quality tier. Default `medium` keeps cost in line with the Kie path. */
  quality?: OpenAIImageQuality;
  /** Optional reference image as raw bytes + mime. When provided, routes
   *  to `/v1/images/edits` (multipart) instead of `/v1/images/generations`
   *  (JSON). Required for the image-to-image use case. */
  referenceImage?: { bytes: Buffer; mimeType: string; filename?: string };
}

export interface OpenAIImageResult {
  /** The image rendered. We always request b64_json and the caller decides
   *  whether to forward as a data URL or upload to R2. */
  base64: string;
  /** The mime type to pair with the base64 when building a data URL.
   *  OpenAI defaults to PNG; we don't override. */
  mimeType: 'image/png';
  /** OpenAI's "revised_prompt" — the rewritten prompt the model actually
   *  used. Useful for debugging when the output drifts. */
  revisedPrompt?: string;
}

function requireOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY is not configured. Set it in your Vercel project to use the OpenAI-direct GPT Image 2 path.',
    );
  }
  return key;
}

/**
 * Call OpenAI's GPT Image 2 directly. Returns base64-encoded PNG bytes.
 *
 * The caller is responsible for serialising the result back to the user —
 * either inline as `data:image/png;base64,…` (works for `<img>` but not for
 * a saved-thumbnail URL), or by uploading to R2 and returning the
 * permanent URL (the right call when the image goes into history or a
 * project record). Both shapes are supported by the thumbnails page's
 * existing rendering code.
 */
export async function generateImageOpenAI(opts: OpenAIImageOptions): Promise<OpenAIImageResult> {
  const apiKey = requireOpenAIKey();
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const size: OpenAIImageSize = opts.size ?? '1536x1024';
  const quality: OpenAIImageQuality = opts.quality ?? 'medium';

  if (opts.referenceImage) {
    // Image-to-image via /v1/images/edits. The SDK's `images.edit` method
    // wraps the multipart upload — we hand it a File-like blob built from
    // the raw bytes. `toFile` is the SDK's official helper.
    const { toFile } = await import('openai');
    const filename = opts.referenceImage.filename ?? 'reference.png';
    const fileLike = await toFile(
      opts.referenceImage.bytes,
      filename,
      { type: opts.referenceImage.mimeType },
    );
    const response = await client.images.edit({
      model: 'gpt-image-2',
      image: fileLike,
      prompt: opts.prompt,
      size,
      quality,
      response_format: 'b64_json',
      n: 1,
    });
    const data = response.data?.[0];
    if (!data?.b64_json) {
      throw new Error('OpenAI image edit returned no image data.');
    }
    return {
      base64: data.b64_json,
      mimeType: 'image/png',
      revisedPrompt: data.revised_prompt,
    };
  }

  // Text-to-image via /v1/images/generations.
  const response = await client.images.generate({
    model: 'gpt-image-2',
    prompt: opts.prompt,
    size,
    quality,
    response_format: 'b64_json',
    n: 1,
  });
  const data = response.data?.[0];
  if (!data?.b64_json) {
    throw new Error('OpenAI image generation returned no image data.');
  }
  return {
    base64: data.b64_json,
    mimeType: 'image/png',
    revisedPrompt: data.revised_prompt,
  };
}

/** True if the given image-model id routes through OpenAI direct (rather
 *  than Kie.ai). Used by the format image endpoints to pick the right
 *  generation path. */
export function isOpenAIDirectImageModel(modelId: string): boolean {
  return modelId === 'gpt-image-2-openai-t2i' || modelId === 'gpt-image-2-openai-i2i';
}
