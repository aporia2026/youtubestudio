/**
 * Resolve a download URL the browser can hit without tripping CORS.
 *
 * Same-origin URLs are returned unchanged. Cross-origin URLs are routed
 * through `/api/download-proxy`, which streams the bytes back with
 * `Content-Disposition: attachment`. Without this hop, two failure modes
 * surface to users:
 *   - `fetch(url)` rejects with "Failed to fetch" when the upstream (R2,
 *     Vercel Blob, AI providers) doesn't send Access-Control-Allow-Origin.
 *   - `<a href={url} download>` is silently ignored cross-origin — the
 *     browser navigates to the file instead of saving it.
 */
export function downloadHref(url: string, name?: string): string {
  if (!url) return url;
  if (typeof window === 'undefined') return url;
  // Root-relative path is same-origin by definition; protocol-relative URLs
  // (`//host/path`) are not, so guard against the second slash.
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.origin === window.location.origin) return parsed.toString();
  } catch {
    return url;
  }
  const params = new URLSearchParams({ u: url });
  if (name) params.set('name', name);
  return `/api/download-proxy?${params.toString()}`;
}

/**
 * Trigger a "Save As" download that lets the browser stream the bytes
 * natively — no JS-side buffering.
 *
 * Cross-origin URLs route through `/api/download-proxy`, which sets
 * `Content-Disposition: attachment; filename="..."` itself, so the browser
 * saves the response as a file and shows its own progress UI in the
 * downloads tray. Same-origin URLs rely on the `<a download>` attribute
 * (which the browser honors same-origin even without Content-Disposition).
 *
 * Use this for large files — videos, full renders — where buffering the
 * whole body into a Blob would keep the UI stuck on "Preparing…" for
 * minutes while the bytes arrive. The trade-off vs. `downloadCrossOriginFile`:
 * this returns immediately and cannot rewrite the filename extension based
 * on a sniffed MIME type, so callers must pass a `name` that already has
 * the correct extension.
 */
export function downloadStreaming(url: string, name: string): void {
  const target = downloadHref(url, name);
  const a = document.createElement('a');
  a.href = target;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Trigger a "Save As" download for any URL — same-origin or cross-origin.
 *
 * Cross-origin URLs are routed through `/api/download-proxy` so we don't
 * depend on the upstream sending CORS headers. Falls back to fetching as a
 * blob so the browser still respects the requested filename even when the
 * upstream's URL has no extension (ElevenLabs / stitched narration).
 *
 * Prefer `downloadStreaming` for large files (videos, renders) — this
 * function buffers the entire response into a Blob in memory before the
 * Save dialog appears, which can look like a multi-minute hang on big
 * payloads.
 */
export async function downloadCrossOriginFile(url: string, name: string): Promise<void> {
  const target = downloadHref(url, name);
  let res: Response;
  try {
    res = await fetch(target);
  } catch {
    throw new Error('Network error — check your connection and try again.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const filename = ensureExtension(name, blob.type);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

const MIME_TO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// ElevenLabs and stitched-narration assets are stored with display names that
// have no extension (e.g. "ElevenLabs - voiceXYZ"). Sniff the blob's MIME and
// append a sensible extension so the OS opens the download in the right app.
function ensureExtension(name: string, mimeType: string): string {
  if (/\.[a-z0-9]+$/i.test(name)) return name;
  const ext = MIME_TO_EXT[mimeType.split(';')[0].trim()] || 'bin';
  return `${name}.${ext}`;
}
