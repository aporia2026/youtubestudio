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
import { fillWorkflow, randomSeed, type PlaceholderMap } from '@/lib/comfyui/workflow-fill';
import { logger } from '@/lib/logger';
import {
  BROLL_MIN_PROMPT_CHARS,
  type BrollClipRow,
  type BrollStatus,
} from './broll-types';
import { buildBrollPrompt, getBrollClip } from './broll';

const WORKFLOW_PATH = join(
  process.cwd(),
  'src',
  'lib',
  'comfyui',
  'workflows',
  'wan-2.2-i2v-broll.json',
);

// Loaded once at module init. Tied to the Wan i2v workflow; if Phase 4
// adds more local clip models we'd key this by model id.
const WAN_BROLL_TEMPLATE = readFileSync(WORKFLOW_PATH, 'utf8');

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
  if (!args.stillImageUrl) {
    throw new Error(
      'Local Wan animates an existing still — generate the row\'s image first, then animate it.',
    );
  }
  if (args.aspectRatio !== '16:9') {
    throw new Error('Local Wan only supports 16:9 in v1. Use a Kie model for other aspects.');
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
      'ComfyUI is not reachable on localhost:8188. Start it (run_nvidia_gpu.bat) and try again.',
    );
  }

  // Pull the row's still down and re-upload into ComfyUI's input/
  // folder so LoadImage can read it by filename. The Kie path doesn't
  // need this because Kie fetches the still URL itself.
  const refFilename = await fetchToComfyInput(args.stillImageUrl);

  const durationSeconds = Math.max(2, Math.min(8, args.durationSeconds ?? 2));
  // Wan native fps is 16. Length = frame count quantised to (4k+1).
  const rawFrames = Math.round(durationSeconds * 16);
  const length = Math.round((rawFrames - 1) / 4) * 4 + 1;
  // 16:9 dimensions tuned for 16 GB VRAM. Multiples of 32 required by Wan.
  const width = 704;
  const height = 416;
  const steps = 20;
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
  const graph = fillWorkflow(WAN_BROLL_TEMPLATE, values);

  logger.info('[local-broll submit]', {
    model_id: args.modelId,
    workspace_id: args.workspaceId,
    row_index: args.rowIndex,
    width,
    height,
    length,
    steps,
    seed,
    ref_filename: refFilename,
    prompt_preview: prompt.slice(0, 80),
  });

  const submit = await client.submit(graph);

  const generationParams = {
    aspect_ratio: args.aspectRatio,
    duration_seconds: length / 16,
    style_hint: args.styleHint || null,
    source_ai_image_prompt: args.aiImagePrompt || null,
    source_visual_description: args.visualDescription,
    still_image_url: args.stillImageUrl,
    model_kind: 'image-to-video' as const,
    local_workflow: 'wan-2.2-i2v-broll',
    local_width: width,
    local_height: height,
    local_length: length,
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
      ${length / 16},
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

/**
 * Fetch a still-image URL and upload it into ComfyUI's `input/`
 * folder so the LoadImage node can reference it by filename.
 * Returns the filename ComfyUI assigned.
 *
 * Hits ComfyUI's `/upload/image` endpoint directly because we're
 * already on the server side — no need to round-trip through our
 * own /api/local-studio/upload-ref proxy.
 */
async function fetchToComfyInput(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('stillImageUrl must be an http(s) URL');
  }
  const imgRes = await fetch(url);
  if (!imgRes.ok) {
    throw new Error(`Failed to fetch still image (${imgRes.status})`);
  }
  const contentType = imgRes.headers.get('content-type') ?? 'image/png';
  const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
  const buf = Buffer.from(await imgRes.arrayBuffer());

  const fd = new FormData();
  fd.set('image', new Blob([buf], { type: contentType }), `broll-still-${Date.now()}.${ext}`);
  fd.set('overwrite', '0');
  fd.set('type', 'input');
  const uploadRes = await fetch('http://127.0.0.1:8188/upload/image', {
    method: 'POST',
    body: fd,
  });
  if (!uploadRes.ok) {
    throw new Error(`ComfyUI upload failed (${uploadRes.status})`);
  }
  const json = (await uploadRes.json()) as { name?: string };
  if (!json.name) {
    throw new Error('ComfyUI upload response missing filename');
  }
  return json.name;
}
