/**
 * shorts_batches CRUD + state machine + metadata seeding helpers.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * The batch is a cohort of N shorts that move through the same
 * generation + review + upload flow together. This module owns:
 *   - the CRUD API (create, read, list, patch defaults)
 *   - the batch-level state machine (setup → generating → review
 *     → uploading → done / failed)
 *   - totals recomputation (denormalised counter cache for cheap
 *     dashboard reads)
 *   - the per-short youtube_metadata patch (review-queue edits)
 *   - the seeding helpers that derive a starting metadata blob
 *     from batch defaults + SEO output
 *
 * Per-short generation state is intentionally NOT stored as a new
 * column. The orchestrator (shorts-batch-orchestrator.ts) derives
 * "what's the next stage for this short?" from existing columns:
 *   - short_script IS NULL          → needs extract_from_idea
 *   - voiceover_audio_url IS NULL   → needs generate_voiceover
 *   - seo_result IS NULL            → needs generate_seo
 *   - rendered_video_url IS NULL    → needs render (asset pipeline)
 *   - else                          → ready_for_review
 * Keeps the schema slim and the state derivable from observable
 * columns (no risk of phantom states from a crashed mid-tick update).
 */
import { sql } from '@vercel/postgres';
import type {
  ShortsBatchRow,
  ShortsBatchStatus,
  ShortsBatchDefaults,
  ShortsBatchTotals,
  ShortsBatchWithShorts,
  YoutubeUploadMetadata,
} from './shorts-batches-types';
import type { ShortRow } from './shorts-types';

/** Idea input the user picked at step 1. The batch route turns each
 *  one into a placeholder shorts row that the orchestrator later
 *  enriches via `extractShortFromIdea`. Mirrors the `ShortIdea`
 *  shape from `shorts-ideas.ts` but lives here so the API route
 *  doesn't have to import server-only modules client-side. */
export interface BatchIdeaInput {
  ideaTitle: string;
  hook: string;
  payoff: string;
  thesis?: string;
  shotConcept?: string;
  niche: string;
  tone?: string;
  targetSeconds?: number;
}

/** Pure state machine: returns the next valid status or throws
 *  `BatchStateTransitionError` on an illegal move. Exposed for unit
 *  tests so the matrix can be exhaustively verified without a DB.
 *
 *  Transition matrix:
 *    setup        → generating, failed
 *    generating   → review, failed
 *    review       → uploading, failed
 *    uploading    → done, failed, review (recoverable retry)
 *    done         → (terminal)
 *    failed       → setup (operator-initiated reset; the only escape) */
export class BatchStateTransitionError extends Error {
  constructor(public from: ShortsBatchStatus, public to: ShortsBatchStatus) {
    super(`Illegal batch state transition: ${from} → ${to}`);
    this.name = 'BatchStateTransitionError';
  }
}

const VALID_TRANSITIONS: Readonly<Record<ShortsBatchStatus, readonly ShortsBatchStatus[]>> = {
  setup: ['generating', 'failed'],
  generating: ['review', 'failed'],
  review: ['uploading', 'failed'],
  uploading: ['done', 'failed', 'review'],
  done: [],
  failed: ['setup'],
};

export function assertValidTransition(from: ShortsBatchStatus, to: ShortsBatchStatus): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new BatchStateTransitionError(from, to);
  }
}

/** Pure totals computer. Walks an array of child shorts and returns
 *  the {planned, generated, failed, uploaded, scheduled} counter. */
export function computeBatchTotals(shorts: readonly ShortRow[]): ShortsBatchTotals {
  let generated = 0;
  let failed = 0;
  let uploaded = 0;
  let scheduled = 0;

  for (const s of shorts) {
    if (s.rendered_video_url) generated += 1;
    if (s.youtube_upload_error) failed += 1;
    if (s.youtube_status === 'uploaded' || s.youtube_status === 'published') uploaded += 1;
    if (s.youtube_status === 'scheduled') {
      uploaded += 1;
      scheduled += 1;
    }
  }

  return { planned: shorts.length, generated, failed, uploaded, scheduled };
}

/** Pure seeding helper. Returns the youtube_metadata that should be
 *  attached to a freshly-SEO'd short, merging the batch defaults
 *  with the top SEO suggestion. Per-short overrides applied later in
 *  the review queue win over the seed.
 *
 *  Template expansion: descriptionTemplate supports `{{title}}`,
 *  `{{hook}}`, `{{payoff}}` placeholders. Missing fields collapse to
 *  empty string. If the template is absent or empty, the SEO-graded
 *  top description is used directly. */
export function seedYoutubeMetadataFromBatch(args: {
  short: ShortRow;
  defaults: ShortsBatchDefaults;
}): YoutubeUploadMetadata {
  const { short, defaults } = args;
  const seo = short.seo_result;

  // Title: top SEO grade beats the original. Falls through to the
  // raw title only when SEO failed (which shouldn't reach this seed
  // helper, but we degrade gracefully).
  const topSeoTitle = seo?.titles?.[0]?.text ?? null;
  const title = topSeoTitle ?? short.title ?? '';

  // Description: template-expand if present, else top SEO grade,
  // else empty.
  let description = '';
  if (defaults.descriptionTemplate) {
    description = expandDescriptionTemplate(defaults.descriptionTemplate, {
      title,
      hook: short.hook ?? '',
      payoff: short.payoff ?? '',
    });
  } else if (seo?.descriptions?.[0]?.text) {
    description = seo.descriptions[0].text;
  }

  // YouTube TAGS metadata: prefer the SEO-generated dedicated `tags`
  // array (multi-word phrases optimised for search indexing) over the
  // hashtags (single-word category markers). Falls back to hashtags
  // for rows persisted before the `tags` field landed. Always merged
  // with the batch's user-supplied tag pool — batch pool first so
  // explicit human picks win duplicate resolution.
  //
  // Per QA finding H7: dedup must be case + whitespace insensitive.
  // `tagsPool` may carry "USPS scam" (space + caps), SEO tags
  // could have "usps scam" (different case), and the hashtags
  // fallback strips whitespace producing "USPSscam". Without
  // normalised dedup all three coexist, wasting the 500-char budget
  // on near-identical tags.
  const seoTags = seo?.tags && seo.tags.length > 0
    ? seo.tags
    : (seo?.hashtag_sets?.[0]?.tags ?? []);
  const merged = dedupeNormalisedStrings([...(defaults.tagsPool ?? []), ...seoTags]);

  return {
    title,
    description,
    tags: merged,
    categoryId: defaults.categoryId,
    defaultLanguage: defaults.language,
    playlistIds: defaults.playlistIds ? [...defaults.playlistIds] : [],
    privacy: defaults.defaultPrivacy,
    madeForKids: defaults.madeForKids,
    ageRestricted: defaults.ageRestricted ?? false,
    paidPromotion: defaults.paidPromotion ?? false,
    aiContentDisclosure: defaults.aiContentDisclosure ?? true,
  };
}

/** Pure template expander — case-sensitive, replaces every
 *  occurrence of each placeholder. Exposed so a unit test can
 *  verify the surface without going through the full seeding flow. */
export function expandDescriptionTemplate(
  template: string,
  vars: { title: string; hook: string; payoff: string },
): string {
  // Per QA L3: accept any-case placeholder names. LLM rewrites of the
  // template often capitalise ({{Title}}, {{HOOK}}). Previously these
  // were silently left as literal text in the published description.
  return template.replace(
    /\{\{\s*(title|hook|payoff)\s*\}\}/gi,
    (_match, name) => {
      const key = (name as string).toLowerCase() as keyof typeof vars;
      return vars[key] ?? '';
    },
  );
}

/** Pure: dedupe primitive array preserving first-occurrence order.
 *  Constrained to primitives (per QA H10) because Set<T> uses
 *  reference equality for objects — the old `<T>` generic silently
 *  failed for non-primitives. */
function dedupeKeepOrder<T extends string | number | boolean>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of arr) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** Case + whitespace insensitive string dedup, preserving the first
 *  occurrence's casing. YouTube treats "USPS scam" and "usps scam" as
 *  the same tag; this collapses them. Per QA H7. */
function dedupeNormalisedStrings(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const norm = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    // Push the trimmed-and-collapsed FORM but keep the user's casing.
    out.push(raw.trim().replace(/\s+/g, ' '));
  }
  return out;
}

// ─── CRUD ────────────────────────────────────────────────────────────

/** Create a batch row + N placeholder shorts (one per idea input)
 *  in a single transaction. The shorts are inserted with
 *  `short_script=NULL` so the orchestrator's extract stage knows to
 *  process them. Returns the new batch id + the placeholder short
 *  ids in insertion order. */
export async function createBatch(args: {
  workspaceId: string;
  channelId: string | null;
  createdBy: string | null;
  name?: string | null;
  defaults: ShortsBatchDefaults;
  ideaInputs: readonly BatchIdeaInput[];
  projectId?: string | null;
}): Promise<{ batchId: string; shortIds: string[] }> {
  const { workspaceId, channelId, createdBy, defaults, ideaInputs, projectId = null } = args;

  if (ideaInputs.length === 0) {
    throw new Error('createBatch: ideaInputs must contain at least one entry.');
  }

  const totals: ShortsBatchTotals = {
    planned: ideaInputs.length,
    generated: 0,
    failed: 0,
    uploaded: 0,
    scheduled: 0,
  };

  const { rows } = await sql<{ id: string }>`
    INSERT INTO shorts_batches (workspace_id, channel_id, created_by, name, status, defaults, totals)
    VALUES (
      ${workspaceId}::uuid,
      ${channelId}::uuid,
      ${createdBy}::uuid,
      ${args.name ?? null},
      'setup',
      ${JSON.stringify(defaults)}::jsonb,
      ${JSON.stringify(totals)}::jsonb
    )
    RETURNING id
  `;
  const batchId = rows[0]!.id;

  const shortIds: string[] = [];
  // Insert serially — the per-row generation_params blob carries the
  // idea inputs the orchestrator's extract stage reads later.
  for (const idea of ideaInputs) {
    const params = {
      batch_idea_input: idea,
    };
    const ins = await sql<{ id: string }>`
      INSERT INTO shorts (
        workspace_id, project_id, batch_id,
        kind, medium,
        title, hook, payoff,
        generation_params,
        youtube_metadata
      ) VALUES (
        ${workspaceId}::uuid,
        ${projectId}::uuid,
        ${batchId}::uuid,
        'extracted',
        'short_native',
        ${idea.ideaTitle},
        ${idea.hook},
        ${idea.payoff},
        ${JSON.stringify(params)}::jsonb,
        '{}'::jsonb
      )
      RETURNING id
    `;
    shortIds.push(ins.rows[0]!.id);
  }

  console.info('[shorts-batch create]', {
    batch_id: batchId,
    workspace_id: workspaceId,
    channel_id: channelId,
    idea_count: ideaInputs.length,
  });

  return { batchId, shortIds };
}

/** Workspace-scoped batch lookup. Returns null when missing or
 *  cross-workspace (never leaks another tenant's row). */
export async function getBatch(batchId: string, workspaceId: string): Promise<ShortsBatchRow | null> {
  const { rows } = await sql<ShortsBatchRow>`
    SELECT
      id, workspace_id, channel_id, created_by, name, status,
      defaults, totals,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM shorts_batches
    WHERE id = ${batchId}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Batch + child shorts, ordered by created_at so the review queue
 *  renders the cards in a deterministic sequence. */
export async function getBatchWithShorts(
  batchId: string,
  workspaceId: string,
): Promise<ShortsBatchWithShorts | null> {
  const batch = await getBatch(batchId, workspaceId);
  if (!batch) return null;

  const { rows: shorts } = await sql<ShortRow>`
    SELECT
      id, workspace_id, project_id, source_script_id, kind, medium,
      title, short_script, hook, payoff,
      word_count, estimated_duration_seconds,
      source_title, source_description, seo_result,
      voiceover_audio_url, voiceover_blob_pathname,
      voiceover_voice_id, voiceover_duration_seconds,
      rendered_video_url, ai_model, generation_params, notes,
      hook_score, dismissed_at::text AS dismissed_at,
      source_youtube_video_id, clip_start_ms, clip_end_ms,
      style_id, style_assets, captions_config, generation_progress,
      assets_context,
      qa_result, qa_score, qa_run_at::text AS qa_run_at,
      batch_id,
      youtube_video_id, youtube_status,
      youtube_publish_at::text AS youtube_publish_at,
      youtube_metadata,
      youtube_uploaded_at::text AS youtube_uploaded_at,
      youtube_upload_error,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM shorts
    WHERE batch_id = ${batchId}::uuid AND workspace_id = ${workspaceId}::uuid
    ORDER BY created_at ASC
  `;

  return { batch, shorts };
}

/** Recent batches for the workspace dashboard. */
export async function listBatchesForWorkspace(workspaceId: string, limit = 50): Promise<ShortsBatchRow[]> {
  const { rows } = await sql<ShortsBatchRow>`
    SELECT
      id, workspace_id, channel_id, created_by, name, status,
      defaults, totals,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM shorts_batches
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

/** Merge a defaults patch — only while the batch is in 'setup'. Any
 *  other status returns null so the caller can surface a 409 to the
 *  user instead of silently dropping the edit. */
export async function updateBatchDefaults(
  batchId: string,
  workspaceId: string,
  patch: Partial<ShortsBatchDefaults>,
): Promise<ShortsBatchRow | null> {
  const current = await getBatch(batchId, workspaceId);
  if (!current) return null;
  if (current.status !== 'setup') return null;

  const merged: ShortsBatchDefaults = { ...current.defaults, ...patch };
  await sql`
    UPDATE shorts_batches
       SET defaults = ${JSON.stringify(merged)}::jsonb,
           updated_at = NOW()
     WHERE id = ${batchId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;

  return { ...current, defaults: merged };
}

/** Transition a batch's status. Throws on illegal transitions so the
 *  caller can map to a 409. */
export async function updateBatchStatus(
  batchId: string,
  workspaceId: string,
  to: ShortsBatchStatus,
): Promise<ShortsBatchRow | null> {
  const current = await getBatch(batchId, workspaceId);
  if (!current) return null;
  assertValidTransition(current.status, to);

  await sql`
    UPDATE shorts_batches
       SET status = ${to}, updated_at = NOW()
     WHERE id = ${batchId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;

  console.info('[shorts-batch status]', {
    batch_id: batchId,
    from: current.status,
    to,
  });

  return { ...current, status: to };
}

/** Recompute + persist the totals JSONB by walking the child shorts.
 *  Cheap relative to the orchestrator's other work, so it's safe to
 *  call after every per-short transition. */
export async function recomputeBatchTotals(
  batchId: string,
  workspaceId: string,
): Promise<ShortsBatchTotals | null> {
  const withShorts = await getBatchWithShorts(batchId, workspaceId);
  if (!withShorts) return null;
  const totals = computeBatchTotals(withShorts.shorts);
  await sql`
    UPDATE shorts_batches
       SET totals = ${JSON.stringify(totals)}::jsonb,
           updated_at = NOW()
     WHERE id = ${batchId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return totals;
}

/** Merge a youtube_metadata patch onto a short. Used by the
 *  review-queue per-short editor. Returns the updated metadata or
 *  null if the short is missing / cross-workspace. */
export async function updateShortYoutubeMetadata(
  shortId: string,
  workspaceId: string,
  patch: Partial<YoutubeUploadMetadata>,
): Promise<YoutubeUploadMetadata | null> {
  const { rows } = await sql<{ youtube_metadata: YoutubeUploadMetadata }>`
    SELECT youtube_metadata
      FROM shorts
     WHERE id = ${shortId}::uuid AND workspace_id = ${workspaceId}::uuid
     LIMIT 1
  `;
  if (rows.length === 0) return null;

  const merged: YoutubeUploadMetadata = { ...rows[0].youtube_metadata, ...patch };
  await sql`
    UPDATE shorts
       SET youtube_metadata = ${JSON.stringify(merged)}::jsonb,
           updated_at = NOW()
     WHERE id = ${shortId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return merged;
}

/** Set a short's youtube_publish_at (or clear it). Called by the
 *  review-queue scheduler. */
export async function updateShortPublishAt(
  shortId: string,
  workspaceId: string,
  publishAtUtc: string | null,
): Promise<void> {
  await sql`
    UPDATE shorts
       SET youtube_publish_at = ${publishAtUtc}::timestamptz,
           updated_at = NOW()
     WHERE id = ${shortId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
}
