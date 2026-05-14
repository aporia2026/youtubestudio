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
 * Trigger a "Save As" download for any URL — same-origin or cross-origin.
 *
 * Cross-origin URLs are routed through `/api/download-proxy` so we don't
 * depend on the upstream sending CORS headers. Buffers the response into
 * a Blob so the browser still respects the requested filename even when
 * the upstream's URL has no extension (ElevenLabs / stitched narration).
 *
 * Only safe for small-to-medium files (audio takes, voiceovers). For
 * multi-GB review videos, mint a presigned URL with
 * `response-content-disposition` baked in (see `getDownloadAttachmentUrl`
 * in `r2.ts`) and click that URL directly — bypassing the proxy entirely
 * sidesteps the Vercel function `maxDuration` cap that truncates large
 * streams.
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
