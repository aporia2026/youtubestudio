import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { sql } from '@/lib/db';
import { isR2Configured, uploadToBucket } from '@/lib/r2';
import { logger } from '@/lib/logger';

/**
 * Copy a voiceover from the user's per-account history into the workspace
 * media library. History entries point at whatever URL the generator
 * returned (a presigned R2 URL, a Vercel Blob, or the ElevenLabs CDN) —
 * none of those satisfy the production-doc alignment gate, which only
 * accepts `/api/voiceovers/<uuid>/audio` (a `media_assets` row served
 * through our proxy).
 *
 * This route fetches the source bytes server-side, re-uploads to the
 * workspace's narration R2 bucket, inserts a `media_assets` row scoped to
 * the caller's project, and returns the row so the client can immediately
 * select it and trigger forced-alignment.
 *
 * Security:
 *   - SSRF guard: only allowlisted hosts (our R2 + Vercel Blob + the
 *     ElevenLabs CDN) and same-origin paths are accepted. Localhost,
 *     RFC1918, and the AWS metadata endpoint are explicitly rejected.
 *   - 30s fetch timeout; 50 MB max body; non-audio Content-Types
 *     fall back to `audio/mpeg` after a whitelist check.
 *   - Workspace check: the caller's `session.ws` must match the target
 *     project's workspace before any R2 write happens.
 */

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const ALLOWED_AUDIO = [
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
];

/**
 * Resolve the URL into a `{ kind, parsed }` discriminator so the fetch
 * branch can stay simple. Returns `null` when the URL is malformed or
 * points at a disallowed host — caller should reject the request with 400.
 */
function classifySourceUrl(audioUrl: string, requestUrl: string):
  | { kind: 'same-origin'; absolute: string }
  | { kind: 'remote'; absolute: string; host: string }
  | null {
  // Same-origin path. The audio proxy can serve these but needs the
  // caller's cookies forwarded for auth. We resolve against the request
  // URL so a relative path like `/api/voiceovers/<id>/audio` reaches
  // the right host.
  if (audioUrl.startsWith('/')) {
    try {
      return { kind: 'same-origin', absolute: new URL(audioUrl, requestUrl).toString() };
    } catch {
      return null;
    }
  }

  let u: URL;
  try {
    u = new URL(audioUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.host.toLowerCase();

  // Defence-in-depth: explicit reject for loopback / link-local / AWS
  // metadata. Any allowlist match below this gate still has to pass it.
  if (
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host === '0.0.0.0' ||
    host === '169.254.169.254'
  ) {
    return null;
  }

  const allowed =
    host.endsWith('.r2.cloudflarestorage.com') ||
    host.endsWith('.blob.vercel-storage.com') ||
    host === 'api.elevenlabs.io' ||
    host === 'elevenlabs.io' ||
    host.endsWith('.elevenlabs.io');

  if (!allowed) return null;
  return { kind: 'remote', absolute: u.toString(), host };
}

export const POST = apiRoute.authed(async (session, req) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  let body: {
    projectId?: string;
    historyId?: string;
    audioUrl?: string;
    voiceName?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const projectId = String(body.projectId ?? '').trim();
  const audioUrl = String(body.audioUrl ?? '').trim();
  const voiceName = String(body.voiceName ?? '').trim().slice(0, 200) || 'Voiceover';
  const historyId = body.historyId ? String(body.historyId).slice(0, 200) : null;

  if (!projectId || !audioUrl) {
    return NextResponse.json({ error: 'projectId and audioUrl required' }, { status: 400 });
  }

  const classified = classifySourceUrl(audioUrl, req.url);
  if (!classified) {
    return NextResponse.json(
      {
        error:
          'Source URL host is not on the allow-list. Upload the audio from your computer instead.',
      },
      { status: 400 },
    );
  }

  // Workspace ownership: don't leak existence to a member of a different
  // workspace — same 404 either way.
  const projCheck = await sql<{ workspace_id: string }>`
    SELECT workspace_id FROM projects WHERE id = ${projectId}::uuid
  `;
  if (projCheck.rows.length === 0 || projCheck.rows[0].workspace_id !== session.ws) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Fetch the source audio. AbortController cuts off a stuck CDN before
  // the Vercel function timeout chews up the user's pageload.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let audioRes: Response;
  try {
    audioRes = await fetch(classified.absolute, {
      signal: controller.signal,
      redirect: 'follow',
      headers:
        classified.kind === 'same-origin'
          ? { cookie: req.headers.get('cookie') ?? '' }
          : undefined,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : 'Source fetch failed';
    logger.warn('voiceovers: save-from-history fetch failed', { detail: msg });
    return NextResponse.json({ error: `Source fetch failed: ${msg}` }, { status: 502 });
  }
  clearTimeout(timer);

  if (!audioRes.ok) {
    return NextResponse.json(
      { error: `Source fetch returned ${audioRes.status}` },
      { status: 502 },
    );
  }

  const lenHeader = audioRes.headers.get('content-length');
  if (lenHeader && Number.parseInt(lenHeader, 10) > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: 'Source audio exceeds 50 MB limit' }, { status: 413 });
  }

  // Read body with explicit cap. arrayBuffer() doesn't stream, so we
  // rely on the Content-Length guard plus a post-read length check.
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: 'Source audio exceeds 50 MB limit' }, { status: 413 });
  }
  if (buffer.byteLength === 0) {
    return NextResponse.json({ error: 'Source audio is empty' }, { status: 502 });
  }

  const sourceContentType = (audioRes.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const contentType = ALLOWED_AUDIO.includes(sourceContentType) ? sourceContentType : 'audio/mpeg';

  // Upload to the workspace's narration bucket. Same key namespace
  // (`voiceovers/<projectId>/...`) the upload-presign route uses so
  // operational cleanup tools treat these uniformly.
  const bucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';
  const safeVoiceName = voiceName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'voiceover';
  const r2Key = `voiceovers/${projectId}/${Date.now()}-${safeVoiceName}.mp3`;
  try {
    await uploadToBucket(bucket, r2Key, buffer, contentType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'R2 upload failed';
    logger.error('voiceovers: save-from-history R2 upload failed', { detail: msg });
    return NextResponse.json({ error: `R2 upload failed: ${msg}` }, { status: 502 });
  }

  // Insert media_assets row. workspace_id inherits from the parent project
  // — same pattern the /api/projects/[id]/media POST uses.
  const insertResult = await sql<{ id: string }>`
    INSERT INTO media_assets (
      project_id, type, source, name, url,
      r2_bucket, r2_key, size_bytes, metadata, workspace_id
    )
    SELECT ${projectId}::uuid, 'voiceover', 'upload', ${`${voiceName} (saved from history)`},
           ${''},
           ${bucket}, ${r2Key}, ${buffer.byteLength},
           ${JSON.stringify({
             saved_from_history: true,
             history_id: historyId,
             source_host: classified.kind === 'remote' ? classified.host : 'same-origin',
           })}::jsonb,
           p.workspace_id
      FROM projects p WHERE p.id = ${projectId}::uuid
    RETURNING id
  `;
  const newId = insertResult.rows[0]?.id;
  if (!newId) {
    return NextResponse.json({ error: 'Insert failed' }, { status: 500 });
  }

  // Canonical URL is the same-origin proxy, which is what the alignment
  // gate looks for. Stamp it on the row so the picker shows the right URL
  // when it next loads via /api/voiceovers/library.
  const proxyUrl = `/api/voiceovers/${newId}/audio`;
  await sql`UPDATE media_assets SET url = ${proxyUrl} WHERE id = ${newId}::uuid`;
  await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${projectId}::uuid`;

  logger.info('voiceovers: saved from history', {
    mediaAssetId: newId,
    projectId,
    historyId,
    sizeBytes: buffer.byteLength,
    sourceHost: classified.kind === 'remote' ? classified.host : 'same-origin',
  });

  return NextResponse.json({
    asset: {
      id: newId,
      url: proxyUrl,
      r2_bucket: bucket,
      r2_key: r2Key,
      size_bytes: buffer.byteLength,
    },
  });
});
