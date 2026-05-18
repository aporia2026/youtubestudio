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
import { logger } from './logger';
import {
  getDownloadUrlForBucket,
  getReviewBucket,
  uploadToBucket,
} from './r2';
import {
  BROLL_MAX_PROMPT_CHARS,
  BROLL_MIN_PROMPT_CHARS,
  DEFAULT_BROLL_MODEL_ID,
  findBrollModel,
  type BrollClipRow,
  type BrollModelDescriptor,
  type BrollModelKind,
  type BrollStatus,
} from './broll-types';

export type { BrollClipRow } from './broll-types';

const KIE_BASE = 'https://api.kie.ai/api/v1/jobs';
/** Runway has its own endpoint outside the unified `/jobs/createTask` pattern. */
const KIE_RUNWAY_BASE = 'https://api.kie.ai/api/v1/runway';
/** Veo 3.1 lives on a separate endpoint family with its own status-polling
 *  response shape (`successFlag` integer vs the unified `state` string). */
const KIE_VEO_BASE = 'https://api.kie.ai/api/v1/veo';

/** Map a model descriptor's `endpoint` field to the absolute URL used for
 *  task creation. New endpoints are added here so the wire layer stays the
 *  one place that knows about Kie's URL space. */
function resolveCreateTaskUrl(endpoint: BrollModelDescriptor['endpoint']): string {
  if (endpoint === 'runway-generate') return `${KIE_RUNWAY_BASE}/generate`;
  if (endpoint === 'veo-generate') return `${KIE_VEO_BASE}/generate`;
  return `${KIE_BASE}/createTask`;
}

/** Map a model descriptor's `endpoint` field to the absolute URL used for
 *  status polling. Most endpoints share `/jobs/recordInfo`; Veo 3.1 has
 *  its own `/veo/record-info` with a different response shape (handled
 *  by `parseVeoStatus` rather than `parseJobsStatus`). */
function resolveStatusUrl(
  endpoint: BrollModelDescriptor['endpoint'],
  taskId: string,
): string {
  if (endpoint === 'veo-generate') {
    return `${KIE_VEO_BASE}/record-info?taskId=${encodeURIComponent(taskId)}`;
  }
  return `${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`;
}

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
  /** Generation mode. `'text-to-video'` gets the cinematic photoreal tail
   *  that lifts stock-photo-zoom output. `'image-to-video'` SKIPS that
   *  tail — the still defines the look, so we want pure motion guidance
   *  instead. Critical for 2D / doodle / illustrated rows: forcing
   *  "photoreal" on top of a hand-drawn still produces incoherent output. */
  mode: BrollModelKind;
  /** Hard cap (chars). Defaults to BROLL_MAX_PROMPT_CHARS. */
  maxChars?: number;
}

const CINEMATIC_TAIL_T2V =
  'Subtle natural camera movement (slow push-in or parallax). Photoreal, no on-screen text, no logos, no captions, no watermarks.';

const MOTION_TAIL_I2V =
  'Animate the described action with smooth, natural motion. Preserve the existing style and composition. No scene changes, no added text, no logos, no watermarks.';

/**
 * Compose the final prompt sent to the video model. Strategy:
 *   - Prefer `ai_image_prompt` (long + scene-rich) as the spine
 *   - Fall back to `visual_description` if no AI prompt exists
 *   - Append the style suffix
 *   - Append a mode-appropriate tail:
 *       * t2v gets the cinematic / photoreal directive
 *       * i2v gets motion-only guidance (the still already defines the look)
 *   - Truncate to maxChars, preserving the head + the tail
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
  const tail = args.mode === 'image-to-video' ? MOTION_TAIL_I2V : CINEMATIC_TAIL_T2V;

  const parts = [spine, style, tail].filter(Boolean);
  let joined = parts.join('. ').replace(/\.+(\s|$)/g, '. ').trim();

  if (joined.length > max) {
    const reservedTailChars = tail.length + 4;
    const headBudget = Math.max(50, max - reservedTailChars);
    const head = (args.aiImagePrompt?.trim() || args.visualDescription?.trim() || '').slice(0, headBudget).trimEnd();
    joined = `${head}. ${tail}`;
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
  /** Required when `model.kind === 'image-to-video'`. The orchestrator
   *  validates this upstream; the wire layer trusts it. */
  stillImageUrl?: string;
}): Promise<KieCreateResult> {
  const body = args.model.buildBody({
    prompt: args.prompt,
    aspectRatio: args.aspectRatio,
    durationSeconds: args.durationSeconds,
    stillImageUrl: args.stillImageUrl,
  });
  const url = resolveCreateTaskUrl(args.model.endpoint);

  let createRes!: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    createRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
 *  transient infrastructure errors so the caller leaves status='generating'.
 *
 *  Dispatches on `endpoint` because Veo 3.1's status endpoint
 *  (`/api/v1/veo/record-info`) returns a different shape — `successFlag`
 *  integer + `response.fullResultUrls` array — versus the unified
 *  `/api/v1/jobs/recordInfo` shape (`state` string + `resultJson.resultUrls`). */
async function kieFetchVideoStatus(args: {
  apiKey: string;
  taskId: string;
  endpoint: BrollModelDescriptor['endpoint'];
}): Promise<KieStatusResult | null> {
  const url = resolveStatusUrl(args.endpoint, args.taskId);
  const res = await fetch(url, {
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
  return args.endpoint === 'veo-generate' ? parseVeoStatus(data) : parseJobsStatus(data);
}

/** Parse the standard `/api/v1/jobs/recordInfo` response shape used by
 *  Kling, Sora, Runway, Grok, Seedance, and the legacy Veo 3 endpoints. */
function parseJobsStatus(data: Record<string, unknown>): KieStatusResult {
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

/** Parse the `/api/v1/veo/record-info` response shape (Veo 3.1). The
 *  `successFlag` integer encodes status: 0 = generating, 1 = success,
 *  2 = failed, 3 = generation failed. Video URLs land in
 *  `response.fullResultUrls`. */
function parseVeoStatus(data: Record<string, unknown>): KieStatusResult {
  const inner = (data.data as Record<string, unknown> | undefined) ?? {};
  const flag = inner.successFlag;
  let state: KieStatusResult['state'] = 'generating';
  if (flag === 1) state = 'success';
  else if (flag === 2 || flag === 3) state = 'fail';
  const response = (inner.response as Record<string, unknown> | undefined) ?? {};
  const fullUrls = response.fullResultUrls as string[] | undefined;
  // Fall back to `resultUrls` in case Kie ever consolidates the field name.
  const resultUrls = response.resultUrls as string[] | undefined;
  const urls = fullUrls && fullUrls.length > 0 ? fullUrls : resultUrls ?? [];
  const videoUrl = urls.length > 0 ? urls[0] : undefined;
  const errorMessage =
    (inner.errorMessage as string | undefined) || (inner.errorMsg as string | undefined);
  return {
    state,
    videoUrl,
    thumbnailUrl: undefined,
    width: undefined,
    height: undefined,
    failMsg: state === 'fail' ? errorMessage || 'Veo 3.1 generation failed' : undefined,
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
  /** Production-doc history entry id this clip is generated for. NULL
   *  when the doc hasn't been saved yet — those clips remain reachable
   *  via the per-cell localStorage map only. See plan
   *  `_plans/2026-05-17-broll-doc-id-hydration.md`. */
  productionDocId?: string | null;
  visualDescription: string;
  aiImagePrompt?: string;
  styleHint?: string;
  modelId?: string;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  durationSeconds?: number;
  /** Required when the chosen model is `kind: 'image-to-video'` — the URL
   *  of the still the model should animate. Validated here so the route
   *  layer can rely on this orchestrator to enforce the contract. */
  stillImageUrl?: string;
  kieApiKey: string;
}

/**
 * Build the prompt, submit the task to Kie, and persist a `broll_clips` row.
 * Returns the new row id. The row's `status` will be 'generating' on success;
 * the caller should redirect the client to GET /api/broll/[id] for polling.
 *
 * Throws when the model is image-to-video and no `stillImageUrl` was passed —
 * the picker UI gates the button on this, but the server enforces it too so
 * a stale client can't post an i2v generation against a row without a still.
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

  if (model.kind === 'image-to-video' && !args.stillImageUrl) {
    throw new Error(
      `Model ${model.label} animates an existing still — generate the row's image first, then animate it.`,
    );
  }

  const durationSeconds = Math.max(2, Math.min(20, args.durationSeconds ?? model.durationSeconds));

  const prompt = buildBrollPrompt({
    visualDescription: args.visualDescription,
    aiImagePrompt: args.aiImagePrompt,
    styleHint: args.styleHint,
    mode: model.kind,
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
    stillImageUrl: args.stillImageUrl,
  });

  const generationParams = {
    aspect_ratio: aspectRatio,
    duration_seconds: durationSeconds,
    style_hint: args.styleHint || null,
    source_ai_image_prompt: args.aiImagePrompt || null,
    source_visual_description: args.visualDescription,
    still_image_url: args.stillImageUrl ?? null,
    model_kind: model.kind satisfies BrollModelKind,
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

  // Dispatch the status call to the right endpoint family. The clip row
  // stores `model_id`; the model descriptor tells us which Kie URL space
  // (jobs/recordInfo vs veo/record-info) owns this taskId. Unknown
  // models (e.g. a deleted registry entry that still has clips in flight)
  // fall back to the default jobs endpoint.
  const modelForStatus = findBrollModel(row.model_id);
  const statusEndpoint = modelForStatus?.endpoint ?? 'createTask';
  let kieStatus: KieStatusResult | null = null;
  try {
    kieStatus = await kieFetchVideoStatus({
      apiKey: kieApiKey,
      taskId: row.task_id,
      endpoint: statusEndpoint,
    });
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

  // Mirror the Kie-hosted clip to our R2 review bucket so the URL doesn't
  // depend on Kie's CDN retention (their links can rotate or expire). On
  // mirror failure we fall back to the original Kie URL — clip is still
  // playable, just less durable.
  let videoUrl = kieUrl;
  let blobPathname: string | null = null;
  try {
    const fetched = await fetch(kieUrl);
    if (fetched.ok) {
      const contentType = fetched.headers.get('content-type') || 'video/mp4';
      const buffer = await fetched.arrayBuffer();
      const bucket = getReviewBucket();
      const r2Key = `broll/${clipId}.mp4`;
      await uploadToBucket(bucket, r2Key, Buffer.from(buffer), contentType);
      videoUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_PUBLIC_URL);
      blobPathname = r2Key;
    }
  } catch (uploadErr) {
    logger.warn('broll: R2 upload failed, falling back to Kie URL', {
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
      row_signature, row_index, production_doc_id,
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
  opts: {
    projectId?: string;
    scriptId?: string;
    /** Filter to clips tagged with this production-doc history entry id.
     *  Added by migration 0072 to enable cross-device hydration of paid
     *  clips. See plan `_plans/2026-05-17-broll-doc-id-hydration.md`. */
    productionDocId?: string;
    limit?: number;
  } = {},
): Promise<BrollClipRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  // productionDocId takes precedence: it's the production-doc page's
  // mount-hydration query, and we want it filtered down to one doc even
  // when the same workspace has other scripts/projects.
  if (opts.productionDocId) {
    const { rows } = await sql<BrollClipRow>`
      SELECT
        id, workspace_id, project_id, source_script_id,
        row_signature, row_index, production_doc_id,
        prompt, model_id, provider, aspect_ratio, duration_seconds,
        status, task_id, error_message,
        video_url, blob_pathname, thumbnail_url, width, height,
        notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at,
        completed_at::text AS completed_at
      FROM broll_clips
      WHERE workspace_id = ${workspaceId}::uuid
        AND production_doc_id = ${opts.productionDocId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
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
      row_signature, row_index, production_doc_id,
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
