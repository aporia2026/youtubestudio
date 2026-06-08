/**
 * Static list of YouTube video categories available for upload via the
 * Data API v3. Sourced from `videoCategories.list?regionCode=US`
 * (verified 2026-06-08) and baked in here so the picker dropdown does
 * not require a per-session API call.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Only IDs with `snippet.assignable=true` are included — categories
 * like "Movies" or "Trailers" exist in the API but the API refuses
 * `videos.insert` requests that use them, so excluding them up-front
 * keeps the UI clean and avoids opaque 400 errors at upload time.
 *
 * Category IDs are region-stable for the assignable subset (US is the
 * canonical reference). Localised category names (region-specific
 * translations) are NOT in scope — the picker shows English labels.
 *
 * If YouTube adds or removes an assignable category, update this file
 * and the unit test that asserts shape; there is no DB migration
 * needed because category IDs are stored as opaque strings on the
 * short's `youtube_metadata.categoryId`.
 */

/** One YouTube video category, in the shape the picker consumes. */
export interface YoutubeCategory {
  /** Numeric ID as a string — matches what `videos.insert.snippet.categoryId`
   *  expects (the API field is documented as a string even though all
   *  observed values are numeric). */
  id: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** Common-use hint surfaced as a hover/help text — gives the lazy
   *  user a sense of "is this the right category for my short?"
   *  without having to dig into YouTube's category guidance. */
  hint: string;
}

/** The full list, ordered by ID so a future addition appears in the
 *  natural numeric slot rather than at the bottom. */
export const YOUTUBE_CATEGORIES: readonly YoutubeCategory[] = Object.freeze([
  { id: '1', label: 'Film & Animation', hint: 'Short films, animated clips, trailers, behind-the-scenes' },
  { id: '2', label: 'Autos & Vehicles', hint: 'Car reviews, motorcycle content, driving' },
  { id: '10', label: 'Music', hint: 'Music videos, covers, performances' },
  { id: '15', label: 'Pets & Animals', hint: 'Pet content, wildlife, animal training' },
  { id: '17', label: 'Sports', hint: 'Highlights, analysis, fitness, athletics' },
  { id: '19', label: 'Travel & Events', hint: 'Travel vlogs, cultural events, destinations' },
  { id: '20', label: 'Gaming', hint: 'Gameplay, reviews, esports' },
  { id: '22', label: 'People & Blogs', hint: 'Personal vlogs, lifestyle, daily life — common default for talking-head content' },
  { id: '23', label: 'Comedy', hint: 'Sketches, stand-up, funny clips' },
  { id: '24', label: 'Entertainment', hint: 'General entertainment, reactions, interviews' },
  { id: '25', label: 'News & Politics', hint: 'Current events, commentary, analysis' },
  { id: '26', label: 'Howto & Style', hint: 'Tutorials, DIY, fashion, beauty' },
  { id: '27', label: 'Education', hint: 'Explainers, lessons, courses — typical default for paint/doodle explainer shorts' },
  { id: '28', label: 'Science & Technology', hint: 'Science explainers, tech reviews, engineering' },
  { id: '29', label: 'Nonprofits & Activism', hint: 'Cause-driven content, fundraising, awareness' },
]);

/** Sentinel default — most short-form explainer content fits "Education".
 *  The picker uses this when the user has no per-batch / per-workspace
 *  default set. Surfaced as a constant so a future settings panel can
 *  reference the same value without re-stating the magic ID. */
export const DEFAULT_YOUTUBE_CATEGORY_ID: string = '27';

/** Lookup helper — returns null for unknown IDs (e.g. a stale row
 *  pointing at a removed category) so callers can degrade gracefully
 *  instead of crashing the picker. */
export function findYoutubeCategory(id: string | null | undefined): YoutubeCategory | null {
  if (!id) return null;
  return YOUTUBE_CATEGORIES.find((c) => c.id === id) ?? null;
}

/** True if the supplied id is one of the assignable category IDs. The
 *  uploader uses this to refuse a bad `youtube_metadata.categoryId`
 *  before it hits YouTube and comes back as an opaque 400. */
export function isValidYoutubeCategoryId(id: string | null | undefined): boolean {
  return findYoutubeCategory(id) !== null;
}
