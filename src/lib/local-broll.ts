/**
 * Local b-roll orchestrator — parallel to `startBrollGeneration` /
 * `getAndAdvanceBrollClip` in `broll.ts` but routes through ComfyUI
 * on the user's PC instead of Kie.
 *
 * Phase 4 of `_plans/2026-05-20-comfyui-local-broll.md`. The per-row
 * picker in `BrollCell.tsx` shows `provider === 'comfyui-local'`
 * models alongside Kie models; the /api/broll routes dispatch on
 * provider and call into this module when local is selected.
 *
 * Persistence shape matches Kie's: a `broll_clips` row with
 * `provider='comfyui-local'`, `task_id=<ComfyUI prompt_id>`. The
 * `video_url` is a Next.js proxy URL (`/api/local-studio/image?…`)
 * so the browser never talks to `localhost:8188` directly.
 *
 * Trade-off: the saved clip URL only works while ComfyUI + the
 * `LOCAL_STUDIO=1` Next.js dev server are running. Acceptable for
 * the local-first contract; cloud-persistent mirroring is a future
 * optimisation (would require Vercel Blob writes per clip).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '@vercel/postgres';
import { ComfyUIClient, type ComfyOutputImage } from '@/lib/comfyui/client';
import { uploadUrlToComfyInput } from '@/lib/comfyui/upload';
import { fillWorkflow, randomSeed, type PlaceholderMap } from '@/lib/comfyui/workflow-fill';
import { logger } from '@/lib/logger';
import {
  BROLL_MIN_PROMPT_CHARS,
  type BrollClipRow,
  type BrollStatus,
} from './broll-types';
import { buildBrollPrompt, getBrollClip } from './broll';

/** Per-model local clip dispatch table.
 *
 *  Each entry pairs a `BrollModel.id` (the public id surfaced in
 *  `BROLL_MODELS` / row data) with the ComfyUI workflow + dimensions
 *  + native frame rate it needs. Adding a third local i2v model later
 *  is one line in this table + one new workflow JSON.
 *
 *  Dimensions are tuned to fit a single ComfyUI generation in 16 GB
 *  VRAM at the model's grid requirement (Wan = 32, Hunyuan = 16).
 *  Both produce a WEBM via SaveWEBM so Remotion's renderer can ingest
 *  the clip directly (the original `hunyuan-i2v.json` saves WEBP for
 *  the local-studio preview path; the `-broll` variant swaps that
 *  for WEBM). See `_plans/2026-05-20-comfyui-local-broll.md`. */
interface LocalClipModelConfig {
  workflowFile: string;
  width: number;
  height: number;
  /** Native fps the model is trained at. Determines the frames-per-
   *  second of the saved clip and how `durationSeconds` maps to
   *  `LENGTH` placeholder. */
  fps: number;
  /** Frame-count quantiser. Wan's KSampler tolerates any value; Hunyuan
   *  expects (4k+1) latents. Both work fine for arbitrary integer
   *  frame counts at the workflow level, but staying inside the
   *  expected quantum keeps motion smoothest. */
  frameQuantum: 1 | 4;
  /** KSampler step count tuned for the model on 16 GB VRAM. */
  steps: number;
  /** Tag persisted to `broll_clips.generation_params.local_workflow`
   *  so a future migration / debug query can tell which one produced
   *  a given clip. */
  workflowTag: string;
}

const LOCAL_CLIP_MODELS: Record<string, LocalClipModelConfig> = {
  'wan-2-2-local-i2v': {
    workflowFile: 'wan-2.2-i2v-broll.json',
    width: 704,
    height: 416,
    fps: 16,
    frameQuantum: 4,
    steps: 20,
    workflowTag: 'wan-2.2-i2v-broll',
  },
  'hunyuan-local-i2v': {
    workflowFile: 'hunyuan-i2v-broll.json',
    width: 480,
    height: 272,
    fps: 24,
    frameQuantum: 1,
    steps: 20,
    workflowTag: 'hunyuan-i2v-broll',
  },
};

/** Read every workflow template once at module init — saves a disk hit
 *  per generation and lets us fail fast on missing files. */
const LOCAL_CLIP_TEMPLATES: Record<string, string> = Object.fromEntries(
  Object.entries(LOCAL_CLIP_MODELS).map(([id, cfg]) => [
    id,
    readFileSync(join(process.cwd(), 'src', 'lib', 'comfyui', 'workflows', cfg.workflowFile), 'utf8'),
  ]),
);

export interface StartLocalBrollArgs {
  workspaceId: string;
  projectId: string | null;
  sourceScriptId: string | null;
  rowSignature: string | null;
  rowIndex: number | null;
  productionDocId: string | null;
  visualDescription: string;
  aiImagePrompt?: string;
  styleHint?: string;
  modelId: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSeconds?: number;
  /** https URL of the row's already-generated still — required for
   *  Wan i2v. We fetch the bytes and re-upload to ComfyUI's input/
   *  folder so the LoadImage node can read it by filename. */
  stillImageUrl?: string;
}

/**
 * Submit a local-Wan i2v generation to ComfyUI, persist a
 * `broll_clips` row mirroring the Kie path, return the ids the
 * client polls on.
 */
export async function startLocalBrollGeneration(
  args: StartLocalBrollArgs,
): Promise<{ id: string; prompt: string; status: BrollStatus; task_id: string }> {
  const modelConfig = LOCAL_CLIP_MODELS[args.modelId];
  const template = LOCAL_CLIP_TEMPLATES[args.modelId];
  if (!modelConfig || !template) {
    throw new Error(
      `Unknown local clip model '${args.modelId}'. Known: ${Object.keys(LOCAL_CLIP_MODELS).join(', ')}`,
    );
  }
  if (!args.stillImageUrl) {
    throw new Error(
      "Local i2v animates an existing still — generate the row's image first, then animate it.",
    );
  }
  if (args.aspectRatio !== '16:9') {
    throw new Error(
      `Local i2v only supports 16:9 in v1 (got ${args.aspectRatio}). Use a Kie model for other aspects.`,
    );
  }

  const prompt = buildBrollPrompt({
    visualDescription: args.visualDescription,
    aiImagePrompt: args.aiImagePrompt,
    styleHint: args.styleHint,
    mode: 'image-to-video',
  });
  if (prompt.length < BROLL_MIN_PROMPT_CHARS) {
    throw new Error(
      `Prompt too short (${prompt.length} chars) — need at least ${BROLL_MIN_PROMPT_CHARS}.`,
    );
  }

  const client = new ComfyUIClient();
  if (!(await client.isReachable())) {
    throw new Error(
      'ComfyUI is not reachable on localhost:8188. Start it (scripts/start-comfyui.ps1) and try again.',
    );
  }

  // Pull the row's still down and re-upload into ComfyUI's input/
  // folder so LoadImage can read it by filename. The Kie path doesn't
  // need this because Kie fetches the still URL itself.
  const refFilename = await uploadUrlToComfyInput(args.stillImageUrl, {
    filenamePrefix: 'broll-still',
  });

  const durationSeconds = Math.max(2, Math.min(8, args.durationSeconds ?? 2));
  const rawFrames = Math.round(durationSeconds * modelConfig.fps);
  // Quantise to the model's expected latent grid (Wan = 4k+1, Hunyuan = 1).
  const length = modelConfig.frameQuantum === 4
    ? Math.max(1, Math.round((rawFrames - 1) / 4) * 4 + 1)
    : Math.max(1, rawFrames);
  const { width, height, steps, workflowTag, fps } = modelConfig;
  const seed = randomSeed();

  const values: PlaceholderMap = {
    PROMPT: prompt,
    WIDTH: width,
    HEIGHT: height,
    LENGTH: length,
    STEPS: steps,
    SEED: seed,
    REF_IMAGE: refFilename,
  };
  const graph = fillWorkflow(template, values);

  logger.info('[local-broll submit]', {
    model_id: args.modelId,
    workflow: workflowTag,
    workspace_id: args.workspaceId,
    row_index: args.rowIndex,
    width,
    height,
    length,
    fps,
    steps,
    seed,
    ref_filename: refFilename,
    prompt_preview: prompt.slice(0, 80),
  });

  const submit = await client.submit(graph);

  const generationParams = {
    aspect_ratio: args.aspectRatio,
    duration_seconds: length / fps,
    style_hint: args.styleHint || null,
    source_ai_image_prompt: args.aiImagePrompt || null,
    source_visual_description: args.visualDescription,
    still_image_url: args.stillImageUrl,
    model_kind: 'image-to-video' as const,
    local_workflow: workflowTag,
    local_width: width,
    local_height: height,
    local_length: length,
    local_fps: fps,
    local_steps: steps,
    local_ref_filename: refFilename,
  };

  const { rows } = await sql<{ id: string }>`
    INSERT INTO broll_clips (
      workspace_id, project_id, source_script_id,
      row_signature, row_index, production_doc_id,
      prompt, model_id, provider, aspect_ratio, duration_seconds,
      status, task_id, generation_params
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.projectId}::uuid,
      ${args.sourceScriptId}::uuid,
      ${args.rowSignature ?? null},
      ${args.rowIndex ?? null},
      ${args.productionDocId ?? null},
      ${prompt},
      ${args.modelId},
      ${'comfyui-local'},
      ${args.aspectRatio},
      ${length / fps},
      'generating',
      ${submit.prompt_id},
      ${JSON.stringify(generationParams)}::jsonb
    )
    RETURNING id
  `;
  return {
    id: rows[0]!.id,
    prompt,
    status: 'generating',
    task_id: submit.prompt_id,
  };
}

/**
 * Read a clip row and, if it's still `generating`, ask ComfyUI's
 * /history for its status. Advances the row to `ready` (with
 * `video_url`) or `failed`. Returns the latest row state.
 */
export async function getAndAdvanceLocalBrollClip(
  clipId: string,
  workspaceId: string,
): Promise<BrollClipRow | null> {
  const row = await getBrollClip(clipId, workspaceId);
  if (!row) return null;
  if (row.status !== 'generating') return row;
  if (row.provider !== 'comfyui-local') return row; // wrong dispatch — defensive
  if (!row.task_id) return row;

  const client = new ComfyUIClient();
  let entry;
  try {
    entry = await client.getHistory(row.task_id);
  } catch (err) {
    logger.warn('[local-broll poll] history fetch failed — leaving row generating', {
      clip_id: clipId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
    return row;
  }
  if (!entry || !entry.status?.completed) {
    // Still in flight — surface the same row unchanged.
    return row;
  }

  if (entry.status.status_str === 'success') {
    // Find the SaveWEBM / SaveAnimatedWEBP output.
    let clip: ComfyOutputImage | null = null;
    for (const nodeOut of Object.values(entry.outputs)) {
      const candidates = nodeOut.images ?? nodeOut.gifs ?? [];
      if (candidates.length > 0) {
        clip = candidates[0];
        break;
      }
    }
    if (!clip) {
      logger.error('[local-broll poll] history says success but no output file', {
        clip_id: clipId,
        prompt_id: row.task_id,
      });
      return advanceToFailed(clipId, 'ComfyUI completed but emitted no clip file');
    }
    const proxyUrl = `/api/local-studio/image?filename=${encodeURIComponent(clip.filename)}&subfolder=${encodeURIComponent(clip.subfolder)}&type=${encodeURIComponent(clip.type)}`;
    const { rows: updated } = await sql<BrollClipRow>`
      UPDATE broll_clips
         SET status = 'ready',
             video_url = ${proxyUrl},
             completed_at = NOW(),
             updated_at = NOW()
       WHERE id = ${clipId}::uuid AND workspace_id = ${workspaceId}::uuid
       RETURNING *
    `;
    logger.info('[local-broll poll] ready', {
      clip_id: clipId,
      prompt_id: row.task_id,
      video_url: proxyUrl,
    });
    return updated[0] ?? null;
  }

  // status_str === 'error' or anything else terminal.
  const errMsg =
    typeof entry.status.messages?.[0] === 'string'
      ? (entry.status.messages[0] as string).slice(0, 500)
      : `ComfyUI status: ${entry.status.status_str}`;
  return advanceToFailed(clipId, errMsg);
}

async function advanceToFailed(clipId: string, errorMessage: string): Promise<BrollClipRow | null> {
  const { rows } = await sql<BrollClipRow>`
    UPDATE broll_clips
       SET status = 'failed',
           error_message = ${errorMessage},
           updated_at = NOW()
     WHERE id = ${clipId}::uuid
     RETURNING *
  `;
  return rows[0] ?? null;
}

