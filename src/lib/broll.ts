/**
 * B-roll pipeline. Per-shot AI-generated video clips for the Production Doc,
 * powered by Sora 2 / Veo 3 via Kie.ai.
 *
 * Generation is asynchronous — Kie's video models take 1-5 minutes to render,
 * which exceeds Vercel's 60-300s function ceiling. The flow is therefore
 * split across two requests:
 *
 *   1. POST /api/broll → submit task to Kie, persist a `broll_clips` row
 *      with status='generating' and the returned `task_id`. Return the row id.
 *   2. GET  /api/broll/[id] → on every read, if the row is still in-flight
 *      we poll Kie ONCE, update status, and return. The client polls this
 *      endpoint every few seconds until status flips to 'ready' or 'failed'.
 *
 * No background workers, no webhooks — the polling is "lazy" (driven by a
 * client tab being open), which keeps the system buildable on Vercel hobby.
 * If the user closes the tab mid-render, the row stays at 'generating' until
 * the next status fetch — Kie keeps results around for ~24h so this is fine.
 *
 * The pure parts (prompt builder, status mapper) are exported for tests so
 * the orchestration logic can be verified without burning Kie credits.
 */
import { sql } from '@vercel/postgres';
import { put } from '@vercel/blob';
import { logger } from './logger';
import {
  BROLL_MAX_PROMPT_CHARS,
  BROLL_MIN_PROMPT_CHARS,
  DEFAULT_BROLL_MODEL_ID,
  findBrollModel,
  type BrollClipRow,
  type BrollModelDescriptor,
  type BrollStatus,
} from './broll-types';

export type { BrollClipRow } from './broll-types';

const KIE_BASE = 'https://api.kie.ai/api/v1/jobs';

// ---------------------------------------------------------------------------
// Pure helpers (prompt builder + status mapper) — exported for tests
// ---------------------------------------------------------------------------

export interface BuildBrollPromptArgs {
  /** The row's editor-facing visual direction (timecode, what should appear). */
  visualDescription: string;
  /** The full scene prompt the production-doc generator wrote for AI image gen.
   *  Most of the time this is the strongest signal — long, scene-rich text.
   *  Optional because some rows (Talking Head, Screen Recording) don't have one. */
  aiImagePrompt?: string;
  /** The style suffix from the production doc's chosen style (cinematic,
   *  doodle, etc.). Appended verbatim — empty string is fine. */
  styleHint?: string;
  /** Hard cap (chars). Defaults to BROLL_MAX_PROMPT_CHARS. */
  maxChars?: number;
}

/**
 * Compose the final prompt sent to the video model. Strategy:
 *   - Prefer `ai_image_prompt` (long + scene-rich) as the spine
 *   - Fall back to `visual_description` if no AI prompt exists
 *   - Append the style suffix
 *   - Add a short cinematic-direction tail (camera movement, no text-on-screen)
 *     because video models default to static + watermarked output otherwise
 *   - Truncate to maxChars, preserving the head + the cinematic tail
 */
export function buildBrollPrompt(args: BuildBrollPromptArgs): string {
  const max = Math.max(200, args.maxChars ?? BROLL_MAX_PROMPT_CHARS);
  const spine = (args.aiImagePrompt?.trim() || args.visualDescription?.trim() || '').replace(
    /\s+/g,
    ' ',
  );
  if (!spine) {
    throw new Error('buildBrollPrompt: row has no visual_description or ai_image_prompt to base the clip on.');
  }
  const style = (args.styleHint ?? '').trim();
  // The cinematic tail is appended verbatim. It's the cheap-but-load-bearing
  // way to lift output quality from "stock-photo zoom" to "shot on camera".
  // Keep it short — it eats from the maxChars budget.
  const cinematicTail =
    'Subtle natural camera movement (slow push-in or parallax). Photoreal, no on-screen text, no logos, no captions, no watermarks.';

  const parts = [spine, style, cinematicTail].filter(Boolean);
  let joined = parts.join('. ').replace(/\.+(\s|$)/g, '. ').trim();

  if (joined.length > max) {
    const reservedTailChars = cinematicTail.length + 4;
    const headBudget = Math.max(50, max - reservedTailChars);
    const head = (args.aiImagePrompt?.trim() || args.visualDescription?.trim() || '').slice(0, headBudget).trimEnd();
    joined = `${head}. ${cinematicTail}`;
  }
  return joined;
}

/** Map Kie's response state into our 4-value enum. Kie reports
 *  `success` / `fail` and a constellation of in-progress states
 *  (`waiting`, `queuing`, `generating`); we collapse the latter
 *  to 'generating' and ignore unknown values (treat as in-flight). */
export function mapKieStateToStatus(state: unknown): BrollStatus {
  if (state === 'success') return 'ready';
  if (state === 'fail') return 'failed';
  return 'generating';
}

// ---------------------------------------------------------------------------
// Kie wire layer
// ---------------------------------------------------------------------------

interface KieCreateResult {
  taskId: string;
}

interface KieStatusResult {
  state: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail' | string;
  videoUrl?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  failMsg?: string;
}

async function kieErrorMsg(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (text.trimStart().startsWith('<') || text.includes('</html>')) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return `Kie.ai is temporarily unavailable (${res.status}) — please try again in a moment`;
    }
    return `Kie.ai returned an unexpected gateway response (HTTP ${res.status})`;
  }
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message || json?.message || json?.error;
    if (typeof msg === 'string') return `Kie.ai: ${msg}`;
  } catch {
    /* not JSON */
  }
  return `Kie.ai error ${res.status}: ${text.slice(0, 200)}`;
}

async function kieCreateVideoTask(args: {
  apiKey: string;
  model: BrollModelDescriptor;
  prompt: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSeconds: number;
}): Promise<KieCreateResult> {
  let createRes!: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    createRes = await fetch(`${KIE_BASE}/createTask`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: args.model.kieModel,
        input: {
          prompt: args.prompt,
          aspect_ratio: args.aspectRatio,
          duration: args.durationSeconds,
        },
      }),
    });
    if (createRes.status !== 502 && createRes.status !== 503 && createRes.status !== 504) break;
  }
  if (!createRes.ok) throw new Error(await kieErrorMsg(createRes));

  let createData: Record<string, unknown>;
  try {
    createData = await createRes.json();
  } catch {
    throw new Error('Kie.ai returned non-JSON response during task creation');
  }
  const taskId = (createData.data as Record<string, unknown> | undefined)?.taskId as string | undefined;
  if (!taskId) throw new Error('No taskId returned from Kie.ai');
  return { taskId };
}

/** Single status read against Kie. Does NOT loop — the lazy polling pattern
 *  has the calling route invoke this once per client poll. Returns null on
 *  transient infrastructure errors so the caller leaves status='generating'. */
async function kieFetchVideoStatus(args: {
  apiKey: string;
  taskId: string;
}): Promise<KieStatusResult | null> {
  const res = await fetch(`${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(args.taskId)}`, {
    headers: { Authorization: `Bearer ${args.apiKey}` },
  });
  if (!res.ok) {
    if (res.status === 429) return null;
    if (res.status >= 500 && res.status < 600) return null;
    throw new Error(`Kie status fetch failed: ${res.status}`);
  }
  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const inner = (data.data as Record<string, unknown> | undefined) ?? {};
  const state = inner.state;
  let parsed: Record<string, unknown> = {};
  if (typeof inner.resultJson === 'string') {
    try {
      parsed = JSON.parse(inner.resultJson) as Record<string, unknown>;
    } catch {
      /* leave parsed empty */
    }
  } else if (inner.resultJson && typeof inner.resultJson === 'object') {
    parsed = inner.resultJson as Record<string, unknown>;
  }
  const urls = (parsed.resultUrls as string[] | undefined) ?? [];
  const videoUrl = urls.length > 0 ? urls[0] : undefined;
  const thumbnailUrl = (parsed.thumbnailUrl as string | undefined) || (parsed.coverUrl as string | undefined);
  const widthRaw = parsed.width;
  const heightRaw = parsed.height;
  return {
    state: typeof state === 'string' ? state : 'generating',
    videoUrl,
    thumbnailUrl,
    width: typeof widthRaw === 'number' ? widthRaw : undefined,
    height: typeof heightRaw === 'number' ? heightRaw : undefined,
    failMsg: typeof inner.failMsg === 'string' ? inner.failMsg : undefined,
  };
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

export interface StartBrollGenerationArgs {
  workspaceId: string;
  projectId: string | null;
  sourceScriptId: string | null;
  rowSignature?: string | null;
  rowIndex?: number | null;
  visualDescription: string;
  aiImagePrompt?: string;
  styleHint?: string;
  modelId?: string;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  durationSeconds?: number;
  kieApiKey: string;
}

/**
 * Build the prompt, submit the task to Kie, and persist a `broll_clips` row.
 * Returns the new row id. The row's `status` will be 'generating' on success;
 * the caller should redirect the client to GET /api/broll/[id] for polling.
 */
export async function startBrollGeneration(
  args: StartBrollGenerationArgs,
): Promise<{ id: string; prompt: string; status: BrollStatus; task_id: string }> {
  const modelId = args.modelId || DEFAULT_BROLL_MODEL_ID;
  const model = findBrollModel(modelId);
  if (!model) throw new Error(`Unknown B-roll model: ${modelId}`);

  const aspectRatio = args.aspectRatio ?? '16:9';
  if (!model.supportedAspects.includes(aspectRatio)) {
    throw new Error(`Model ${model.label} does not support aspect ${aspectRatio}.`);
  }

  const durationSeconds = Math.max(2, Math.min(20, args.durationSeconds ?? model.defaultDurationSeconds));

  const prompt = buildBrollPrompt({
    visualDescription: args.visualDescription,
    aiImagePrompt: args.aiImagePrompt,
    styleHint: args.styleHint,
  });

  if (prompt.length < BROLL_MIN_PROMPT_CHARS) {
    throw new Error(
      `Prompt too short (${prompt.length} chars) — need at least ${BROLL_MIN_PROMPT_CHARS}. Add detail to the row's visual description.`,
    );
  }

  const { taskId } = await kieCreateVideoTask({
    apiKey: args.kieApiKey,
    model,
    prompt,
    aspectRatio,
    durationSeconds,
  });

  const generationParams = {
    aspect_ratio: aspectRatio,
    duration_seconds: durationSeconds,
    style_hint: args.styleHint || null,
    source_ai_image_prompt: args.aiImagePrompt || null,
    source_visual_description: args.visualDescription,
  };

  const { rows } = await sql<{ id: string }>`
    INSERT INTO broll_clips (
      workspace_id, project_id, source_script_id,
      row_signature, row_index,
      prompt, model_id, provider, aspect_ratio, duration_seconds,
      status, task_id, generation_params
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.projectId}::uuid,
      ${args.sourceScriptId}::uuid,
      ${args.rowSignature ?? null},
      ${args.rowIndex ?? null},
      ${prompt},
      ${model.id},
      ${model.provider},
      ${aspectRatio},
      ${durationSeconds},
      'generating',
      ${taskId},
      ${JSON.stringify(generationParams)}::jsonb
    )
    RETURNING id
  `;
  return { id: rows[0]!.id, prompt, status: 'generating', task_id: taskId };
}

/**
 * Read a clip row, and if it's still in-flight, do ONE Kie status check and
 * persist the result. Returns the up-to-date row.
 */
export async function getAndAdvanceBrollClip(
  clipId: string,
  workspaceId: string,
  kieApiKey: string,
): Promise<BrollClipRow | null> {
  const row = await getBrollClip(clipId, workspaceId);
  if (!row) return null;
  if (row.status !== 'generating' && row.status !== 'pending') return row;
  if (!row.task_id) return row;

  let kieStatus: KieStatusResult | null = null;
  try {
    kieStatus = await kieFetchVideoStatus({ apiKey: kieApiKey, taskId: row.task_id });
  } catch (err) {
    logger.warn('broll: Kie status fetch threw, leaving row in-flight', {
      clipId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return row;
  }
  if (!kieStatus) return row;

  const nextStatus = mapKieStateToStatus(kieStatus.state);
  if (nextStatus === 'generating') return row;

  if (nextStatus === 'failed') {
    const errMsg = kieStatus.failMsg || 'Generation failed on Kie.ai';
    await sql`
      UPDATE broll_clips
         SET status = 'failed',
             error_message = ${errMsg},
             updated_at = NOW(),
             completed_at = NOW()
       WHERE id = ${clipId}::uuid AND workspace_id = ${workspaceId}::uuid
    `;
    return getBrollClip(clipId, workspaceId);
  }

  // Ready — re-host in Vercel Blob so the URL never expires.
  const kieUrl = kieStatus.videoUrl;
  if (!kieUrl) {
    await sql`
      UPDATE broll_clips
         SET status = 'failed',
             error_message = 'Kie reported success but returned no video URL',
             updated_at = NOW(),
             completed_at = NOW()
       WHERE id = ${clipId}::uuid AND workspace_id = ${workspaceId}::uuid
    `;
    return getBrollClip(clipId, workspaceId);
  }

  let videoUrl = kieUrl;
  let blobPathname: string | null = null;
  try {
    const fetched = await fetch(kieUrl);
    if (fetched.ok) {
      const contentType = fetched.headers.get('content-type') || 'video/mp4';
      const buffer = await fetched.arrayBuffer();
      const pathname = `broll/${clipId}.mp4`;
      const blob = await put(pathname, buffer, {
        access: 'public',
        contentType,
        allowOverwrite: true,
      });
      videoUrl = blob.url;
      blobPathname = pathname;
    }
  } catch (uploadErr) {
    logger.warn('broll: Vercel Blob upload failed, falling back to Kie URL', {
      clipId,
      detail: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
    });
  }

  await sql`
    UPDATE broll_clips
       SET status = 'ready',
           video_url = ${videoUrl},
           blob_pathname = ${blobPathname},
           thumbnail_url = ${kieStatus.thumbnailUrl ?? null},
           width = ${kieStatus.width ?? null},
           height = ${kieStatus.height ?? null},
           updated_at = NOW(),
           completed_at = NOW()
     WHERE id = ${clipId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return getBrollClip(clipId, workspaceId);
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------
//
// `sql` templates can't safely interpolate a raw column list, so the SELECT
// projection is duplicated across the read functions below. If you add or
// rename a column on `broll_clips`, update every one of them in lock-step.
// ---------------------------------------------------------------------------

export async function getBrollClip(id: string, workspaceId: string): Promise<BrollClipRow | null> {
  const { rows } = await sql<BrollClipRow>`
    SELECT
      id, workspace_id, project_id, source_script_id,
      row_signature, row_index,
      prompt, model_id, provider, aspect_ratio, duration_seconds,
      status, task_id, error_message,
      video_url, blob_pathname, thumbnail_url, width, height,
      notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at,
      completed_at::text AS completed_at
    FROM broll_clips
    WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listBrollForWorkspace(
  workspaceId: string,
  opts: { projectId?: string; scriptId?: string; limit?: number } = {},
): Promise<BrollClipRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.scriptId) {
    const { rows } = await sql<BrollClipRow>`
      SELECT
        id, workspace_id, project_id, source_script_id,
        row_signature, row_index,
        prompt, model_id, provider, aspect_ratio, duration_seconds,
        status, task_id, error_message,
        video_url, blob_pathname, thumbnail_url, width, height,
        notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        completed_at::text AS completed_at
      FROM broll_clips
      WHERE workspace_id = ${workspaceId}::uuid
        AND source_script_id = ${opts.scriptId}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.projectId) {
    const { rows } = await sql<BrollClipRow>`
      SELECT
        id, workspace_id, project_id, source_script_id,
        row_signature, row_index,
        prompt, model_id, provider, aspect_ratio, duration_seconds,
        status, task_id, error_message,
        video_url, blob_pathname, thumbnail_url, width, height,
        notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        completed_at::text AS completed_at
      FROM broll_clips
      WHERE workspace_id = ${workspaceId}::uuid
        AND project_id = ${opts.projectId}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<BrollClipRow>`
    SELECT
      id, workspace_id, project_id, source_script_id,
      row_signature, row_index,
      prompt, model_id, provider, aspect_ratio, duration_seconds,
      status, task_id, error_message,
      video_url, blob_pathname, thumbnail_url, width, height,
      notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at,
      completed_at::text AS completed_at
    FROM broll_clips
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function deleteBrollClip(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM broll_clips
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}
