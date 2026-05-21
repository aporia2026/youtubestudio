/**
 * ComfyUI-backed local implementation of `VisualGenerator`.
 *
 * Loads workflow JSON templates from `src/lib/comfyui/workflows/`,
 * substitutes the caller's prompt + dimensions + seed, submits to
 * `localhost:8188`, polls until done, and returns the output URL.
 *
 * Workflow JSON is loaded eagerly at module init via `fs.readFileSync`
 * so the API route doesn't pay disk-IO cost per request. Templates are
 * small (~1–3 KB) so the bundle hit is negligible.
 *
 * Phase 1 only implements `generateImage`. The other methods are
 * stubbed with `NotImplementedError` so calling code gets a clear
 * signal when those phases haven't shipped yet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComfyUIClient, DEFAULT_COMFYUI_URL } from '@/lib/comfyui/client';
import { fillWorkflow, randomSeed, type PlaceholderMap } from '@/lib/comfyui/workflow-fill';
import {
  i2iVariantOf,
  isKnownLocalVideoWorkflow,
  isKnownLocalWorkflow,
  type LocalImageWorkflowId,
  type LocalVideoWorkflowId,
} from '@/lib/comfyui/style-mapping';
import { logger } from '@/lib/logger';
import type {
  BackendId,
  GenerateClipOptions,
  GenerateImageOptions,
  GenerationResult,
  VisualGenerator,
} from './types';

const WORKFLOWS_DIR = join(process.cwd(), 'src', 'lib', 'comfyui', 'workflows');

/** Templates loaded at module init. Keyed by workflow id; throws on
 *  startup if any declared workflow is missing from disk. */
const WORKFLOW_TEMPLATES: Readonly<Record<LocalImageWorkflowId, string>> = Object.freeze({
  'flux-schnell-t2i': readFileSync(join(WORKFLOWS_DIR, 'flux-schnell-t2i.json'), 'utf8'),
  'flux-schnell-i2i': readFileSync(join(WORKFLOWS_DIR, 'flux-schnell-i2i.json'), 'utf8'),
  'flux-dev-t2i': readFileSync(join(WORKFLOWS_DIR, 'flux-dev-t2i.json'), 'utf8'),
  'flux-dev-i2i': readFileSync(join(WORKFLOWS_DIR, 'flux-dev-i2i.json'), 'utf8'),
  'hidream-i1-dev-t2i': readFileSync(join(WORKFLOWS_DIR, 'hidream-i1-dev-t2i.json'), 'utf8'),
  'hidream-i1-dev-i2i': readFileSync(join(WORKFLOWS_DIR, 'hidream-i1-dev-i2i.json'), 'utf8'),
  'qwen-image-t2i': readFileSync(join(WORKFLOWS_DIR, 'qwen-image-t2i.json'), 'utf8'),
  'qwen-image-i2i': readFileSync(join(WORKFLOWS_DIR, 'qwen-image-i2i.json'), 'utf8'),
  'qwen-image-edit-2509-i2i': readFileSync(join(WORKFLOWS_DIR, 'qwen-image-edit-2509-i2i.json'), 'utf8'),
} as Record<LocalImageWorkflowId, string>);

/** Video workflow templates — keyed by `LocalVideoWorkflowId`. Loaded
 *  eagerly at module init like image templates. */
const VIDEO_WORKFLOW_TEMPLATES: Readonly<Record<LocalVideoWorkflowId, string>> = Object.freeze({
  'wan-2.2-i2v': readFileSync(join(WORKFLOWS_DIR, 'wan-2.2-i2v.json'), 'utf8'),
  'hunyuan-i2v': readFileSync(join(WORKFLOWS_DIR, 'hunyuan-i2v.json'), 'utf8'),
});

export class NotImplementedError extends Error {
  constructor(method: string, phase: string) {
    super(`${method} not implemented yet — lands in ${phase}`);
    this.name = 'NotImplementedError';
  }
}

export class ComfyUILocalGenerator implements VisualGenerator {
  readonly backend: BackendId = 'comfyui-local';
  private readonly client: ComfyUIClient;

  constructor(opts: { url?: string } = {}) {
    this.client = new ComfyUIClient({ url: opts.url ?? DEFAULT_COMFYUI_URL });
  }

  async isReachable(): Promise<boolean> {
    return this.client.isReachable();
  }

  async generateImage(
    prompt: string,
    options: GenerateImageOptions,
  ): Promise<GenerationResult> {
    if (!prompt.trim()) {
      throw new Error('prompt is empty');
    }
    const baseWorkflowId = (options.workflowId ?? 'flux-schnell-t2i') as LocalImageWorkflowId;
    if (!isKnownLocalWorkflow(baseWorkflowId)) {
      throw new Error(`Unknown local workflow: ${baseWorkflowId}`);
    }
    // When a reference image is attached, swap to the i2i variant of
    // the same model family. Keeps the model+style choice intact while
    // changing the workflow shape.
    const workflowId = options.refImageFilename
      ? i2iVariantOf(baseWorkflowId)
      : baseWorkflowId;
    const template = WORKFLOW_TEMPLATES[workflowId];
    if (!template) {
      // Defensive — `isKnownLocalWorkflow` should have already filtered
      // unknown ids, but a future bug that adds an id without shipping
      // the JSON shouldn't crash deeper in JSON.parse.
      throw new Error(`Workflow ${workflowId} is declared but its template is not on disk`);
    }

    // The style suffix is the production-doc-styles output appended to
    // the user prompt. We join with a comma so the model treats it as
    // an additional clause rather than a continuation.
    const fullPrompt = options.styleSuffix
      ? `${prompt.trim()}, ${options.styleSuffix.trim()}`
      : prompt.trim();

    const seed = options.seed ?? randomSeed();

    // Width/height are nudged to multiples of 8 — every model in the
    // mix tolerates this and refusing on odd values is silently buggy.
    const width = Math.max(256, Math.min(2048, Math.round(options.width / 8) * 8));
    const height = Math.max(256, Math.min(2048, Math.round(options.height / 8) * 8));

    const values: PlaceholderMap = {
      PROMPT: fullPrompt,
      WIDTH: width,
      HEIGHT: height,
      SEED: seed,
    };

    // Multi-ref pathway (Qwen-Image-Edit-2509) — cross-attention
    // conditioning via TextEncodeQwenImageEditPlus. Always populates
    // 3 ref slots; if the caller supplied <3, duplicate position-0
    // anchor into the remaining slots so all LoadImage nodes have a
    // real file. Denoise is baked into the workflow JSON (1.0) so we
    // intentionally skip the DENOISE placeholder here.
    if (workflowId === 'qwen-image-edit-2509-i2i') {
      const refs: readonly string[] = options.refImageFilenames
        ?? (options.refImageFilename ? [options.refImageFilename] : []);
      if (refs.length === 0) {
        throw new Error('qwen-image-edit-2509-i2i requires at least one reference image');
      }
      // Symmetric fallback: when fewer than 3 refs are supplied, all
      // unused slots fall back to the position-0 anchor (the
      // strongest by convention) rather than the last-supplied
      // ref. Matches the doc comment "duplicates position-0 into
      // unused slots" and gives uniform over-anchoring rather than
      // an asymmetric mix.
      values.REF_IMAGE_1 = refs[0];
      values.REF_IMAGE_2 = refs[1] ?? refs[0];
      values.REF_IMAGE_3 = refs[2] ?? refs[0];
    } else if (options.refImageFilename) {
      // Single-ref legacy pathway (Qwen-Image i2i, Flux Redux, etc.) —
      // VAE-encode-as-latent. Sweet-spot denoise for "same composition,
      // new prompt": 0.85. Clamp to (0, 1) — 0 echoes the reference,
      // 1 ignores it (use t2i instead).
      values.REF_IMAGE = options.refImageFilename;
      const requestedDenoise = options.denoise ?? 0.85;
      values.DENOISE = Math.min(0.99, Math.max(0.05, requestedDenoise));
    }

    logger.info('[local-studio submit]', {
      workflow: workflowId,
      width,
      height,
      seed,
      has_ref: Boolean(options.refImageFilename),
      denoise: values.DENOISE ?? null,
      prompt_preview: fullPrompt.slice(0, 80),
    });

    const graph = fillWorkflow(template, values);
    const t0 = Date.now();
    const submit = await this.client.submit(graph);
    const entry = await this.client.waitForCompletion(submit.prompt_id);
    const durationMs = Date.now() - t0;

    if (entry.status?.status_str !== 'success') {
      logger.error('[local-studio error]', {
        prompt_id: submit.prompt_id,
        status: entry.status?.status_str,
        messages: entry.status?.messages,
      });
      throw new Error(`ComfyUI workflow failed: ${entry.status?.status_str}`);
    }

    // Walk outputs to find the first SaveImage result. Workflows that
    // emit to multiple SaveImage nodes (e.g. consistency v2 that saves
    // both anchor and chained outputs) need a more specific contract;
    // for Phase 1 the t2i workflows have exactly one SaveImage.
    let image: { filename: string; subfolder: string; type: 'output' | 'temp' | 'input' } | null = null;
    for (const nodeOut of Object.values(entry.outputs)) {
      if (nodeOut.images && nodeOut.images.length > 0) {
        image = nodeOut.images[0];
        break;
      }
    }
    if (!image) {
      throw new Error(`ComfyUI prompt ${submit.prompt_id} finished but emitted no images`);
    }

    // Route the image URL through the Next.js proxy at
    // /api/local-studio/image rather than returning the raw
    // localhost:8188 ComfyUI URL. The browser never has to talk to
    // the ComfyUI port directly — works around Chrome extensions /
    // HSTS that block 127.0.0.1, and sets us up for Phase 4 where
    // we'll mirror outputs into project storage from the same route.
    const proxyUrl = `/api/local-studio/image?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`;
    logger.info('[local-studio complete]', {
      prompt_id: submit.prompt_id,
      duration_ms: durationMs,
      output_url: proxyUrl,
      width,
      height,
    });

    return {
      backend: this.backend,
      url: proxyUrl,
      width,
      height,
      seed,
      durationMs,
      meta: { prompt_id: submit.prompt_id, workflow: workflowId },
    };
  }

  async generateClip(
    prompt: string,
    options: GenerateClipOptions,
  ): Promise<GenerationResult> {
    if (!prompt.trim()) {
      throw new Error('prompt is empty');
    }
    if (!options.firstFrameUrl) {
      throw new Error('firstFrameUrl is required for image-to-video');
    }
    const workflowId = (options.workflowId ?? 'wan-2.2-i2v') as LocalVideoWorkflowId;
    if (!isKnownLocalVideoWorkflow(workflowId)) {
      throw new Error(`Unknown local video workflow: ${workflowId}`);
    }
    const template = VIDEO_WORKFLOW_TEMPLATES[workflowId];

    const fullPrompt = options.styleSuffix
      ? `${prompt.trim()}, ${options.styleSuffix.trim()}`
      : prompt.trim();

    const seed = options.seed ?? randomSeed();

    // Wan 2.2 TI2V 5B requires dimensions divisible by 32. Default to
    // 704×416 (16:9-ish) which lands in ~5 min on 16 GB VRAM with 20
    // steps; the previous 1280×720 default landed in ~15 min. Users
    // can pass larger dimensions when they have time to wait.
    const width = Math.max(256, Math.min(1920, Math.round(options.width / 32) * 32));
    const height = Math.max(256, Math.min(1088, Math.round(options.height / 32) * 32));

    // Wan native fps is 16. Length is frame count; quantise to (4k+1)
    // for Wan's 4-frame-aligned latent. Default 2 sec → 33 frames
    // (~2.06 s clip at 16 fps).
    const targetSec = Math.max(2, Math.min(8, options.durationSeconds || 2));
    const rawFrames = Math.round(targetSec * 16);
    const length = Math.round((rawFrames - 1) / 4) * 4 + 1;

    // Sampling steps. 20 is the sweet spot for Wan 5B Q5 at this
    // hardware tier — 30 looks marginally better but ~50% slower.
    // No optional override yet; could be exposed as a UI slider later.
    const steps = 20;

    const values: PlaceholderMap = {
      PROMPT: fullPrompt,
      WIDTH: width,
      HEIGHT: height,
      LENGTH: length,
      STEPS: steps,
      SEED: seed,
      REF_IMAGE: options.firstFrameUrl,
    };

    logger.info('[local-studio submit-clip]', {
      workflow: workflowId,
      width,
      height,
      length,
      steps,
      duration_seconds: length / 16,
      seed,
      first_frame: options.firstFrameUrl,
      prompt_preview: fullPrompt.slice(0, 80),
    });

    const graph = fillWorkflow(template, values);
    const t0 = Date.now();
    const submit = await this.client.submit(graph);
    // Wan 2.2 clips on 5070 Ti at 720p take 3–6 min. Bump the poll
    // timeout to 20 min so a slow first-time JIT compile doesn't bail.
    const entry = await this.client.waitForCompletion(submit.prompt_id, {
      timeoutMs: 20 * 60 * 1000,
    });
    const durationMs = Date.now() - t0;

    if (entry.status?.status_str !== 'success') {
      logger.error('[local-studio clip-error]', {
        prompt_id: submit.prompt_id,
        status: entry.status?.status_str,
        messages: entry.status?.messages,
      });
      throw new Error(`ComfyUI video workflow failed: ${entry.status?.status_str}`);
    }

    // SaveAnimatedWEBP / SaveWEBM emit `images` or `gifs` arrays. Walk
    // both to find the output regardless of which save node the
    // workflow uses.
    let clip: { filename: string; subfolder: string; type: 'output' | 'temp' | 'input' } | null = null;
    for (const nodeOut of Object.values(entry.outputs)) {
      const candidates = nodeOut.images ?? nodeOut.gifs ?? [];
      if (candidates.length > 0) {
        clip = candidates[0];
        break;
      }
    }
    if (!clip) {
      throw new Error(`ComfyUI video prompt ${submit.prompt_id} finished but emitted no clip`);
    }

    const proxyUrl = `/api/local-studio/image?filename=${encodeURIComponent(clip.filename)}&subfolder=${encodeURIComponent(clip.subfolder)}&type=${encodeURIComponent(clip.type)}`;
    logger.info('[local-studio clip-complete]', {
      prompt_id: submit.prompt_id,
      duration_ms: durationMs,
      output_url: proxyUrl,
      width,
      height,
      length,
    });

    return {
      backend: this.backend,
      url: proxyUrl,
      width,
      height,
      seed,
      durationMs,
      meta: {
        prompt_id: submit.prompt_id,
        workflow: workflowId,
        length,
        fps: 16,
        duration_seconds: length / 16,
      },
    };
  }
}
