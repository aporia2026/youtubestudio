/**
 * A/B test orchestrator. The control plane sits on top of:
 *   - `youtube-publish.ts` for pushing variants to the live YouTube video
 *   - `youtube-analytics.ts` for capturing per-variant performance snapshots
 *   - `google-oauth.ts` for resolving a usable access token from a channel
 *
 * Lifecycle:
 *   draft     → row created, no live push yet
 *   running   → variant A pushed live (or pre-existing on YouTube), tester
 *               can call /swap to flip to B and /snapshot to capture metrics
 *   concluded → winner chosen + pushed live, no further swaps allowed
 *
 * Snapshots are append-only. The detail view collapses by variant on read
 * (latest captured_at wins per variant) — see `summariseAbTestSnapshots`.
 *
 * Pure helpers (validation, summary aggregation) are exported so the test
 * suite can verify the policy without booting up YouTube OAuth.
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { getValidAccessToken } from './google-oauth';
import {
  downloadThumbnailForUpload,
  pushVariantToYoutube,
  updateYoutubeVideoSnippet,
  type PushVariantResult,
} from './youtube-publish';
import { syncVideoAnalytics } from './youtube-analytics';
import {
  AB_TEST_DESCRIPTION_MAX_LENGTH,
  AB_TEST_TITLE_MAX_LENGTH,
  isAbTestVariant,
  type AbTestRow,
  type AbTestSnapshotRow,
  type AbTestStatus,
  type AbTestVariant,
  type AbTestVariantSummary,
} from './ab-tests-types';

export type {
  AbTestRow,
  AbTestSnapshotRow,
  AbTestStatus,
  AbTestVariant,
  AbTestVariantSummary,
} from './ab-tests-types';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface ValidatedVariantInputs {
  variantATitle: string;
  variantBTitle: string;
  variantAThumbnailUrl: string | null;
  variantBThumbnailUrl: string | null;
}

/** Reject inputs that would never round-trip through YouTube. Throws with a
 *  user-meaningful message — callers turn these into 400s. */
export function validateVariantInputs(inputs: {
  variantATitle?: string;
  variantBTitle?: string;
  variantAThumbnailUrl?: string | null;
  variantBThumbnailUrl?: string | null;
}): ValidatedVariantInputs {
  const a = (inputs.variantATitle ?? '').trim();
  const b = (inputs.variantBTitle ?? '').trim();
  if (!a || !b) {
    throw new Error('Both variantATitle and variantBTitle are required.');
  }
  if (a.length > AB_TEST_TITLE_MAX_LENGTH || b.length > AB_TEST_TITLE_MAX_LENGTH) {
    throw new Error(`Title exceeds YouTube ${AB_TEST_TITLE_MAX_LENGTH}-character limit.`);
  }
  if (a === b) {
    throw new Error('Variant A and B titles are identical — no test would be meaningful.');
  }
  return {
    variantATitle: a,
    variantBTitle: b,
    variantAThumbnailUrl: inputs.variantAThumbnailUrl?.trim() || null,
    variantBThumbnailUrl: inputs.variantBThumbnailUrl?.trim() || null,
  };
}

/**
 * Collapse a stream of append-only snapshots into one summary per variant,
 * keeping the LATEST snapshot per variant (YouTube Analytics returns cumulative
 * lifetime totals — the newest snapshot supersedes older ones).
 */
export function summariseAbTestSnapshots(
  snapshots: ReadonlyArray<AbTestSnapshotRow>,
): { a: AbTestVariantSummary; b: AbTestVariantSummary } {
  const empty = (variant: AbTestVariant): AbTestVariantSummary => ({
    variant,
    snapshot_count: 0,
    latest_captured_at: null,
    impressions: null,
    views: null,
    ctr_percentage: null,
    average_view_duration_seconds: null,
    subscribers_gained: null,
  });
  const summary = { a: empty('a'), b: empty('b') };

  for (const snap of snapshots) {
    const bucket = summary[snap.variant];
    bucket.snapshot_count += 1;
    if (!bucket.latest_captured_at || snap.captured_at > bucket.latest_captured_at) {
      bucket.latest_captured_at = snap.captured_at;
      bucket.impressions = snap.impressions;
      bucket.views = snap.views;
      bucket.ctr_percentage = snap.ctr_percentage;
      bucket.average_view_duration_seconds = snap.average_view_duration_seconds;
      bucket.subscribers_gained = snap.subscribers_gained;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Create / read / delete
// ---------------------------------------------------------------------------

export interface CreateAbTestArgs {
  workspaceId: string;
  scheduleItemId: string | null;
  channelDbId: string | null;
  youtubeVideoId: string;
  variantATitle: string;
  variantBTitle: string;
  variantAThumbnailUrl?: string | null;
  variantBThumbnailUrl?: string | null;
  aiModel?: string | null;
  notes?: string | null;
}

export async function createAbTest(args: CreateAbTestArgs): Promise<{ id: string }> {
  const validated = validateVariantInputs({
    variantATitle: args.variantATitle,
    variantBTitle: args.variantBTitle,
    variantAThumbnailUrl: args.variantAThumbnailUrl ?? null,
    variantBThumbnailUrl: args.variantBThumbnailUrl ?? null,
  });
  const youtubeVideoId = args.youtubeVideoId.trim();
  if (!youtubeVideoId) throw new Error('youtubeVideoId is required.');

  const { rows } = await sql<{ id: string }>`
    INSERT INTO ab_tests (
      workspace_id, schedule_item_id, channel_db_id, youtube_video_id,
      variant_a_title, variant_a_thumbnail_url,
      variant_b_title, variant_b_thumbnail_url,
      live_variant, status, ai_model, notes
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.scheduleItemId}::uuid,
      ${args.channelDbId}::uuid,
      ${youtubeVideoId},
      ${validated.variantATitle},
      ${validated.variantAThumbnailUrl},
      ${validated.variantBTitle},
      ${validated.variantBThumbnailUrl},
      'a',
      'draft',
      ${args.aiModel ?? null},
      ${args.notes ?? null}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

// The `sql` template tag refuses to accept a raw string for the SELECT
// projection, so the column list below is duplicated across getAbTest +
// listAbTests. If you add or rename a column on `ab_tests`, update every
// SELECT in lock-step.

export async function getAbTest(id: string, workspaceId: string): Promise<AbTestRow | null> {
  const { rows } = await sql<AbTestRow>`
    SELECT
      id, workspace_id, schedule_item_id, channel_db_id, youtube_video_id,
      variant_a_title, variant_a_thumbnail_url,
      variant_b_title, variant_b_thumbnail_url,
      live_variant, winner, status,
      ai_model, notes,
      started_at::text AS started_at,
      last_swapped_at::text AS last_swapped_at,
      concluded_at::text AS concluded_at,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM ab_tests
    WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listAbTests(
  workspaceId: string,
  opts: { scheduleItemId?: string; youtubeVideoId?: string; limit?: number } = {},
): Promise<AbTestRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.scheduleItemId) {
    const { rows } = await sql<AbTestRow>`
      SELECT
        id, workspace_id, schedule_item_id, channel_db_id, youtube_video_id,
        variant_a_title, variant_a_thumbnail_url,
        variant_b_title, variant_b_thumbnail_url,
        live_variant, winner, status,
        ai_model, notes,
        started_at::text AS started_at,
        last_swapped_at::text AS last_swapped_at,
        concluded_at::text AS concluded_at,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM ab_tests
      WHERE workspace_id = ${workspaceId}::uuid
        AND schedule_item_id = ${opts.scheduleItemId}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.youtubeVideoId) {
    const { rows } = await sql<AbTestRow>`
      SELECT
        id, workspace_id, schedule_item_id, channel_db_id, youtube_video_id,
        variant_a_title, variant_a_thumbnail_url,
        variant_b_title, variant_b_thumbnail_url,
        live_variant, winner, status,
        ai_model, notes,
        started_at::text AS started_at,
        last_swapped_at::text AS last_swapped_at,
        concluded_at::text AS concluded_at,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM ab_tests
      WHERE workspace_id = ${workspaceId}::uuid
        AND youtube_video_id = ${opts.youtubeVideoId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<AbTestRow>`
    SELECT
      id, workspace_id, schedule_item_id, channel_db_id, youtube_video_id,
      variant_a_title, variant_a_thumbnail_url,
      variant_b_title, variant_b_thumbnail_url,
      live_variant, winner, status,
      ai_model, notes,
      started_at::text AS started_at,
      last_swapped_at::text AS last_swapped_at,
      concluded_at::text AS concluded_at,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM ab_tests
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function deleteAbTest(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM ab_tests
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}

export async function listAbTestSnapshots(
  abTestId: string,
  workspaceId: string,
): Promise<AbTestSnapshotRow[]> {
  const { rows } = await sql<AbTestSnapshotRow>`
    SELECT
      id, workspace_id, ab_test_id, variant,
      captured_at::text AS captured_at,
      impressions, views, ctr_percentage,
      average_view_duration_seconds, average_view_percentage,
      subscribers_gained, raw
    FROM ab_test_snapshots
    WHERE ab_test_id = ${abTestId}::uuid AND workspace_id = ${workspaceId}::uuid
    ORDER BY captured_at ASC
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Variant push
// ---------------------------------------------------------------------------

export interface SwapVariantArgs {
  id: string;
  workspaceId: string;
  toVariant: AbTestVariant;
  /** Skip thumbnail upload even when the variant has a thumbnail URL. Used
   *  for thumbnail-less tests (title-only A/B) and for retrying after a
   *  successful snippet update + failed thumbnail. */
  skipThumbnail?: boolean;
}

export interface SwapVariantResult {
  test: AbTestRow;
  push: PushVariantResult;
}

/**
 * Push variant A or B live on the underlying YouTube video. Updates the
 * row's `live_variant`, `last_swapped_at`, and (on first push) flips
 * status from 'draft' to 'running'.
 *
 * The caller MUST already have OAuth set up for the test's channel — we
 * resolve the access token via `getValidAccessToken(channel_db_id)`.
 */
export async function swapAbTestVariant(args: SwapVariantArgs): Promise<SwapVariantResult> {
  if (!isAbTestVariant(args.toVariant)) {
    throw new Error(`Invalid toVariant: ${String(args.toVariant)}`);
  }
  const test = await getAbTest(args.id, args.workspaceId);
  if (!test) throw new Error('A/B test not found in this workspace.');
  if (test.status === 'concluded') {
    throw new Error('A/B test is concluded — cannot swap variants. Reopen by deleting + recreating.');
  }
  if (!test.channel_db_id) {
    throw new Error('A/B test has no associated channel — cannot push to YouTube.');
  }

  const accessToken = await getValidAccessToken(test.channel_db_id);
  if (!accessToken) {
    throw new Error('YouTube OAuth not connected for this channel — connect before swapping.');
  }

  const variantTitle = args.toVariant === 'a' ? test.variant_a_title : test.variant_b_title;
  const variantThumb = args.toVariant === 'a' ? test.variant_a_thumbnail_url : test.variant_b_thumbnail_url;

  let thumbnailPayload: { buffer: Buffer; mimeType: string } | undefined;
  if (variantThumb && !args.skipThumbnail) {
    const downloaded = await downloadThumbnailForUpload(variantThumb);
    if (!downloaded) {
      logger.warn('ab-test: thumbnail download failed, swapping snippet only', {
        abTestId: args.id,
        variantThumb,
      });
    } else {
      thumbnailPayload = downloaded;
    }
  }

  const push = await pushVariantToYoutube({
    accessToken,
    videoId: test.youtube_video_id,
    title: variantTitle,
    thumbnail: thumbnailPayload,
  });

  if (push.snippet && !push.snippet.success) {
    throw new Error(`YouTube snippet update failed: ${push.snippet.error ?? 'unknown error'}`);
  }

  const nextStatus: AbTestStatus = test.status === 'draft' ? 'running' : test.status;
  // First push transitions draft → running and stamps started_at; subsequent
  // pushes leave started_at alone via COALESCE.
  const startedAtForFirstPush = test.status === 'draft' ? new Date().toISOString() : null;

  await sql`
    UPDATE ab_tests
       SET live_variant = ${args.toVariant},
           status = ${nextStatus},
           started_at = COALESCE(started_at, ${startedAtForFirstPush}::timestamptz),
           last_swapped_at = NOW(),
           updated_at = NOW()
     WHERE id = ${args.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;

  const updated = (await getAbTest(args.id, args.workspaceId))!;
  return { test: updated, push };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface RecordSnapshotArgs {
  id: string;
  workspaceId: string;
}

/**
 * Pull the latest analytics for the test's underlying YouTube video,
 * tag the result with whichever variant is currently live, and append
 * a snapshot row. Returns the inserted snapshot.
 */
export async function recordAbTestSnapshot(args: RecordSnapshotArgs): Promise<AbTestSnapshotRow> {
  const test = await getAbTest(args.id, args.workspaceId);
  if (!test) throw new Error('A/B test not found in this workspace.');
  if (test.status === 'draft') {
    throw new Error('A/B test has not been started — push a variant live before snapshotting.');
  }
  if (!test.channel_db_id) {
    throw new Error('A/B test has no associated channel — cannot pull metrics.');
  }

  // Resolve the channel's YouTube external id (UC…). The Analytics API needs
  // it; the Data API doesn't. Either way `channel_db_id` is the FK and the
  // external id is on the row.
  const channelLookup = await sql<{ channel_id: string }>`
    SELECT channel_id
      FROM channels
     WHERE id = ${test.channel_db_id}::uuid
       AND workspace_id = ${args.workspaceId}::uuid
     LIMIT 1
  `;
  const youtubeChannelId = channelLookup.rows[0]?.channel_id ?? null;

  const analytics = await syncVideoAnalytics({
    workspaceId: args.workspaceId,
    channelDbId: test.channel_db_id,
    scheduleItemId: test.schedule_item_id,
    youtubeChannelId,
    youtubeVideoId: test.youtube_video_id,
  });

  const { rows } = await sql<AbTestSnapshotRow>`
    INSERT INTO ab_test_snapshots (
      workspace_id, ab_test_id, variant,
      impressions, views, ctr_percentage,
      average_view_duration_seconds, average_view_percentage,
      subscribers_gained, raw
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.id}::uuid,
      ${test.live_variant},
      ${analytics.impressions ?? null},
      ${analytics.views ?? null},
      ${analytics.ctr_percentage ?? null},
      ${analytics.average_view_duration_seconds ?? null},
      ${analytics.average_view_percentage ?? null},
      ${analytics.subscribers_gained ?? null},
      ${JSON.stringify({ source: 'ab-test-snapshot', live_variant: test.live_variant })}::jsonb
    )
    RETURNING
      id, workspace_id, ab_test_id, variant,
      captured_at::text AS captured_at,
      impressions, views, ctr_percentage,
      average_view_duration_seconds, average_view_percentage,
      subscribers_gained, raw
  `;
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// Conclude
// ---------------------------------------------------------------------------

export interface ConcludeAbTestArgs {
  id: string;
  workspaceId: string;
  winner: AbTestVariant;
  /** When true, push the winning variant live before flipping status. Default true. */
  pushWinnerLive?: boolean;
}

export async function concludeAbTest(args: ConcludeAbTestArgs): Promise<AbTestRow> {
  if (!isAbTestVariant(args.winner)) {
    throw new Error(`Invalid winner: ${String(args.winner)}`);
  }
  const test = await getAbTest(args.id, args.workspaceId);
  if (!test) throw new Error('A/B test not found in this workspace.');
  if (test.status === 'concluded') {
    throw new Error('A/B test is already concluded.');
  }

  if (args.pushWinnerLive !== false && test.live_variant !== args.winner) {
    // Push winner first; if push fails we surface the error and DON'T mark
    // concluded — operator gets a chance to retry without lying about state.
    if (!test.channel_db_id) {
      throw new Error('Cannot push winner: no associated channel.');
    }
    const accessToken = await getValidAccessToken(test.channel_db_id);
    if (!accessToken) {
      throw new Error('Cannot push winner: YouTube OAuth not connected for this channel.');
    }
    const variantTitle = args.winner === 'a' ? test.variant_a_title : test.variant_b_title;
    const variantThumb = args.winner === 'a' ? test.variant_a_thumbnail_url : test.variant_b_thumbnail_url;
    let thumbnailPayload: { buffer: Buffer; mimeType: string } | undefined;
    if (variantThumb) {
      const downloaded = await downloadThumbnailForUpload(variantThumb);
      if (downloaded) thumbnailPayload = downloaded;
    }
    const snippet = await updateYoutubeVideoSnippet({
      accessToken,
      videoId: test.youtube_video_id,
      patch: { title: variantTitle },
    });
    if (!snippet.success) {
      throw new Error(`Cannot conclude — snippet push failed: ${snippet.error ?? 'unknown error'}`);
    }
    if (thumbnailPayload) {
      // Best-effort: a thumbnail failure here doesn't block conclusion.
      await pushVariantToYoutube({
        accessToken,
        videoId: test.youtube_video_id,
        thumbnail: thumbnailPayload,
      });
    }
  }

  await sql`
    UPDATE ab_tests
       SET winner = ${args.winner},
           live_variant = ${args.winner},
           status = 'concluded',
           concluded_at = NOW(),
           updated_at = NOW()
     WHERE id = ${args.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;

  return (await getAbTest(args.id, args.workspaceId))!;
}
