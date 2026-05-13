/**
 * Server-side helper that prepares the input bundle for
 * `createFavoritesSheet`. Lives in lib/ rather than inline in each
 * route so the all/single/compare endpoints share the same data
 * assembly path (and the same brief-by-slug lookup pattern).
 */
import { sql } from '@vercel/postgres';
import {
  listFavoritesWithVideos,
  getFavorite,
  listFavoriteVideos,
  type NicheFavoriteWithVideos,
} from './favorites';
import { getActiveBrief, getMonthlyBriefSpend, type BriefRow } from './brief-db';
import { slugifyNiche } from './slug';
import type { FavoritesSheetInput, FavoritesSheetMode } from '@/lib/google-sheets-favorites';

/** Resolve the workspace's display label — the workspace name when
 *  available, otherwise a short prefix of the workspace UUID so the
 *  export title isn't blank. */
async function resolveWorkspaceLabel(workspaceId: string): Promise<string> {
  try {
    const { rows } = await sql<{ name: string | null }>`
      SELECT name FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
    `;
    const name = rows[0]?.name?.trim();
    return name && name.length > 0 ? name : `Workspace ${workspaceId.slice(0, 8)}`;
  } catch {
    return `Workspace ${workspaceId.slice(0, 8)}`;
  }
}

/** Look up the most-recent 'ready' brief for every favorite in the
 *  list. Runs in parallel to keep the export latency bounded; capped
 *  at the favorites passed in (no extra fan-out). */
async function loadBriefsByNicheSlug(
  workspaceId: string,
  favorites: NicheFavoriteWithVideos[],
): Promise<Record<string, BriefRow | null>> {
  const entries = await Promise.all(
    favorites.map(async (f) => {
      const brief = await getActiveBrief(workspaceId, f.niche_slug);
      return [f.niche_slug, brief] as const;
    }),
  );
  const map: Record<string, BriefRow | null> = {};
  for (const [slug, brief] of entries) map[slug] = brief;
  return map;
}

/** Bundle ALL live favorites + their briefs into the Sheets-input shape. */
export async function buildAllFavoritesInput(
  workspaceId: string,
): Promise<FavoritesSheetInput> {
  const [favorites, workspaceLabel, monthlySpendUsd] = await Promise.all([
    listFavoritesWithVideos(workspaceId),
    resolveWorkspaceLabel(workspaceId),
    getMonthlyBriefSpend(workspaceId),
  ]);
  const briefsByNicheSlug = await loadBriefsByNicheSlug(workspaceId, favorites);
  return {
    workspaceLabel,
    favorites,
    briefsByNicheSlug,
    monthlySpendUsd,
    mode: 'all' as FavoritesSheetMode,
  };
}

/** Bundle a single favorite + its proof videos + brief. */
export async function buildSingleFavoriteInput(
  workspaceId: string,
  rawSlug: string,
): Promise<FavoritesSheetInput | null> {
  const slug = slugifyNiche(rawSlug);
  const favorite = await getFavorite(workspaceId, slug);
  if (!favorite) return null;
  const [videos, workspaceLabel, monthlySpendUsd, brief] = await Promise.all([
    listFavoriteVideos(workspaceId, slug),
    resolveWorkspaceLabel(workspaceId),
    getMonthlyBriefSpend(workspaceId),
    getActiveBrief(workspaceId, slug),
  ]);
  const withVideos: NicheFavoriteWithVideos = { ...favorite, videos };
  return {
    workspaceLabel,
    favorites: [withVideos],
    briefsByNicheSlug: { [slug]: brief },
    monthlySpendUsd,
    mode: 'single' as FavoritesSheetMode,
  };
}

/** Bundle 2–3 selected favorites for a Compare export. The caller
 *  validates the slug count; this fetches in parallel and returns
 *  null if any slug is missing. */
export async function buildCompareInput(
  workspaceId: string,
  rawSlugs: readonly string[],
): Promise<FavoritesSheetInput | null> {
  const slugs = rawSlugs.map(slugifyNiche);
  const [workspaceLabel, monthlySpendUsd, favorites, briefs] = await Promise.all([
    resolveWorkspaceLabel(workspaceId),
    getMonthlyBriefSpend(workspaceId),
    Promise.all(
      slugs.map(async (s) => {
        const f = await getFavorite(workspaceId, s);
        if (!f) return null;
        const videos = await listFavoriteVideos(workspaceId, s);
        return { ...f, videos } as NicheFavoriteWithVideos;
      }),
    ),
    Promise.all(slugs.map((s) => getActiveBrief(workspaceId, s))),
  ]);

  // If any slug is missing the export fails — surface to caller so
  // they can return a clean 404 rather than silently dropping niches.
  if (favorites.some((f) => f === null)) return null;
  const valid = favorites as NicheFavoriteWithVideos[];

  const briefsByNicheSlug: Record<string, BriefRow | null> = {};
  slugs.forEach((s, i) => {
    briefsByNicheSlug[s] = briefs[i];
  });

  return {
    workspaceLabel,
    favorites: valid,
    briefsByNicheSlug,
    monthlySpendUsd,
    mode: 'compare' as FavoritesSheetMode,
  };
}
