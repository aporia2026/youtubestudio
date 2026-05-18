/**
 * Shared Kie.ai task-creation + polling helpers.
 *
 * Every production-doc image surface (text-to-image generate, image edit,
 * thumbnails) drives the same Kie.ai contract:
 *
 *   1. POST /api/v1/jobs/createTask with { model, input } → { data: { taskId } }
 *   2. GET  /api/v1/jobs/recordInfo?taskId=…              → poll until state
 *      flips to 'success' or 'fail'
 *
 * The 285s ceiling (95 × 3s) sits just under Next's 300s `maxDuration` for
 * these routes and leaves ~15s headroom for the post-poll work each route
 * runs (R2 mirror + saliency compute). Earlier 90s ceilings caused timeout
 * errors while Kie kept running the job — burning credits we never collected
 * a result for.
 */
const KIE_BASE = 'https://api.kie.ai/api/v1/jobs';
const GPT4O_BASE = 'https://api.kie.ai/api/v1/gpt4o-image';

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 95;

/**
 * Strip HTML (Cloudflare gateway pages) from Kie.ai error responses so the
 * client sees something usable instead of a wall of HTML.
 */
export async function kieErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (text.trimStart().startsWith('<') || text.includes('</html>')) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return `Kie.ai is temporarily unavailable (${res.status}) — please try again in a moment`;
    }
    return `Kie.ai returned an unexpected gateway response (HTTP ${res.status})`;
  }
  try {
    const json = JSON.parse(text);
    const msg = (json as Record<string, unknown>)?.error;
    const message = (json as Record<string, unknown>)?.message;
    const errMsg = typeof msg === 'object' && msg !== null
      ? (msg as Record<string, unknown>).message
      : msg;
    const out = errMsg ?? message;
    if (typeof out === 'string') return `Kie.ai: ${out}`;
  } catch { /* not JSON */ }
  return `Kie.ai error ${res.status}: ${text.slice(0, 200)}`;
}

/**
 * Create a job on Kie's standard /jobs/createTask endpoint and return the
 * `taskId` for polling. Retries up to 3× on transient 502/503/504 gateway
 * errors. Surfaces an actionable error when no `taskId` comes back (common
 * cases: 401 insufficient balance, 422 prompt policy reject).
 */
export async function createKieTask(
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
): Promise<string> {
  let createRes!: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
    createRes = await fetch(`${KIE_BASE}/createTask`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input }),
    });
    if (createRes.status !== 502 && createRes.status !== 503 && createRes.status !== 504) break;
  }
  if (!createRes.ok) {
    throw new Error(await kieErrorMessage(createRes));
  }

  let createData: Record<string, unknown>;
  try {
    createData = await createRes.json();
  } catch {
    throw new Error('Kie.ai returned non-JSON response during task creation');
  }

  const taskId = (createData.data as Record<string, unknown>)?.taskId as string | undefined;
  if (!taskId) {
    const code = (createData as Record<string, unknown>).code;
    const message = (createData as Record<string, unknown>).message;
    const detail =
      typeof code !== 'undefined' || typeof message !== 'undefined'
        ? `Kie.ai responded code=${String(code ?? '?')} message=${String(message ?? '(none)')}`
        : `Kie.ai returned an unexpected body: ${JSON.stringify(createData).slice(0, 400)}`;
    throw new Error(`No taskId returned from Kie.ai — ${detail}`);
  }
  return taskId;
}

/**
 * Poll Kie's /jobs/recordInfo until the task hits a terminal state. Returns
 * the first result URL on success. Throws on `fail` or after the ceiling.
 *
 * 429 rate-limit responses are retried without consuming an attempt slot
 * (rare in practice; the 3s gap usually covers any per-IP limit).
 */
export async function pollKieResult(taskId: string, apiKey: string): Promise<string> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const res = await fetch(`${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      if (res.status === 429) continue;
      throw new Error(`Poll failed: ${res.status}`);
    }

    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      // Transient bad response — keep polling
      continue;
    }

    const dataObj = data.data as Record<string, unknown> | undefined;
    const state = dataObj?.state;

    if (state === 'success') {
      let parsed: Record<string, unknown>;
      try {
        parsed = typeof dataObj?.resultJson === 'string'
          ? JSON.parse(dataObj.resultJson as string)
          : (dataObj?.resultJson as Record<string, unknown>);
      } catch {
        throw new Error('Invalid result JSON from Kie.ai');
      }
      const urls = parsed?.resultUrls as string[] | undefined;
      if (!urls?.length) throw new Error('No image URLs in result');
      return urls[0];
    }

    if (state === 'fail') {
      throw new Error((dataObj?.failMsg as string) || 'Image generation failed on Kie.ai');
    }
    // waiting / queuing / generating — keep polling
  }

  throw new Error('Image generation timed out after 285 s — try again');
}

/**
 * GPT-4o image endpoint uses its own create + poll URLs separate from the
 * shared /jobs/* surface. Same polling shape, different paths. Kept in this
 * module so the production-doc edit route doesn't have to invent its own
 * retry / error-mapping logic.
 */
export interface Gpt4oImageInput {
  prompt: string;
  filesUrl: string[];
  maskUrl?: string;
  size: '1:1' | '3:2' | '2:3';
  /** Maps to GPT-4o-image quality tiers. low / medium / high → $0.02 / $0.07 / $0.19. */
  quality?: 'low' | 'medium' | 'high';
  isEnhance?: boolean;
  nVariants?: 1 | 2 | 4;
}

export async function createGpt4oImageTask(
  apiKey: string,
  input: Gpt4oImageInput,
): Promise<string> {
  let res!: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
    res = await fetch(`${GPT4O_BASE}/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
  }
  if (!res.ok) throw new Error(await kieErrorMessage(res));

  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new Error('Kie.ai returned non-JSON response during GPT-4o task creation');
  }
  const taskId = (data.data as Record<string, unknown>)?.taskId as string | undefined;
  if (!taskId) {
    const message = (data as Record<string, unknown>).message;
    throw new Error(`No taskId from Kie.ai gpt4o-image — ${String(message ?? JSON.stringify(data).slice(0, 200))}`);
  }
  return taskId;
}

/**
 * Polls the GPT-4o image task and returns the first generated image URL.
 *
 * Mirrors `pollKieResult` but reads from `${GPT4O_BASE}/record-info`. Kie's
 * GPT-4o result shape returns `response.resultUrls[]` rather than the
 * standard `resultJson.resultUrls[]`, so the parse branch is different.
 */
export async function pollGpt4oImageResult(taskId: string, apiKey: string): Promise<string> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const res = await fetch(`${GPT4O_BASE}/record-info?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      if (res.status === 429) continue;
      throw new Error(`GPT-4o poll failed: ${res.status}`);
    }

    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      continue;
    }
    const dataObj = data.data as Record<string, unknown> | undefined;
    // GPT-4o status field is `status` on the data envelope; values:
    // GENERATING / SUCCESS / GENERATE_FAILED / CREATE_TASK_FAILED.
    const status = (dataObj?.status as string | undefined)?.toUpperCase();

    if (status === 'SUCCESS') {
      const response = dataObj?.response as Record<string, unknown> | undefined;
      const urls = response?.resultUrls as string[] | undefined;
      if (!urls?.length) throw new Error('No image URLs in GPT-4o result');
      return urls[0];
    }
    if (status === 'GENERATE_FAILED' || status === 'CREATE_TASK_FAILED') {
      const err = (dataObj?.errorMessage as string) || 'GPT-4o image task failed';
      throw new Error(err);
    }
    // GENERATING / WAITING — keep polling
  }
  throw new Error('GPT-4o image generation timed out after 285 s — try again');
}
