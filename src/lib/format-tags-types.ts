/**
 * Client-safe types + constants for the Phase 9.4 format tagger.
 *
 * Lives separately from `format-tags.ts` so the catalog explorer
 * (a `'use client'` component) can import `VIDEO_FORMATS` and
 * `VideoFormat` without pulling in the AI / DB / logger stack that
 * the server-side tagger uses. Same split as
 * `retention-predictor-types.ts` ↔ `retention-predictor.ts`.
 *
 * No DB, no AI, no Node built-ins — fully browser-safe.
 */

/**
 * The fixed enum of formats. Application-validated; the column is
 * TEXT in Postgres (not an enum type) because adding a value to a
 * Postgres enum requires a migration, and we want to evolve this set
 * without one.
 */
export const VIDEO_FORMATS = [
  'explainer',
  'list',
  'story',
  'tutorial',
  'commentary',
  'interview',
  'vlog',
  'showcase',
  'other',
] as const;

export type VideoFormat = (typeof VIDEO_FORMATS)[number];

const VIDEO_FORMAT_SET = new Set<VideoFormat>(VIDEO_FORMATS);

export function isVideoFormat(s: string): s is VideoFormat {
  return VIDEO_FORMAT_SET.has(s as VideoFormat);
}

/**
 * Per-format aggregate from `aggregateFormatStats` — surfaced on the
 * dashboard's FormatAttributionCard. Lives here (not in
 * `format-tags.ts`) so the client card can import without dragging
 * the AI / DB / logger stack into the browser bundle.
 */
export interface FormatStats {
  format: VideoFormat;
  video_count: number;
  /** Mean AVP across the videos in this bucket. Null when none of
   *  the videos had AVP synced. */
  mean_avp: number | null;
  /** Mean CTR across the videos in this bucket. */
  mean_ctr: number | null;
  /** Mean view count across the videos. */
  mean_views: number | null;
}
