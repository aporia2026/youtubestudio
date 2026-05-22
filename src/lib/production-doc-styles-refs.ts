/**
 * Reference-image side of the v2 user-defined style system.
 *
 * Companion to `production-doc-styles.ts`. Kept in a separate file so
 * the legacy style-resolution code (which a lot of unrelated routes
 * import) doesn't pull in R2 + storage helpers it doesn't need.
 *
 * Capabilities exposed here:
 *
 *   - loadStyleReferences         list refs for a style, optionally
 *                                 excluding ones the provider rejected
 *                                 and/or ids in an explicit exclude set
 *                                 (used by "Regenerate without rejected
 *                                 refs"). Hot path — called on every
 *                                 ref-bearing image generation.
 *
 *   - addStyleReference           insert a row after a presigned R2
 *                                 PUT has completed. Enforces the
 *                                 8-ref cap server-side so a misbehaving
 *                                 client can't grow the set past the
 *                                 worst Kie provider's max (Flux 2 Pro
 *                                 caps at 8; NanoBanana also at 8).
 *
 *   - deleteStyleReference        remove a row. Caller is responsible
 *                                 for the R2 cleanup (route layer has
 *                                 the bucket+key handy and can fan out
 *                                 to `deleteImagesObject`).
 *
 *   - markReferenceRejected       called from the image-gen dispatcher
 *                                 when Kie returns content_refusal on
 *                                 a known ref index. Sets the
 *                                 rejected_by_provider flag so the next
 *                                 generation under this style skips
 *                                 that ref by default.
 *
 *   - clearReferenceRejection     editor "Clear rejection" affordance.
 *                                 Resets the flag so the ref is back
 *                                 in play (user may believe the prior
 *                                 refusal was a false positive).
 *
 * The corresponding API routes live under
 * `/api/production-doc/styles/[id]/refs/*` (Phase 2).
 */
import { sql } from '@vercel/postgres';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getBuiltInStyle } from './production-doc-styles';

/** v3 (2026-05-22): Synthesize a StyleReferenceImage[] for a built-in
 *  style that ships with `built_in_refs`. No DB rows, no R2 — refs
 *  resolve to public/ assets served at `/style-refs/<style-id>/...`.
 *  The dispatcher reads `public_url` on each row instead of minting
 *  a presigned R2 URL.
 *
 *  Returns absolute URLs when the env exposes a base ("https://app").
 *  Falls back to a path-relative URL when no base is configured — fine
 *  for the StyleManagerDialog's <img> tags but not for Kie (which
 *  needs an absolute URL its servers can fetch). The image dispatcher
 *  handles the absolute-resolve at call time.
 */
function getPublicBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.NEXT_PUBLIC_VERCEL_URL && `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`) ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    ''
  );
}

function synthesizeBuiltInRefs(styleId: string): StyleReferenceImage[] {
  const builtIn = getBuiltInStyle(styleId);
  if (!builtIn?.built_in_refs?.length) return [];
  // The directory under public/ uses the friendly capitalized name —
  // e.g. `Doodle-explainer` for id `doodle_explainer`. We hardcode the
  // mapping at the built-in registration site rather than munging the
  // id here so a future built-in with refs in a non-conventional
  // subdirectory still works. For now there's one (Doodle Explainer),
  // and its dir matches the convention id → Hyphen-Case-Path.
  // 2026-05-22: just use the file-system convention used by the
  // existing public/style-refs/Doodle-explainer/ directory.
  const dirMap: Record<string, string> = {
    doodle_explainer: 'Doodle-explainer',
  };
  const dir = dirMap[builtIn.id] ?? builtIn.id;
  const base = getPublicBaseUrl();
  const now = new Date().toISOString();
  return builtIn.built_in_refs.map((ref, i) => {
    const relativeUrl = `/style-refs/${dir}/${ref.filename}`;
    const publicUrl = base ? `${base}${relativeUrl}` : relativeUrl;
    // Build a synthetic StyleReferenceImage row. Id is namespaced so
    // it can never collide with a real DB UUID. content_validated is
    // TRUE because the bytes are bundled in the deploy; we trust
    // ourselves. r2_bucket/r2_key are empty — the dispatcher must
    // check public_url first, before falling back to those.
    return {
      id: `builtin:${builtIn.id}:${i}`,
      style_id: builtIn.id,
      workspace_id: '',
      position: i,
      role: 'style',
      weight: 1,
      r2_bucket: '',
      r2_key: '',
      size_bytes: null,
      mime_type: ref.mime_type,
      width: null,
      height: null,
      rejected_by_provider: false,
      rejection_reason: null,
      rejection_provider: null,
      rejected_at: null,
      created_at: now,
      content_validated: true,
      content_validation_error: null,
      content_validated_at: now,
      public_url: publicUrl,
    };
  });
}

/** A row in `style_reference_images` (migration 0080 + 0082).
 *  Surfaces every column so callers can decide whether to expose
 *  rejection / validation state to the UI or strip it. */
export interface StyleReferenceImage {
  id: string;
  style_id: string;
  workspace_id: string;
  position: number;
  /** v1 always 'style'; schema reserves the others for future IP-Adapter
   *  multi-role conditioning. */
  role: 'style' | 'character' | 'palette' | 'composition';
  weight: number;
  r2_bucket: string;
  r2_key: string;
  size_bytes: number | null;
  mime_type: string;
  width: number | null;
  height: number | null;
  rejected_by_provider: boolean;
  rejection_reason: string | null;
  rejection_provider: string | null;
  rejected_at: string | null;
  created_at: string;
  // Migration 0082 — post-upload MIME sniff state.
  /** NULL until validation runs; TRUE on magic-byte match; FALSE on
   *  mismatch / fetch failure. Dispatcher excludes anything not TRUE. */
  content_validated: boolean | null;
  /** Human-readable mismatch reason when content_validated = FALSE. */
  content_validation_error: string | null;
  /** Timestamp of the last validation attempt. */
  content_validated_at: string | null;
  /** v3 (2026-05-22): for synthesized built-in refs only. When set,
   *  the dispatcher uses this URL directly instead of minting a
   *  presigned R2 GET. Always undefined for DB-backed refs. */
  public_url?: string;
}

/** Hard cap shared with the API layer and the editor UI — keeps every
 *  provider in our matrix in range (Flux 2 Pro = 8, NanoBanana Pro = 8,
 *  GPT Image 2 = 16, Ideogram Remix = 1). 8 is the tightest provider
 *  cap that lets every model accept the whole ref set. */
export const MAX_REFS_PER_STYLE = 8;

export interface LoadStyleReferencesOptions {
  /** Skip refs flagged as `rejected_by_provider = true`. The dispatcher
   *  sets this on every real generation so a known-bad ref doesn't get
   *  re-sent and 4xx'd again. The editor sets it to FALSE so the user
   *  can see (and clear) rejected refs. */
  excludeRejected?: boolean;
  /** Skip refs whose post-upload MIME sniff didn't return TRUE
   *  (migration 0082). The dispatcher sets this on every real
   *  generation so unvalidated or actively-mismatched refs can't
   *  reach Kie / ComfyUI. The editor sets it to FALSE so unvalidated
   *  refs render (with a "validating…" badge) and failed ones render
   *  (with an error badge). */
  excludeUnvalidated?: boolean;
  /** Explicit exclude list — used by the "Regenerate without [n]
   *  rejected refs" button: the route passes the offending ids back
   *  so the regeneration call drops them even before the rejection
   *  flag is persisted. */
  excludeIds?: readonly string[];
  /** Defense-in-depth workspace filter. When set, the query AND-s on
   *  `workspace_id = ${workspaceId}` so even a caller that skipped the
   *  ownership-resolve step can't get refs for a different workspace's
   *  style. Routes should always pass `session.ws` here.
   *
   *  v1 callers without it stay working (the FK from `style_id` plus
   *  prior `resolveStyle` / `assertStyleOwnership` checks make the
   *  query safe), but new code MUST pass it. Will become required in
   *  a future major refactor. */
  workspaceId?: string;
}

/**
 * Load every ref attached to a style, ordered by `position`.
 *
 * Three filters can be layered on top of the base query:
 *   - `excludeRejected: true` drops rows with `rejected_by_provider = true`
 *   - `excludeIds: [...]` drops rows whose id is in the list
 *   - `workspaceId: <ws>` adds `AND workspace_id = $ws` as defense-in-depth
 *
 * All three are common in the dispatcher path; the editor uses only
 * the workspace filter.
 *
 * Workspace filter is recommended on every callsite (defense in
 * depth) even though the FK from `style_id` combined with a prior
 * `resolveStyle` / `assertStyleOwnership` already guarantees scope.
 */
export async function loadStyleReferences(
  styleId: string,
  opts: LoadStyleReferencesOptions = {},
): Promise<StyleReferenceImage[]> {
  // v3 (2026-05-22): built-in slugs short-circuit to the static
  // refs registered on the built-in spec. No DB round-trip; the
  // refs ship with the deploy. Built-in refs are never rejected
  // (no per-workspace rejection state) and never unvalidated (we
  // trust our own bytes), so the exclude filters don't apply.
  const builtIn = getBuiltInStyle(styleId);
  if (builtIn?.built_in_refs?.length) {
    return synthesizeBuiltInRefs(styleId);
  }

  const excludeRejected = opts.excludeRejected === true;
  const excludeUnvalidated = opts.excludeUnvalidated === true;
  const excludeIds = (opts.excludeIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
  const workspaceId = opts.workspaceId;

  // Single sql.query() path that composes optional predicates by
  // appending clauses to a parameter array — cleaner than three
  // tagged-template branches and supports the workspaceId filter
  // uniformly. Predicates only ever appear when their value is
  // present, so the query stays planner-friendly.
  const selectFields = `id, style_id, workspace_id, position, role, weight,
       r2_bucket, r2_key, size_bytes, mime_type, width, height,
       rejected_by_provider, rejection_reason, rejection_provider,
       rejected_at, created_at,
       content_validated, content_validation_error, content_validated_at`;

  const params: unknown[] = [styleId];
  const clauses: string[] = ['style_id = $1::uuid'];

  if (workspaceId) {
    params.push(workspaceId);
    clauses.push(`workspace_id = $${params.length}::uuid`);
  }
  if (excludeRejected) {
    clauses.push('rejected_by_provider = FALSE');
  }
  if (excludeUnvalidated) {
    clauses.push('content_validated = TRUE');
  }
  if (excludeIds.length > 0) {
    params.push(excludeIds);
    clauses.push(`id <> ALL($${params.length}::uuid[])`);
  }

  const { rows } = await sql.query<StyleReferenceImage>(
    `SELECT ${selectFields}
       FROM style_reference_images
      WHERE ${clauses.join(' AND ')}
      ORDER BY position ASC`,
    params,
  );
  return rows;
}

export interface AddStyleReferenceInput {
  styleId: string;
  workspaceId: string;
  r2Bucket: string;
  r2Key: string;
  mimeType: string;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  /** Optional explicit position; defaults to (current_count). Pass when
   *  re-arranging via drag-reorder; omit for a normal append. */
  position?: number;
}

/**
 * Insert a `style_reference_images` row after the PUT to R2 has
 * completed. Enforces the 8-ref cap inside a transaction so two
 * concurrent uploads can't both win and land at slot 8 + slot 8.
 *
 * Returns the inserted row.
 *
 * Throws { code: 'REFS_LIMIT' } when the style is at MAX_REFS_PER_STYLE.
 * The API layer should map this to a 409 / "remove a ref first" UX.
 */
export async function addStyleReference(input: AddStyleReferenceInput): Promise<StyleReferenceImage> {
  // Atomic 8-ref cap. Counts existing rows AND inserts in a single SQL
  // statement via `INSERT … SELECT … WHERE (SELECT COUNT…) < cap` so
  // two concurrent uploads can't both pass a pre-check then race past
  // the cap. The previous two-statement version was vulnerable —
  // `@vercel/postgres` runs each tagged-template `sql\`\`` as its own
  // implicit transaction, NOT a single serialized transaction, so
  // count + insert ran against different snapshots. The position
  // UNIQUE constraint partially saved us by 23505-ing the second
  // insert when both picked the same position, but a client passing
  // `position` explicitly to differing values could still squeeze
  // two rows past 8.
  //
  // Empty `rows` from the RETURNING set means the WHERE failed (cap
  // hit) — we surface that as the documented `REFS_LIMIT` 409.
  // Anything else (FK violation, unique conflict on position) still
  // throws and the route maps it to its appropriate status.
  const explicitPosition = typeof input.position === 'number' ? input.position : null;

  const { rows } = await sql.query<StyleReferenceImage>(
    `INSERT INTO style_reference_images (
       style_id, workspace_id, position,
       r2_bucket, r2_key, mime_type, size_bytes, width, height
     )
     SELECT $1::uuid, $2::uuid,
            COALESCE($3::smallint, (
              SELECT COUNT(*)::smallint FROM style_reference_images WHERE style_id = $1::uuid
            )),
            $4, $5, $6, $7, $8, $9
       WHERE (SELECT COUNT(*) FROM style_reference_images WHERE style_id = $1::uuid) < ${MAX_REFS_PER_STYLE}
     RETURNING id, style_id, workspace_id, position, role, weight,
               r2_bucket, r2_key, size_bytes, mime_type, width, height,
               rejected_by_provider, rejection_reason, rejection_provider,
               rejected_at, created_at,
               content_validated, content_validation_error, content_validated_at`,
    [
      input.styleId,
      input.workspaceId,
      explicitPosition,
      input.r2Bucket,
      input.r2Key,
      input.mimeType,
      input.sizeBytes ?? null,
      input.width ?? null,
      input.height ?? null,
    ],
  );
  if (rows.length === 0) {
    const err = new Error(`Style ${input.styleId} already has the maximum ${MAX_REFS_PER_STYLE} reference images`);
    (err as Error & { code?: string }).code = 'REFS_LIMIT';
    throw err;
  }
  return rows[0];
}

/**
 * Delete a ref row, scoped to its parent style. Returns the deleted
 * row (so the API layer can fan out an R2 object delete using the
 * row's `r2_bucket` + `r2_key` without a separate read).
 *
 * `styleId` is required: it prevents a malicious caller from passing
 * a `refId` that belongs to a style they don't own through an endpoint
 * that only checked the path's `styleId`. The DELETE only fires when
 * BOTH the id and the style_id binding match.
 *
 * Returns null when the row doesn't exist OR the binding doesn't
 * match — DELETE is idempotent at the API layer and the
 * indistinguishable failure modes prevent enumeration.
 */
export async function deleteStyleReference(refId: string, styleId: string): Promise<StyleReferenceImage | null> {
  const { rows } = await sql<StyleReferenceImage>`
    DELETE FROM style_reference_images
    WHERE id = ${refId} AND style_id = ${styleId}
    RETURNING id, style_id, workspace_id, position, role, weight,
              r2_bucket, r2_key, size_bytes, mime_type, width, height,
              rejected_by_provider, rejection_reason, rejection_provider,
              rejected_at, created_at,
              content_validated, content_validation_error, content_validated_at
  `;
  return rows[0] ?? null;
}

/**
 * Mark a ref as rejected by a provider. Called from the image-gen
 * dispatcher when Kie.ai (or future provider) returns a content
 * refusal that's traceable to a specific input image — e.g.
 * NanoBanana Pro returns the index of the offending `image_input`
 * entry. The next generation under this style skips the ref.
 *
 * `styleId` is required: prevents a caller from flipping the
 * rejected flag on a ref that belongs to a different style. The
 * dispatcher always has the styleId in scope; for defense-in-depth
 * we bind here rather than trusting the caller.
 *
 * The editor's "Clear rejection" affordance reverses this via
 * `clearReferenceRejection`.
 */
export async function markReferenceRejected(
  refId: string,
  styleId: string,
  reason: string,
  provider: string,
): Promise<void> {
  // Truncate reason: providers occasionally return long structured
  // errors and the column doesn't need the full payload — a slice
  // is enough for the UI tooltip + observability.
  const reasonSlice = reason.length > 1000 ? reason.slice(0, 1000) : reason;
  await sql`
    UPDATE style_reference_images
       SET rejected_by_provider = TRUE,
           rejection_reason = ${reasonSlice},
           rejection_provider = ${provider},
           rejected_at = NOW()
     WHERE id = ${refId} AND style_id = ${styleId}
  `;
}

/**
 * Reset the rejected_by_provider flag — used by the editor's "Clear
 * rejection" menu item when the user believes the prior refusal was
 * a false positive and wants to try again on the next generation.
 *
 * `styleId` binding prevents cross-style mutation through the
 * editor's PATCH endpoint when a malformed caller path passes a
 * refId from a different style.
 */
export async function clearReferenceRejection(refId: string, styleId: string): Promise<void> {
  await sql`
    UPDATE style_reference_images
       SET rejected_by_provider = FALSE,
           rejection_reason = NULL,
           rejection_provider = NULL,
           rejected_at = NULL
     WHERE id = ${refId} AND style_id = ${styleId}
  `;
}

// ─── Post-upload MIME sniff (migration 0082) ─────────────────────────

/** Magic-byte signatures for the formats we accept. Each entry is an
 *  array of `(offset, bytes)` matches — ALL must hit for the format
 *  to qualify. Offsets are byte positions from the start of the file. */
const MAGIC_SIGNATURES: Record<string, ReadonlyArray<{ offset: number; bytes: readonly number[] }>> = {
  // JPEG: FF D8 FF (3 bytes, very tight — no false positives in
  // legitimate non-JPEG content).
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  // PNG: 89 50 4E 47 0D 0A 1A 0A (8 bytes, deterministic).
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  // WebP: "RIFF" at 0, "WEBP" at 8. Bytes 4..7 are the chunk-size
  // little-endian uint32 — we don't validate it (file could be any
  // size), just the framing bytes.
  'image/webp': [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
};

/** Best-effort detection of a few formats we want to flag if they
 *  land where a JPEG/PNG/WebP was declared. Surfaces a useful error
 *  message rather than just "no magic match". */
function describeUnexpectedFormat(head: Buffer): string {
  const ascii = head.slice(0, Math.min(16, head.length)).toString('ascii');
  if (ascii.startsWith('<?xml') || ascii.startsWith('<svg')) return 'SVG (text/xml)';
  if (ascii.startsWith('<!DOCTYPE') || ascii.startsWith('<html')) return 'HTML';
  if (ascii.startsWith('%PDF')) return 'PDF';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'GIF (not allowed)';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'BMP (not allowed)';
  // Fallback to first-byte hex so the error has SOMETHING actionable
  // even for unknown formats.
  const hex = Array.from(head.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return `unknown format (first 4 bytes: ${hex})`;
}

/** Decision: does the first-N-bytes head match the declared MIME? */
function magicMatches(declaredMime: string, head: Buffer): boolean {
  const sigs = MAGIC_SIGNATURES[declaredMime];
  if (!sigs) return false; // unknown declared MIME = treat as mismatch
  return sigs.every((sig) =>
    sig.bytes.every((expected, i) => head[sig.offset + i] === expected),
  );
}

function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 not configured for content validation');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export interface ValidateUploadedRefResult {
  validated: boolean;
  error?: string;
}

/**
 * Range-GET the first 16 bytes of an uploaded ref from R2 and
 * check the magic-byte signature against the declared MIME type.
 * Updates `content_validated` + `content_validation_error` on the
 * ref row. Caller is responsible for ownership/binding checks —
 * this helper trusts that `refId` + `styleId` were already
 * authorised.
 *
 * Failure modes (each results in `content_validated = FALSE`):
 *   - R2 object missing or HEAD/GET errored
 *   - Magic bytes don't match the declared MIME type
 *   - Declared MIME type unknown (shouldn't happen — the upload
 *     endpoint allowlists at presign time — but defense in depth)
 */
export async function validateUploadedRef(
  refId: string,
  styleId: string,
): Promise<ValidateUploadedRefResult> {
  // Load the ref's R2 location + declared MIME.
  const { rows } = await sql<{ r2_bucket: string; r2_key: string; mime_type: string }>`
    SELECT r2_bucket, r2_key, mime_type
    FROM style_reference_images
    WHERE id = ${refId} AND style_id = ${styleId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return { validated: false, error: 'Reference row not found' };
  }
  const ref = rows[0];

  let head: Buffer;
  try {
    const client = getR2Client();
    // Range bytes 0-15 (inclusive) = first 16 bytes. Enough for every
    // signature in MAGIC_SIGNATURES (WebP needs through byte 11).
    const res = await client.send(new GetObjectCommand({
      Bucket: ref.r2_bucket,
      Key: ref.r2_key,
      Range: 'bytes=0-15',
    }));
    const body = res.Body;
    if (!body) {
      await markValidation(refId, styleId, false, 'R2 returned empty body for content validation');
      return { validated: false, error: 'empty body' };
    }
    // The SDK's Body is a ReadableStream on Node 18+; transform to a
    // Buffer by reading all chunks (small — 16 bytes max).
    const chunks: Uint8Array[] = [];
    // @ts-expect-error — Body is iterable as AsyncIterable<Uint8Array>
    // on Node fetch runtime; the SDK's type union covers browser too.
    for await (const chunk of body) {
      chunks.push(chunk as Uint8Array);
    }
    head = Buffer.concat(chunks);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markValidation(refId, styleId, false, `Range-GET failed: ${reason.slice(0, 200)}`);
    return { validated: false, error: reason };
  }

  if (magicMatches(ref.mime_type, head)) {
    await markValidation(refId, styleId, true, null);
    return { validated: true };
  }

  // Mismatch — describe what we actually got so the user knows why.
  const got = describeUnexpectedFormat(head);
  const reason = `Declared ${ref.mime_type} but bytes look like ${got}`;
  await markValidation(refId, styleId, false, reason);
  return { validated: false, error: reason };
}

async function markValidation(
  refId: string,
  styleId: string,
  ok: boolean,
  error: string | null,
): Promise<void> {
  await sql`
    UPDATE style_reference_images
       SET content_validated = ${ok},
           content_validation_error = ${error},
           content_validated_at = NOW()
     WHERE id = ${refId} AND style_id = ${styleId}
  `;
}
