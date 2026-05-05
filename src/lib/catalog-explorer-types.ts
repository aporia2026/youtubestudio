/**
 * Client-safe types, constants, and pure normalisers for the Phase 9.7
 * catalog explorer.
 *
 * Lives separately from `catalog-explorer.ts` so the catalog page (a
 * `'use client'` component) can import the filter / sort shape +
 * defensive parsers without pulling in `@vercel/postgres` and the
 * server-side query path. Same split as `retention-predictor-types.ts`
 * ↔ `retention-predictor.ts` and `format-tags-types.ts` ↔
 * `format-tags.ts`.
 *
 * No DB, no AI, no Node built-ins — fully browser-safe.
 */
import { isVideoFormat, type VideoFormat } from './format-tags-types';

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export type SortField =
  | 'published_at'
  | 'views'
  | 'ctr_percentage'
  | 'average_view_percentage'
  | 'subscribers_gained'
  | 'duration_seconds'
  | 'days_since_publish';

export const SORT_FIELDS: SortField[] = [
  'published_at',
  'views',
  'ctr_percentage',
  'average_view_percentage',
  'subscribers_gained',
  'duration_seconds',
  'days_since_publish',
];

export type SortDir = 'asc' | 'desc';

/** Duration buckets that match what creators talk about: shorts,
 *  short-form, mid, long-form. Inclusive lower bound, exclusive upper.
 *  Null upper = unbounded. */
export type DurationBucket = 'shorts' | 'short' | 'mid' | 'long';
export const DURATION_BUCKET_RANGES: Record<DurationBucket, [number, number | null]> = {
  shorts: [0, 60],
  short: [60, 5 * 60],
  mid: [5 * 60, 15 * 60],
  long: [15 * 60, null],
};

export interface CatalogFilter {
  /** Channel db ids (UUIDs). [] = all channels. */
  channelDbIds: string[];
  /** Format tags. [] = no format filter. */
  formats: VideoFormat[];
  /** Duration buckets. [] = no duration filter. */
  durations: DurationBucket[];
  /** YYYY-MM-DD lower bound (inclusive) on published_at. null = no
   *  lower bound. */
  publishedSince: string | null;
  /** YYYY-MM-DD upper bound (exclusive). */
  publishedUntil: string | null;
  /** Min AVP %. null = no filter. */
  avpMin: number | null;
  /** Max AVP %. null = no filter. */
  avpMax: number | null;
  /** Min CTR %. */
  ctrMin: number | null;
  /** Max CTR %. */
  ctrMax: number | null;
  /** When true, only show videos that have a breakout fire. */
  onlyBreakouts: boolean;
}

export interface CatalogSort {
  field: SortField;
  dir: SortDir;
}

export interface CatalogVideoRow {
  youtube_video_id: string;
  channel_id: string | null;
  channel_name: string | null;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  views: number | null;
  ctr_percentage: number | null;
  average_view_percentage: number | null;
  subscribers_gained: number | null;
  format: VideoFormat | null;
  has_breakout: boolean;
  days_since_publish: number | null;
}

export interface SavedView {
  id: string;
  workspace_id: string;
  created_by_user_id: string | null;
  name: string;
  filters: CatalogFilter;
  sort: CatalogSort;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_FILTER: CatalogFilter = {
  channelDbIds: [],
  formats: [],
  durations: [],
  publishedSince: null,
  publishedUntil: null,
  avpMin: null,
  avpMax: null,
  ctrMin: null,
  ctrMax: null,
  onlyBreakouts: false,
};

export const DEFAULT_SORT: CatalogSort = { field: 'published_at', dir: 'desc' };

// ---------------------------------------------------------------------------
// Pure helpers (used by both the client URL/saved-view-loader path AND
// the server route's body parser)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normaliseFilter(input: unknown): CatalogFilter {
  if (!input || typeof input !== 'object') return { ...DEFAULT_FILTER };
  const raw = input as Record<string, unknown>;

  const channelDbIds = Array.isArray(raw.channelDbIds)
    ? raw.channelDbIds.filter((s): s is string => typeof s === 'string' && UUID_RE.test(s))
    : [];

  const formats = Array.isArray(raw.formats)
    ? raw.formats.filter((s): s is VideoFormat => typeof s === 'string' && isVideoFormat(s))
    : [];

  const durations = Array.isArray(raw.durations)
    ? raw.durations.filter(
        (s): s is DurationBucket =>
          typeof s === 'string' &&
          (s === 'shorts' || s === 'short' || s === 'mid' || s === 'long'),
      )
    : [];

  const publishedSince =
    typeof raw.publishedSince === 'string' && ISO_DATE_RE.test(raw.publishedSince)
      ? raw.publishedSince
      : null;
  const publishedUntil =
    typeof raw.publishedUntil === 'string' && ISO_DATE_RE.test(raw.publishedUntil)
      ? raw.publishedUntil
      : null;

  const num = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.max(lo, Math.min(hi, v))
      : null;

  return {
    channelDbIds,
    formats,
    durations,
    publishedSince,
    publishedUntil,
    avpMin: num(raw.avpMin, 0, 100),
    avpMax: num(raw.avpMax, 0, 100),
    ctrMin: num(raw.ctrMin, 0, 100),
    ctrMax: num(raw.ctrMax, 0, 100),
    onlyBreakouts: raw.onlyBreakouts === true,
  };
}

export function normaliseSort(input: unknown): CatalogSort {
  if (!input || typeof input !== 'object') return { ...DEFAULT_SORT };
  const raw = input as { field?: unknown; dir?: unknown };
  const field: SortField =
    typeof raw.field === 'string' && (SORT_FIELDS as string[]).includes(raw.field)
      ? (raw.field as SortField)
      : DEFAULT_SORT.field;
  const dir: SortDir = raw.dir === 'asc' ? 'asc' : 'desc';
  return { field, dir };
}

/**
 * Validate a saved-view name. Pure. Returns trimmed string on
 * success, null on rejection.
 */
export function parseSavedViewName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  return trimmed;
}
