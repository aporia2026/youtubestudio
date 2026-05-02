/**
 * Client-safe A/B test types. Same client/server split pattern as
 * shorts-types / broll-types / dubbing-languages: server-only modules
 * (next/headers via ai.ts, OAuth helpers, fetch against YouTube) live
 * in `src/lib/ab-tests.ts`, while row shapes + enums live here so the
 * UI can import them without dragging the orchestration layer into
 * the browser bundle.
 */

export type AbTestStatus = 'draft' | 'running' | 'concluded';
export type AbTestVariant = 'a' | 'b';

/** `ab_tests` row shape — mirrors migration 0024. */
export interface AbTestRow {
  id: string;
  workspace_id: string;
  schedule_item_id: string | null;
  channel_db_id: string | null;
  youtube_video_id: string;

  variant_a_title: string;
  variant_a_thumbnail_url: string | null;
  variant_b_title: string;
  variant_b_thumbnail_url: string | null;

  live_variant: AbTestVariant;
  winner: AbTestVariant | null;
  status: AbTestStatus;

  ai_model: string | null;
  notes: string | null;

  started_at: string | null;
  last_swapped_at: string | null;
  concluded_at: string | null;
  created_at: string;
  updated_at: string;
}

/** `ab_test_snapshots` row shape — mirrors migration 0024. */
export interface AbTestSnapshotRow {
  id: string;
  workspace_id: string;
  ab_test_id: string;
  variant: AbTestVariant;
  captured_at: string;

  impressions: number | null;
  views: number | null;
  ctr_percentage: number | null;
  average_view_duration_seconds: number | null;
  average_view_percentage: number | null;
  subscribers_gained: number | null;

  raw: Record<string, unknown>;
}

/**
 * Aggregated per-variant view across all snapshots of a test. Computed
 * on read by `getAbTestWithSnapshots`. The aggregation is "last value
 * wins" for each metric within a variant — YouTube Analytics returns
 * cumulative totals from publish, so the most recent snapshot is the
 * truthful one. Each field is null until at least one snapshot for
 * that variant has been recorded.
 */
export interface AbTestVariantSummary {
  variant: AbTestVariant;
  snapshot_count: number;
  latest_captured_at: string | null;
  impressions: number | null;
  views: number | null;
  ctr_percentage: number | null;
  average_view_duration_seconds: number | null;
  subscribers_gained: number | null;
}

/** Validate an arbitrary string against the AbTestVariant union. */
export function isAbTestVariant(value: unknown): value is AbTestVariant {
  return value === 'a' || value === 'b';
}

export const AB_TEST_TITLE_MAX_LENGTH = 100;
export const AB_TEST_DESCRIPTION_MAX_LENGTH = 5000;
