'use client';

/**
 * CSV export for niche favorites.
 *
 * Two exports:
 *   - `exportFavoritesCSV`        — every live favorite, one row per niche.
 *                                   Plus a sibling `<name>-videos.csv` containing
 *                                   every proof video flattened with its niche slug.
 *   - `exportSingleFavoriteCSV`   — one favorite + its proof videos, in a single
 *                                   file with a niche header row and the videos
 *                                   listed beneath.
 *
 * The visual richness of the export (status colors, heat bands,
 * inline thumbnails, glossary footer, the Niche-Brief section) lives
 * in the Google Sheets export landing in PR3. CSV is the lowest-
 * common-denominator format and stays text-only by design.
 *
 * Pattern mirrors src/lib/schedule-export.ts.
 */
import {
  isPlaceholderScores,
  type NicheFavoriteRow,
  type NicheFavoriteVideoRow,
  type NicheFavoriteWithVideos,
} from './favorites';

function sanitize(name: string): string {
  return (name || 'favorites')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .toLowerCase();
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowToCSV(values: unknown[]): string {
  return values.map(csvEscape).join(',');
}

function download(content: string, filename: string, mimeType = 'text/csv'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtMonetization(f: NicheFavoriteRow): string {
  if (isPlaceholderScores(f.scores)) return '';
  const lo = f.scores.monetization.lowUsdPerMille;
  const hi = f.scores.monetization.highUsdPerMille;
  if (lo === 0 && hi === 0) return '';
  return `$${lo.toFixed(0)}–$${hi.toFixed(0)} per 1k views`;
}

const NICHE_HEADERS = [
  'Niche',
  'Slug',
  'Status',
  'Source tab',
  'Demand',
  'Crowdedness',
  'Monetization',
  'Fit',
  'Promise score',
  'Videos saved',
  'Verdict',
  'Verdict reason',
  'Outcome',
  'Outcome video',
  'Outcome reason',
  'Notes',
  'Created',
  'Updated',
] as const;

function nicheRow(f: NicheFavoriteWithVideos): (string | number)[] {
  const placeholder = isPlaceholderScores(f.scores);
  return [
    f.niche_name,
    f.niche_slug,
    f.status,
    f.source_tab,
    placeholder ? '' : f.scores.demand.label,
    placeholder ? '' : f.scores.supply.label,
    fmtMonetization(f),
    placeholder ? '' : f.scores.fit.label,
    '', // promise_score — populates from briefs table in PR2
    f.videos.filter((v) => !v.is_removed_upstream).length,
    f.verdict ?? '',
    f.verdict_reason ?? '',
    f.outcome ?? '',
    f.outcome_video_id ?? '',
    f.outcome_reason ?? '',
    f.notes ?? '',
    fmtDate(f.created_at),
    fmtDate(f.updated_at),
  ];
}

const VIDEO_HEADERS = [
  'Niche',
  'Niche slug',
  'Video title',
  'Video ID',
  'YouTube URL',
  'Channel',
  'Channel ID',
  'Subscriber count',
  'View count',
  'Outlier score',
  'Classification',
  'Published',
  'Duration',
  'Added',
  'Status upstream',
] as const;

function videoRow(
  f: { niche_name: string; niche_slug: string },
  v: NicheFavoriteVideoRow,
): (string | number)[] {
  return [
    f.niche_name,
    f.niche_slug,
    v.title,
    v.video_id,
    `https://www.youtube.com/watch?v=${v.video_id}`,
    v.channel_title ?? '',
    v.channel_id,
    v.subscriber_count ?? '',
    v.view_count ?? '',
    v.outlier_score == null ? '' : v.outlier_score.toFixed(2),
    v.classification ?? '',
    fmtDate(v.published_at),
    v.duration_iso ?? '',
    fmtDate(v.added_at),
    v.is_removed_upstream ? 'removed' : 'live',
  ];
}

/** Export every live favorite as a CSV pair: one file per niche
 *  row + a second file (`-videos.csv`) flattening every proof video.
 *  Two files because mixing niche rows and video rows in one CSV
 *  produces an inconsistent column set — viewers (Numbers, Excel,
 *  Google Sheets import) cope poorly. */
export function exportFavoritesCSV(favorites: NicheFavoriteWithVideos[]): void {
  const today = new Date().toISOString().slice(0, 10);

  // Niches file.
  const nicheCsv = [
    rowToCSV([...NICHE_HEADERS]),
    ...favorites.map((f) => rowToCSV(nicheRow(f))),
  ].join('\n');
  download(nicheCsv, `niche-favorites-${today}.csv`, 'text/csv');

  // Videos file — only when there's at least one video across all
  // favorites. Otherwise the second download is just noise.
  const hasVideos = favorites.some((f) => f.videos.length > 0);
  if (hasVideos) {
    const videoCsv = [
      rowToCSV([...VIDEO_HEADERS]),
      ...favorites.flatMap((f) =>
        f.videos.map((v) => rowToCSV(videoRow({ niche_name: f.niche_name, niche_slug: f.niche_slug }, v))),
      ),
    ].join('\n');
    download(videoCsv, `niche-favorites-videos-${today}.csv`, 'text/csv');
  }
}

/** Export a single favorite + its proof videos in one file. The
 *  niche header row comes first; a blank row separates; then the
 *  proof videos. Mixing two header shapes in one file is acceptable
 *  here because the operator knows the file is about ONE niche. */
export function exportSingleFavoriteCSV(favorite: NicheFavoriteWithVideos): void {
  const today = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];

  sections.push(rowToCSV([...NICHE_HEADERS]));
  sections.push(rowToCSV(nicheRow(favorite)));

  if (favorite.videos.length > 0) {
    sections.push(''); // blank line separator
    sections.push(rowToCSV([...VIDEO_HEADERS]));
    for (const v of favorite.videos) {
      sections.push(rowToCSV(videoRow({ niche_name: favorite.niche_name, niche_slug: favorite.niche_slug }, v)));
    }
  }

  const csv = sections.join('\n');
  download(csv, `niche-favorite-${sanitize(favorite.niche_slug)}-${today}.csv`, 'text/csv');
}
