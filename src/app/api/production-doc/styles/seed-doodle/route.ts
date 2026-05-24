/**
 * POST /api/production-doc/styles/seed-doodle
 *
 * One-shot, idempotent seeder that turns the built-in "Doodle
 * Explainer" descriptor into an editable v2 saved style with the
 * five curated stick-figure refs already attached. Companion to
 * `scripts/seed-doodle-explainer-style.ts` — same logic, exposed
 * over HTTP so a logged-in user can trigger it from the browser
 * without setting up local DB credentials.
 *
 * Why this endpoint exists:
 *   The built-in Doodle Explainer lives in code (BUILT_IN_STYLES).
 *   It carries a descriptor + mixing rules but cannot have refs —
 *   refs are a DB-only concept on saved styles. The v2 i2i path
 *   (NanoBanana Pro / Flux 2 Pro i2i / Qwen-Image-Edit-2509) only
 *   fires when a saved style with at least one validated ref is the
 *   active style. The 5 PNGs in `public/style-refs/Doodle-explainer/`
 *   were curated for exactly this — but they were sitting in static
 *   assets, unwired to anything, until a user manually rebuilt the
 *   style by hand. This endpoint does the wiring in one POST.
 *
 * Behavior:
 *   - Looks up the built-in by id `doodle_explainer`.
 *   - Idempotent: if a saved style named "Doodle Explainer (refs)"
 *     already exists for the calling workspace, returns that one
 *     instead of creating a duplicate. Pass `?force=1` to bypass
 *     and create a `(2)` / `(3)` copy.
 *   - Default visibility is workspace-wide (`owner_id = NULL`).
 *     Pass `?private=1` to scope the style to the calling user only.
 *   - Reads the 5 PNG files from `public/style-refs/Doodle-explainer/`
 *     server-side, uploads each to R2 under the same key pattern as
 *     user uploads, inserts `style_reference_images` rows with
 *     `content_validated = TRUE` (we trust our own bytes; skip the
 *     post-upload magic-byte round-trip the user-upload path uses).
 *   - Sets `preferred_cloud_model = 'nano-banana-pro-i2i'` — winner
 *     of the Phase 0 blind-rank.
 *
 * Auth: standard apiRoute.authed. The workspace + owner come from
 * the session, never the body — no path here can seed into a
 * workspace the caller doesn't already own.
 *
 * Response:
 *   200 { ok: true, style_id, name, ref_count, action: 'created' | 'reused' }
 *   500 { error: '...' }                — file read / R2 upload / SQL
 *
 * Run from console (after the deploy):
 *   await fetch('/api/production-doc/styles/seed-doodle', {
 *     method: 'POST',
 *   }).then(r => r.json())
 */
import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import {
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';
import { BUILT_IN_STYLES } from '@/lib/production-doc-styles';

// Same ordering as scripts/seed-doodle-explainer-style.ts — position 0
// is the strongest anchor that single-ref models (and the lead image
// for multi-ref models) bias toward.
const REF_FILENAMES = [
  'stick-figure-magnifying-glass-phone.png',
  'stick-figure-hacker-laptop.png',
  'stick-figure-tracked-by-location.png',
  'stick-figure-hacker-deceives-guard.png',
  'stick-figure-soldiers-running.png',
] as const;

const DEFAULT_NAME = 'Doodle Explainer (refs)';
// Updated 2026-05-24: NanoBanana Pro retired in favour of NanoBanana 2
// (Gemini 3.1 Flash, $0.04/image, 14 refs vs Pro's 8). Same field shape.
const DEFAULT_MODEL = 'nano-banana-2-i2i';

interface ExistingStyleProbe {
  id: string;
  ref_count: number;
}

async function findExistingStyle(workspaceId: string, name: string): Promise<ExistingStyleProbe | null> {
  const { rows } = await sql<ExistingStyleProbe>`
    SELECT s.id,
           (SELECT COUNT(*)::int FROM style_reference_images r WHERE r.style_id = s.id) AS ref_count
      FROM production_doc_styles s
     WHERE s.workspace_id = ${workspaceId}::uuid
       AND s.name = ${name}
       AND s.draft = FALSE
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function resolveAvailableName(workspaceId: string, base: string): Promise<string> {
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base} (${n})`;
    const existing = await findExistingStyle(workspaceId, candidate);
    if (!existing) return candidate;
  }
  throw new Error(`Could not find an available name after 99 tries for "${base}"`);
}

function readRefBytes(filename: string): { bytes: Buffer; size: number; mimeType: 'image/png' } {
  // Server-side file read. public/* IS bundled into Vercel deployments
  // (Next.js static-asset convention) and accessible at runtime via
  // process.cwd(). Defensive magic-byte check catches a corrupted
  // deploy artifact before we upload garbage to R2.
  const full = path.join(process.cwd(), 'public', 'style-refs', 'Doodle-explainer', filename);
  if (!fs.existsSync(full)) {
    throw new Error(`Ref file not found on server: ${full}`);
  }
  const bytes = fs.readFileSync(full);
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error(`Server-side file ${filename} is not a valid PNG (magic bytes wrong)`);
  }
  return { bytes, size: bytes.length, mimeType: 'image/png' };
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const isPrivate = url.searchParams.get('private') === '1';
  const ownerId = isPrivate ? session.uid : null;

  // Idempotency.
  const existing = await findExistingStyle(session.ws, DEFAULT_NAME);
  let resolvedName = DEFAULT_NAME;
  if (existing) {
    if (!force) {
      logger.info('[seed-doodle] reusing existing', {
        workspace_id: session.ws,
        style_id: existing.id,
        ref_count: existing.ref_count,
      });
      return NextResponse.json({
        ok: true,
        style_id: existing.id,
        name: DEFAULT_NAME,
        ref_count: existing.ref_count,
        action: 'reused',
      });
    }
    resolvedName = await resolveAvailableName(session.ws, DEFAULT_NAME);
    logger.info('[seed-doodle] forcing duplicate', {
      workspace_id: session.ws,
      resolved_name: resolvedName,
    });
  }

  const builtIn = BUILT_IN_STYLES.find((s) => s.id === 'doodle_explainer');
  if (!builtIn) {
    logger.error('[seed-doodle] built-in missing', {});
    return NextResponse.json({ error: 'Built-in "doodle_explainer" not registered' }, { status: 500 });
  }

  // Create the style row.
  const { rows: styleRows } = await sql<{ id: string }>`
    INSERT INTO production_doc_styles (
      workspace_id, name, description,
      ai_image_suffix, mixing_rules, allow_overlay_stock,
      based_on_built_in, created_by,
      owner_id, draft, approved_at, version,
      style_prompt, preferred_cloud_model
    ) VALUES (
      ${session.ws}::uuid, ${resolvedName}, ${builtIn.description ?? null},
      ${builtIn.ai_image_suffix}, ${builtIn.mixing_rules ?? null}, ${builtIn.allow_overlay_stock},
      ${'doodle_explainer'}, ${session.uid}::uuid,
      ${ownerId}, FALSE, NOW(), 1,
      NULL, ${DEFAULT_MODEL}
    )
    RETURNING id
  `;
  const styleId = styleRows[0]!.id;

  // Upload + ref-row insert for each PNG. Sequential — five files,
  // a couple hundred ms each; not worth the complexity of parallel
  // uploads against R2 for a one-time seed.
  const bucket = getImagesBucket();
  let uploaded = 0;
  const errors: string[] = [];
  for (let position = 0; position < REF_FILENAMES.length; position++) {
    const filename = REF_FILENAMES[position]!;
    try {
      const { bytes, size, mimeType } = readRefBytes(filename);
      const r2Key = `style-refs/${session.ws}/${styleId}/seed-${position}-${filename}`;
      await uploadToBucket(bucket, r2Key, bytes, mimeType);
      await sql`
        INSERT INTO style_reference_images (
          style_id, workspace_id, position,
          r2_bucket, r2_key, mime_type, size_bytes,
          content_validated, content_validated_at
        ) VALUES (
          ${styleId}::uuid, ${session.ws}::uuid, ${position},
          ${bucket}, ${r2Key}, ${mimeType}, ${size},
          TRUE, NOW()
        )
      `;
      uploaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[seed-doodle] ref upload failed', {
        workspace_id: session.ws,
        style_id: styleId,
        position,
        filename,
        detail: msg,
      });
      errors.push(`${filename}: ${msg}`);
    }
  }

  if (uploaded === 0) {
    // Total failure — delete the orphan style row so a retry can run cleanly.
    await sql`DELETE FROM production_doc_styles WHERE id = ${styleId}::uuid`;
    return NextResponse.json(
      { error: 'No refs could be uploaded', detail: errors },
      { status: 500 },
    );
  }

  logger.info('[seed-doodle] done', {
    workspace_id: session.ws,
    style_id: styleId,
    name: resolvedName,
    uploaded,
    errors: errors.length,
  });

  return NextResponse.json({
    ok: true,
    style_id: styleId,
    name: resolvedName,
    ref_count: uploaded,
    action: 'created',
    errors: errors.length > 0 ? errors : undefined,
  });
});
