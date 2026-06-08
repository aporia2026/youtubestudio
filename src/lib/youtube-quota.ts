/**
 * Per-channel-per-UTC-day YouTube Data API quota charge tracker.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Backed by the `youtube_quota_usage` table from migration 0124.
 *
 * Important caveat: Google is the authoritative source of remaining
 * quota. This counter is APPROXIMATE — it only sees charges issued
 * through this app's uploader. Other systems (manual API calls, a
 * sibling deployment) burning quota from the same Google Cloud
 * project will not show up here. The UI labels the meter
 * "Approximate" and links to the Google Cloud Console quota page
 * for the authoritative number.
 *
 * Conservative semantics: record the charge BEFORE the API call.
 * Matches YouTube's behavior — a failed `videos.insert` still costs
 * quota — and means a function crash mid-upload still leaves the
 * counter correct.
 *
 * Quota cost reference (verified 2026-06-08):
 *   videos.insert        100 units  (was 1,600 before 2025-12-04)
 *   videos.update         50 units
 *   playlistItems.insert  50 units
 *   playlists.list         1 unit
 *   videos.list            1 unit
 *
 * Default per-project quota is 10,000 units/day (Google Cloud
 * Console; can be increased on application). UTC day boundary is
 * Google's reset point.
 */
import { sql } from '@vercel/postgres';

/** Default daily quota from a fresh Google Cloud project. Surfaced
 *  here so the UI doesn't have to hardcode it. Workspaces with a
 *  granted quota increase can override this via a future setting,
 *  but the default is correct for the typical user. */
export const YOUTUBE_DEFAULT_DAILY_QUOTA_UNITS = 10_000;

export interface QuotaUsageSnapshot {
  channelId: string;
  utcDate: string; // YYYY-MM-DD
  unitsCharged: number;
  chargeCount: number;
  remainingUnits: number;
  estimatedRemainingUploads: number;
}

/** Helper to compute today's UTC date string in YYYY-MM-DD form. The
 *  DB column is `DATE`, so we never serialise time-of-day. */
export function currentUtcDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Record a quota charge for the channel. Upserts the (channel_id,
 * utc_date) row atomically — safe under concurrent uploads from the
 * same channel.
 *
 * The `units` arg should match the documented cost of the call being
 * made (use `VIDEOS_INSERT_QUOTA_UNITS` from `youtube-upload.ts` for
 * insert calls). Returns the post-charge snapshot so the caller can
 * surface "X uploads left today" to the user.
 */
export async function recordUploadCharge(args: {
  channelId: string;
  units: number;
  now?: Date;
}): Promise<QuotaUsageSnapshot> {
  const { channelId, units } = args;
  const utcDate = currentUtcDate(args.now);

  console.info('[shorts-upload quota]', {
    channel_id: channelId,
    utc_date: utcDate,
    units_charged: units,
  });

  await sql`
    INSERT INTO youtube_quota_usage (channel_id, utc_date, units_charged, charge_count, updated_at)
    VALUES (${channelId}::uuid, ${utcDate}::date, ${units}, 1, NOW())
    ON CONFLICT (channel_id, utc_date) DO UPDATE SET
      units_charged = youtube_quota_usage.units_charged + EXCLUDED.units_charged,
      charge_count  = youtube_quota_usage.charge_count + 1,
      updated_at    = NOW()
  `;

  return getQuotaUsage({ channelId, now: args.now });
}

/**
 * Read-only snapshot for the UI meter. Returns a zeroed snapshot if
 * no charges have been recorded today.
 */
export async function getQuotaUsage(args: {
  channelId: string;
  now?: Date;
}): Promise<QuotaUsageSnapshot> {
  const { channelId } = args;
  const utcDate = currentUtcDate(args.now);

  const { rows } = await sql<{ units_charged: number; charge_count: number }>`
    SELECT units_charged, charge_count
      FROM youtube_quota_usage
     WHERE channel_id = ${channelId}::uuid AND utc_date = ${utcDate}::date
     LIMIT 1
  `;

  const unitsCharged = rows[0]?.units_charged ?? 0;
  const chargeCount = rows[0]?.charge_count ?? 0;
  return computeSnapshot(channelId, utcDate, unitsCharged, chargeCount);
}

/** Pure helper — exposed so unit tests can verify the math without a
 *  DB round-trip. The "estimated remaining uploads" is conservative:
 *  assumes the next call is a `videos.insert` (the most expensive
 *  uploader-side op at 100 units). */
export function computeSnapshot(
  channelId: string,
  utcDate: string,
  unitsCharged: number,
  chargeCount: number,
  dailyQuota: number = YOUTUBE_DEFAULT_DAILY_QUOTA_UNITS,
  costPerUpload: number = 100,
): QuotaUsageSnapshot {
  const remainingUnits = Math.max(0, dailyQuota - unitsCharged);
  const estimatedRemainingUploads = Math.floor(remainingUnits / costPerUpload);
  return {
    channelId,
    utcDate,
    unitsCharged,
    chargeCount,
    remainingUnits,
    estimatedRemainingUploads,
  };
}
