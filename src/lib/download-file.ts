/**
 * Force a "Save As" download for cross-origin URLs (Vercel Blob, R2, etc.).
 *
 * Why fetch + object URL instead of `<a href={url} download>`: the `download`
 * attribute is ignored cross-origin — the browser navigates to the URL and
 * tries to render it inline instead. Fetching the file lets us hand the
 * browser a same-origin blob URL, which respects the download intent.
 *
 * Requires the source to send `Access-Control-Allow-Origin` headers. Vercel
 * Blob does this by default for `access: 'public'` URLs.
 */
export async function downloadCrossOriginFile(url: string, name: string): Promise<void> {
  const res = await fetch(url);
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
