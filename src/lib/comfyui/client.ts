/**
 * Typed wrapper over the local ComfyUI HTTP API.
 *
 * ComfyUI exposes:
 *   POST /prompt                   queue a workflow, returns { prompt_id }
 *   GET  /history/{prompt_id}      fetch outputs once the prompt has finished
 *   GET  /view?filename=&subfolder=&type=  download an output image/video
 *   GET  /queue                    inspect the running + pending queue
 *   GET  /system_stats             GPU + VRAM + version info
 *
 * Used by the local-studio surface (gated by `LOCAL_STUDIO=1`). All calls
 * target `localhost:8188` by default — defense in depth, the URL is also
 * validated by `assertLocalhostUrl` so a misconfigured env can't point us
 * at an external host.
 *
 * Phase 1 uses polling instead of WebSocket. WebSocket progress streaming
 * lands in a later phase — the API contract on /history is enough to ship
 * a working single-image generator.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';

/** Default ComfyUI base URL. Overridable via `local_studio.comfyui_url`
 *  user setting (validated to localhost) — passed in as a constructor arg
 *  rather than read from env so the caller controls the source of truth. */
export const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

/** Hostnames we accept. Any URL not in this set is rejected before we
 *  make any network call — the local-studio feature is local-only by
 *  contract, so a tunnelled / remote URL is a configuration bug. */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Validate that a ComfyUI URL is localhost. Throws on anything else.
 *  Centralised so every call site enforces the same rule. */
export function assertLocalhostUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ComfyUI URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`ComfyUI URL must be http(s), got ${parsed.protocol}`);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `ComfyUI URL must be localhost (127.0.0.1 / localhost / ::1), got ${parsed.hostname}`,
    );
  }
  return parsed;
}

/** Shape of one image output reported by /history. */
export interface ComfyOutputImage {
  filename: string;
  subfolder: string;
  type: 'output' | 'temp' | 'input';
}

/** Per-node outputs as returned by /history. Most nodes report nothing;
 *  SaveImage / SaveAnimatedWEBP / SaveWEBM report an `images` array. */
export interface ComfyNodeOutputs {
  images?: ComfyOutputImage[];
  gifs?: ComfyOutputImage[];
}

/** Status block from /history. `completed` flips true when the workflow
 *  is fully drained. `status_str` is one of `success` / `error`. */
export interface ComfyHistoryStatus {
  status_str: 'success' | 'error' | string;
  completed: boolean;
  messages?: unknown[];
}

export interface ComfyHistoryEntry {
  prompt: unknown;
  outputs: Record<string, ComfyNodeOutputs>;
  status?: ComfyHistoryStatus;
}

/** ComfyUI's /prompt endpoint accepts an API-format workflow graph keyed
 *  by node id. Each node has a `class_type` (the ComfyUI node name) and
 *  an `inputs` map. Connections are encoded as `[upstream_node_id, slot]`
 *  tuples in the inputs map. */
export type ComfyWorkflowGraph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

/** Normalised queue row for UI display. */
export interface QueueItemSummary {
  promptId: string;
  clientId: string | null;
  /** Model file referenced by UnetLoaderGGUF / CheckpointLoaderSimple, if any. */
  model: string | null;
  /** First non-empty positive prompt found in any CLIPTextEncode node. */
  prompt: string | null;
  /** "image" for SaveImage-terminated workflows, "clip" for video saves. */
  kind: 'image' | 'clip' | 'unknown';
}

/** Pull model + prompt + kind out of a queue row's workflow graph.
 *  Robust against partial / unexpected graphs — returns nulls rather
 *  than throwing. */
function extractQueueItem(row: unknown[]): QueueItemSummary {
  // Wire format: [priority, prompt_id, graph_obj, extra_data, outputs_list]
  const promptId = typeof row[1] === 'string' ? row[1] : '';
  const graph = (row[2] as Record<string, unknown>) ?? {};
  const extra = row[3] as Record<string, unknown> | undefined;
  const clientId = extra && typeof extra.client_id === 'string' ? extra.client_id : null;

  let model: string | null = null;
  let prompt: string | null = null;
  let kind: 'image' | 'clip' | 'unknown' = 'unknown';

  for (const node of Object.values(graph)) {
    if (!node || typeof node !== 'object') continue;
    const n = node as { class_type?: string; inputs?: Record<string, unknown> };
    const cls = n.class_type;
    const inputs = n.inputs ?? {};
    if (!model) {
      if (cls === 'UnetLoaderGGUF' && typeof inputs.unet_name === 'string') {
        model = inputs.unet_name;
      } else if (cls === 'CheckpointLoaderSimple' && typeof inputs.ckpt_name === 'string') {
        model = inputs.ckpt_name;
      } else if (cls === 'UNETLoader' && typeof inputs.unet_name === 'string') {
        model = inputs.unet_name;
      }
    }
    if (!prompt && cls === 'CLIPTextEncode' && typeof inputs.text === 'string') {
      const t = inputs.text.trim();
      // Skip the negative prompt — heuristic: ignore CLIPTextEncode nodes
      // whose text is empty or starts with typical negative-prompt phrases.
      if (t && !/^(blurry|low quality|distorted|watermark|deformed|static, no motion|ugly)/i.test(t)) {
        prompt = t;
      }
    }
    if (kind === 'unknown') {
      if (cls === 'SaveImage') kind = 'image';
      else if (cls === 'SaveAnimatedWEBP' || cls === 'SaveWEBM') kind = 'clip';
    }
  }
  return { promptId, clientId, model, prompt, kind };
}

/** Returned by `submit()`. `prompt_id` is the handle for polling. */
export interface ComfySubmitResult {
  prompt_id: string;
  number: number;
  node_errors?: Record<string, unknown>;
}

export class ComfyUIClient {
  private readonly base: URL;
  /** Stable client id sent with every /prompt — lets us correlate runs in
   *  ComfyUI's logs and is required for future WebSocket subscription. */
  private readonly clientId: string;

  constructor(opts: { url?: string; clientId?: string } = {}) {
    const url = opts.url ?? DEFAULT_COMFYUI_URL;
    this.base = assertLocalhostUrl(url);
    this.clientId = opts.clientId ?? randomUUID();
  }

  /** Returns true if ComfyUI is reachable and serving on the configured URL. */
  async isReachable(): Promise<boolean> {
    try {
      const res = await fetch(new URL('/system_stats', this.base), {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Queue a workflow for execution. Returns the prompt_id used for polling.
   *  Throws on network failure, non-2xx, or non-empty node_errors. */
  async submit(graph: ComfyWorkflowGraph): Promise<ComfySubmitResult> {
    const body = JSON.stringify({ prompt: graph, client_id: this.clientId });
    const res = await fetch(new URL('/prompt', this.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error('[local-studio submit] ComfyUI rejected workflow', {
        status: res.status,
        detail: detail.slice(0, 300),
      });
      throw new Error(`ComfyUI /prompt returned ${res.status}: ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as ComfySubmitResult;
    if (!json.prompt_id) {
      throw new Error('ComfyUI /prompt response missing prompt_id');
    }
    if (json.node_errors && Object.keys(json.node_errors).length > 0) {
      logger.error('[local-studio submit] node validation errors', {
        prompt_id: json.prompt_id,
        node_errors: json.node_errors,
      });
      throw new Error(
        `ComfyUI rejected nodes: ${JSON.stringify(json.node_errors).slice(0, 300)}`,
      );
    }
    logger.info('[local-studio submit] queued', {
      prompt_id: json.prompt_id,
      queue_position: json.number,
      client_id: this.clientId,
    });
    return json;
  }

  /** Fetch /history for a prompt id. Returns null until the prompt has
   *  started executing; returns the entry once finished. ComfyUI only
   *  populates /history when a workflow is done — pending prompts return {}. */
  async getHistory(promptId: string): Promise<ComfyHistoryEntry | null> {
    const res = await fetch(new URL(`/history/${promptId}`, this.base));
    if (!res.ok) {
      throw new Error(`ComfyUI /history returned ${res.status}`);
    }
    const json = (await res.json()) as Record<string, ComfyHistoryEntry>;
    return json[promptId] ?? null;
  }

  /** Interrupt the currently-running prompt. ComfyUI processes one
   *  prompt at a time, so a global interrupt is the right granularity —
   *  there's no per-prompt cancel beyond clearing the queue. Returns
   *  true if ComfyUI accepted the interrupt. */
  async interrupt(): Promise<boolean> {
    const res = await fetch(new URL('/interrupt', this.base), { method: 'POST' });
    if (res.ok) {
      logger.info('[local-studio cancel] interrupt sent', { client_id: this.clientId });
    } else {
      logger.warn('[local-studio cancel] interrupt failed', { status: res.status });
    }
    return res.ok;
  }

  /** Clear the pending queue. Doesn't stop the currently running prompt —
   *  call `interrupt()` for that. Used in tandem when the user clicks
   *  Stop and there were queued generations behind it. */
  async clearQueue(): Promise<boolean> {
    const res = await fetch(new URL('/queue', this.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    return res.ok;
  }

  /** Inspect the running + pending queue. Useful for surfacing queue
   *  position while a prompt is waiting. */
  async getQueue(): Promise<{
    queue_running: Array<unknown[]>;
    queue_pending: Array<unknown[]>;
  }> {
    const res = await fetch(new URL('/queue', this.base));
    if (!res.ok) {
      throw new Error(`ComfyUI /queue returned ${res.status}`);
    }
    return (await res.json()) as {
      queue_running: Array<unknown[]>;
      queue_pending: Array<unknown[]>;
    };
  }

  /** Higher-level queue summary used by the UI's queue panel.
   *
   *  ComfyUI's raw /queue payload is a wire-format array per prompt
   *  (`[priority, promptId, graph, extra, outputs]`). This normalises
   *  it AND inspects each prompt's graph to surface the model and
   *  positive prompt so the panel can show meaningful labels rather
   *  than opaque prompt_ids. Kind (image / clip) is inferred from the
   *  workflow's save node (SaveImage → image, SaveAnimatedWEBP /
   *  SaveWEBM → clip). */
  async getQueueSummary(): Promise<{
    running: Array<QueueItemSummary>;
    pending: Array<QueueItemSummary>;
  }> {
    const q = await this.getQueue();
    return {
      running: q.queue_running.map(extractQueueItem).filter(r => r.promptId),
      pending: q.queue_pending.map(extractQueueItem).filter(r => r.promptId),
    };
  }

  /** Cancel a specific queued prompt. For PENDING prompts ComfyUI's
   *  `POST /queue { delete: [id] }` removes the entry cleanly. For the
   *  RUNNING prompt there's no per-id cancel — only the global
   *  `/interrupt` — so callers pass `isRunning: true` to do both. */
  async cancelPrompt(promptId: string, opts: { isRunning?: boolean } = {}): Promise<boolean> {
    if (opts.isRunning) {
      const res = await fetch(new URL('/interrupt', this.base), { method: 'POST' });
      return res.ok;
    }
    const res = await fetch(new URL('/queue', this.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
    return res.ok;
  }

  /** Build a /view URL for an output image. Returned URL points at the
   *  local ComfyUI server — the API route fetches it and re-streams to
   *  the browser so the UI doesn't talk to the ComfyUI port directly. */
  viewUrl(image: ComfyOutputImage): string {
    const url = new URL('/view', this.base);
    url.searchParams.set('filename', image.filename);
    url.searchParams.set('subfolder', image.subfolder);
    url.searchParams.set('type', image.type);
    return url.toString();
  }

  /** Fetch the raw bytes of an output image. Throws on non-2xx. */
  async fetchOutputBytes(image: ComfyOutputImage): Promise<{
    bytes: ArrayBuffer;
    contentType: string;
  }> {
    const res = await fetch(this.viewUrl(image));
    if (!res.ok) {
      throw new Error(`ComfyUI /view returned ${res.status} for ${image.filename}`);
    }
    return {
      bytes: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /** Poll /history until the prompt completes or times out. Returns the
   *  finished entry. Phase 1 helper — later phases switch to WebSocket
   *  for live progress streaming. */
  async waitForCompletion(
    promptId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<ComfyHistoryEntry> {
    const intervalMs = opts.intervalMs ?? 1000;
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const t0 = Date.now();
    let lastLog = 0;
    while (true) {
      const entry = await this.getHistory(promptId);
      if (entry && entry.status?.completed) {
        logger.info('[local-studio poll] completed', {
          prompt_id: promptId,
          duration_ms: Date.now() - t0,
          status: entry.status.status_str,
        });
        return entry;
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`ComfyUI prompt ${promptId} timed out after ${timeoutMs}ms`);
      }
      // Throttle log lines to once every ~10s so a long generation doesn't
      // spam the console — values not events (rule 14).
      if (Date.now() - lastLog > 10_000) {
        logger.info('[local-studio poll] still running', {
          prompt_id: promptId,
          elapsed_ms: Date.now() - t0,
        });
        lastLog = Date.now();
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  /** The client id passed on /prompt. Exposed for future WebSocket use. */
  getClientId(): string {
    return this.clientId;
  }
}
