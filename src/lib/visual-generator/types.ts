/**
 * Visual generator interface.
 *
 * The deployed cloud app uses Kie.ai (Veo / Sora / Kling / Flux 2 / etc).
 * The local-studio surface uses ComfyUI on localhost. Both implement the
 * same `VisualGenerator` interface so calling code (orchestrator, chain,
 * text-protect, batch pipeline) doesn't know which backend it's hitting.
 *
 * Phase 1 only ships `generateImage`. `generateClip` and `generateChained`
 * land in later phases — the interface declares them so the file
 * structure doesn't need to change as we go.
 *
 * `BackendId` is the discriminator stored on job rows so we can later
 * tell which backend produced which output (useful for QA + provenance).
 */

/** Discriminator for which backend ran the generation. */
export type BackendId = 'comfyui-local' | 'kie' | 'runpod' | 'replicate';

/** Common options accepted by every backend. Backend-specific fields
 *  (workflow id, model id, sampler etc) live in per-method options. */
export interface CommonGenOptions {
  /** Stable seed for reproducibility. Omit to let the backend pick. */
  seed?: number;
  /** Free-form prompt suffix the style system injects. Backends append
   *  it to the user prompt with a separating comma. */
  styleSuffix?: string;
  /** Negative prompt — currently used by Flux dev / HiDream / Wan paths.
   *  Backends that don't support negatives just ignore it. */
  negativePrompt?: string;
  /** Width in pixels. Backend may snap to its own multiple-of-N requirement. */
  width: number;
  /** Height in pixels. */
  height: number;
}

/** Options for `generateImage`. */
export interface GenerateImageOptions extends CommonGenOptions {
  /** Which workflow / model to use. For comfyui-local this maps to a
   *  workflow JSON template; for kie this maps to a model spec. */
  workflowId?: string;
  /** Optional reference image filename (already uploaded to ComfyUI's
   *  input/ folder via the upload-ref endpoint). When set, the backend
   *  swaps the t2i workflow for its i2i counterpart and uses this image
   *  as the starting latent. Composition follows the reference; content
   *  follows the prompt. */
  refImageFilename?: string;
  /** Denoising strength when `refImageFilename` is set. 1.0 = ignore
   *  the reference (full t2i). 0.0 = output the reference unchanged.
   *  Sweet spot for "same composition, new prompt" is ~0.75–0.90.
   *  Ignored when there is no reference image. */
  denoise?: number;
}

/** Options for `generateClip` (image-to-video). */
export interface GenerateClipOptions extends CommonGenOptions {
  workflowId?: string;
  /** First-frame image URL (must be reachable by the backend — for
   *  ComfyUI-local this means a file path or localhost URL). */
  firstFrameUrl: string;
  /** Target clip duration in seconds. Backends quantise to their model's
   *  supported lengths (LTX-2.3: 4–10s, Wan 2.2: 5–10s, etc). */
  durationSeconds: number;
}

/** Options for `generateChained` (reference chaining, Phase 2). */
export interface GenerateChainedOptions extends GenerateImageOptions {
  /** URL of the anchor image whose style/identity should carry over. */
  anchorImageUrl: string;
}

/** Result returned by every generation method. The URL may be local
 *  (a /api/local-studio/image proxy URL or a localhost ComfyUI /view
 *  URL) or remote — callers should not assume one or the other. */
export interface GenerationResult {
  /** Backend that produced this. */
  backend: BackendId;
  /** A URL the browser can fetch to display the output. For
   *  comfyui-local this is typically the ComfyUI /view URL since the
   *  user's browser can reach localhost directly. */
  url: string;
  /** Width / height of the actual output (may differ from request if
   *  the backend snapped to its grid). */
  width: number;
  height: number;
  /** Seed used. Always set, even when the caller didn't specify one. */
  seed: number;
  /** Total wall-clock time for the generation. */
  durationMs: number;
  /** Backend-specific opaque metadata (prompt_id, task_id, etc) for
   *  debugging or follow-up calls. */
  meta?: Record<string, unknown>;
}

/**
 * Visual generator contract. All backends implement this. Phase 1 only
 * uses `generateImage`; the rest are placeholders for later phases.
 *
 * Methods throw on failure (don't return error objects) — the API
 * route's `domainErrorResponse` helper classifies + logs uniformly.
 */
export interface VisualGenerator {
  /** Backend identifier. */
  readonly backend: BackendId;

  /** Health check. True if the backend is reachable and ready to serve. */
  isReachable(): Promise<boolean>;

  /** Text-to-image. */
  generateImage(prompt: string, options: GenerateImageOptions): Promise<GenerationResult>;

  /** Image-to-video (Phase 3). Throws `NotImplementedError` until then. */
  generateClip?(prompt: string, options: GenerateClipOptions): Promise<GenerationResult>;

  /** Reference-chained image generation (Phase 2). */
  generateChained?(
    prompt: string,
    options: GenerateChainedOptions,
  ): Promise<GenerationResult>;
}
