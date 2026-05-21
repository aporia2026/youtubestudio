/**
 * Fetch a public image URL and upload it into ComfyUI's `input/` folder
 * so a workflow's `LoadImage` node can reference it by filename.
 *
 * Used by every server-side caller that wants to chain an existing image
 * into a local ComfyUI generation: Wan i2v (animates a still), Flux i2i
 * (re-roll from a reference), Phase 7 style-sheet chaining (every shot
 * keys off the doc's master sheet).
 *
 * Posts directly to ComfyUI's `/upload/image` endpoint — we're already
 * server-side so there's no need to round-trip through our own
 * `/api/local-studio/upload-ref` proxy.
 *
 * Throws on:
 *  - Non-http(s) input URL (no `file://`, no SSRF).
 *  - Upstream fetch failure.
 *  - ComfyUI upload rejection.
 *  - Missing filename in the ComfyUI response.
 */
import { assertLocalhostUrl, DEFAULT_COMFYUI_URL } from './client';

/** Image content types we'll forward to ComfyUI. Anything else is a likely
 *  caller bug — bail loudly. */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Default request budget for the source-image fetch. Style sheets and
 *  reference images live in R2; 30 s is a safe ceiling. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface UploadToComfyInputOptions {
  /** Override the default filename prefix used when ComfyUI assigns a name. */
  filenamePrefix?: string;
  /** Override the source-fetch timeout (ms). Default 30_000. */
  fetchTimeoutMs?: number;
}

export async function uploadUrlToComfyInput(
  url: string,
  opts: UploadToComfyInputOptions = {},
): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('uploadUrlToComfyInput: URL must be http(s)');
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  let imgRes: Response;
  try {
    imgRes = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!imgRes.ok) {
    throw new Error(`uploadUrlToComfyInput: source fetch failed (${imgRes.status})`);
  }
  const contentType = (imgRes.headers.get('content-type') ?? 'image/png').toLowerCase();
  if (!ALLOWED_MIME.has(contentType.split(';')[0]!.trim())) {
    throw new Error(`uploadUrlToComfyInput: unsupported content type "${contentType}"`);
  }
  const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
  const buf = Buffer.from(await imgRes.arrayBuffer());

  const prefix = opts.filenamePrefix ?? 'comfy-ref';
  const fd = new FormData();
  fd.set('image', new Blob([buf], { type: contentType }), `${prefix}-${Date.now()}.${ext}`);
  // ComfyUI's overwrite flag: '1' clobbers; '0' appends a uniquifier.
  // We want uniquification — concurrent requests must not stomp each other.
  fd.set('overwrite', '0');
  fd.set('type', 'input');

  const comfyBase = assertLocalhostUrl(DEFAULT_COMFYUI_URL);
  const uploadRes = await fetch(new URL('/upload/image', comfyBase), {
    method: 'POST',
    body: fd,
  });
  if (!uploadRes.ok) {
    throw new Error(`uploadUrlToComfyInput: ComfyUI rejected upload (HTTP ${uploadRes.status})`);
  }
  const json = (await uploadRes.json()) as { name?: string };
  if (!json.name) {
    throw new Error('uploadUrlToComfyInput: ComfyUI response missing filename');
  }
  return json.name;
}
