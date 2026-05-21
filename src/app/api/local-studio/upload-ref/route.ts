/**
 * POST /api/local-studio/upload-ref
 *
 * Upload a reference image to ComfyUI's input/ folder so a subsequent
 * /generate call can use it as the starting latent (img2img). Returns
 * the filename ComfyUI assigned to the upload.
 *
 * Proxies multipart form data to ComfyUI's `/upload/image` endpoint
 * rather than handling disk I/O on our side — ComfyUI already has
 * naming + collision logic for the input folder and we don't need to
 * duplicate it.
 *
 * Gated by `LOCAL_STUDIO=1`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { assertLocalhostUrl, DEFAULT_COMFYUI_URL } from '@/lib/comfyui/client';
import { logger } from '@/lib/logger';

export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB ceiling — well above any sane source image
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const POST = apiRoute.public(async (req: NextRequest) => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }
  const file = formData.get('image');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'Expected an `image` file field' },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image too large — maximum ${MAX_BYTES / 1024 / 1024} MB` },
      { status: 413 },
    );
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported type: ${file.type}. Use PNG / JPEG / WEBP.` },
      { status: 415 },
    );
  }

  const comfyBase = assertLocalhostUrl(DEFAULT_COMFYUI_URL);
  const upstream = new FormData();
  upstream.set('image', file, file.name || 'reference');
  // ComfyUI's overwrite flag: "1" overwrites existing same-name file
  // with the new bytes; otherwise it appends `(1)`, `(2)`, etc.
  upstream.set('overwrite', '0');
  upstream.set('type', 'input');

  const res = await fetch(new URL('/upload/image', comfyBase), {
    method: 'POST',
    body: upstream,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error('[local-studio upload-ref] ComfyUI rejected upload', {
      status: res.status,
      detail: detail.slice(0, 300),
    });
    return NextResponse.json(
      { error: `ComfyUI rejected upload (HTTP ${res.status})` },
      { status: 502 },
    );
  }
  const json = (await res.json()) as { name?: string; subfolder?: string; type?: string };
  if (!json.name) {
    return NextResponse.json({ error: 'ComfyUI returned no filename' }, { status: 502 });
  }
  logger.info('[local-studio upload-ref] uploaded', {
    name: json.name,
    subfolder: json.subfolder ?? '',
    size_bytes: file.size,
    mime: file.type,
  });
  return NextResponse.json({
    ok: true,
    filename: json.name,
    subfolder: json.subfolder ?? '',
    // Echo a URL the browser can use to preview the uploaded ref.
    // Routes through our existing image proxy so the browser doesn't
    // need to hit ComfyUI directly.
    previewUrl: `/api/local-studio/image?filename=${encodeURIComponent(json.name)}&subfolder=${encodeURIComponent(json.subfolder ?? '')}&type=input`,
  });
});
