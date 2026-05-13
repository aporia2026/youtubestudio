/**
 * Persistence layer for the hierarchical niche taxonomy
 * (migration 0061).
 *
 * Two tables:
 *
 *   niche_taxonomy_nodes — global tree (workspace-agnostic) of
 *     category → sub-niche → micro-niche names. Editorial content
 *     the system or the AI generates. NULL-safe sibling uniqueness
 *     is enforced via two partial indexes (see migration).
 *
 *   niche_taxonomy_scores — per-(node, workspace) scores. Composite
 *     PK so cross-workspace leakage of YouTube-derived signals is
 *     structurally impossible.
 *
 * Pure DB-layer only — no AI, no HTTP, no domain logic. Inputs are
 * trusted (callers validate at the route boundary).
 */
import { sql } from '@vercel/postgres';
import type { NicheScores } from './types';

export type TaxonomyLevel = 'category' | 'subniche' | 'microniche';
export type TaxonomySource = 'curated' | 'ai' | 'harvested';

/** A taxonomy node row as returned from the DB. */
export interface TaxonomyNodeRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name: string;
  level: TaxonomyLevel;
  source: TaxonomySource;
  language: string;
  region: string;
  rationale: string | null;
  created_at: string;
}

/** A taxonomy node joined with its score for the requesting workspace
 *  (NULL when unscored or stale). Driven by a single LEFT JOIN so the
 *  UI can render every child + its score in one round-trip. */
export interface TaxonomyNodeWithScoreRow extends TaxonomyNodeRow {
  /** NicheScores blob or NULL when the score row doesn't exist for
   *  this (node, workspace). */
  scores: NicheScores | null;
  /** When the score was last computed; NULL when unscored. */
  scored_at: string | null;
  sample_size: number | null;
}

// ---------------------------------------------------------------------------
// Node CRUD
// ---------------------------------------------------------------------------

export interface ListChildrenArgs {
  workspaceId: string;
  /** NULL fetches root-level (category) nodes. */
  parentId: string | null;
  language: string;
  region: string;
}

/** List the children of `parentId` in (language, region), joined with
 *  each one's score for the requesting workspace.
 *
 *  Score freshness is NOT enforced here — the caller is the one that
 *  decides what "stale" means. Stale scores still come back so the UI
 *  can show last-known values while a re-score runs in the background. */
export async function listChildrenWithScores(
  args: ListChildrenArgs,
): Promise<TaxonomyNodeWithScoreRow[]> {
  // Two queries because Postgres handles NULL comparisons differently;
  // the `parent_id IS NULL` vs `parent_id = $1` branch keeps the index
  // selective in both modes.
  if (args.parentId === null) {
    const { rows } = await sql<TaxonomyNodeWithScoreRow>`
      SELECT n.id::text, n.parent_id::text, n.slug, n.name, n.level, n.source,
             n.language, n.region, n.rationale, n.created_at,
             s.scores, s.scored_at, s.sample_size
      FROM niche_taxonomy_nodes n
      LEFT JOIN niche_taxonomy_scores s
        ON s.node_id = n.id AND s.workspace_id = ${args.workspaceId}::uuid
      WHERE n.parent_id IS NULL
        AND n.language = ${args.language}
        AND n.region = ${args.region}
      ORDER BY n.created_at ASC
    `;
    return rows;
  }
  const { rows } = await sql<TaxonomyNodeWithScoreRow>`
    SELECT n.id::text, n.parent_id::text, n.slug, n.name, n.level, n.source,
           n.language, n.region, n.rationale, n.created_at,
           s.scores, s.scored_at, s.sample_size
    FROM niche_taxonomy_nodes n
    LEFT JOIN niche_taxonomy_scores s
      ON s.node_id = n.id AND s.workspace_id = ${args.workspaceId}::uuid
    WHERE n.parent_id = ${args.parentId}::uuid
      AND n.language = ${args.language}
      AND n.region = ${args.region}
    ORDER BY n.created_at ASC
  `;
  return rows;
}

/** Fetch one node by id. Returns null when absent. */
export async function getNode(nodeId: string): Promise<TaxonomyNodeRow | null> {
  const { rows } = await sql<TaxonomyNodeRow>`
    SELECT id::text, parent_id::text, slug, name, level, source,
           language, region, rationale, created_at
    FROM niche_taxonomy_nodes
    WHERE id = ${nodeId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Fetch many nodes by ids in a single round-trip. Order preserved
 *  per the input list — useful when the caller already has a stable
 *  display ordering and doesn't want the DB to re-sort. Uses sql.query
 *  (positional params) because the @vercel/postgres tagged template
 *  doesn't accept array bindings. */
export async function getNodesByIds(nodeIds: readonly string[]): Promise<TaxonomyNodeRow[]> {
  if (nodeIds.length === 0) return [];
  const { rows } = await sql.query<TaxonomyNodeRow>(
    `SELECT id::text, parent_id::text, slug, name, level, source,
            language, region, rationale, created_at
       FROM niche_taxonomy_nodes
      WHERE id = ANY($1::uuid[])`,
    [nodeIds as string[]],
  );
  // Preserve the input order.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return nodeIds.map((id) => byId.get(id)).filter((r): r is TaxonomyNodeRow => !!r);
}

export interface InsertNodeArgs {
  parentId: string | null;
  slug: string;
  name: string;
  level: TaxonomyLevel;
  source: TaxonomySource;
  language: string;
  region: string;
  rationale?: string | null;
}

/** Insert a node. On conflict with the (parent_id|null, slug, language,
 *  region) unique index, returns the existing row instead of failing —
 *  this makes seed + brainstorm idempotent. */
export async function upsertNode(args: InsertNodeArgs): Promise<TaxonomyNodeRow> {
  const rationale = args.rationale?.slice(0, 200) ?? null;
  // Two branches for the same reason as listChildrenWithScores: ON CONFLICT
  // on partial indexes requires the partial WHERE clause to match.
  if (args.parentId === null) {
    const { rows } = await sql<TaxonomyNodeRow>`
      INSERT INTO niche_taxonomy_nodes (
        parent_id, slug, name, level, source, language, region, rationale
      ) VALUES (
        NULL,
        ${args.slug},
        ${args.name.slice(0, 80)},
        ${args.level},
        ${args.source},
        ${args.language},
        ${args.region},
        ${rationale}
      )
      ON CONFLICT (slug, language, region) WHERE parent_id IS NULL
      DO UPDATE SET name = EXCLUDED.name
      RETURNING id::text, parent_id::text, slug, name, level, source,
                language, region, rationale, created_at
    `;
    return rows[0];
  }
  const { rows } = await sql<TaxonomyNodeRow>`
    INSERT INTO niche_taxonomy_nodes (
      parent_id, slug, name, level, source, language, region, rationale
    ) VALUES (
      ${args.parentId}::uuid,
      ${args.slug},
      ${args.name.slice(0, 80)},
      ${args.level},
      ${args.source},
      ${args.language},
      ${args.region},
      ${rationale}
    )
    ON CONFLICT (parent_id, slug, language, region) WHERE parent_id IS NOT NULL
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id::text, parent_id::text, slug, name, level, source,
              language, region, rationale, created_at
  `;
  return rows[0];
}

/** Count children of a node in a locale. Used by the brainstorm gate
 *  (refuses to over-fill above the cap). */
export async function countChildren(
  parentId: string | null,
  language: string,
  region: string,
): Promise<number> {
  if (parentId === null) {
    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n
      FROM niche_taxonomy_nodes
      WHERE parent_id IS NULL
        AND language = ${language}
        AND region = ${region}
    `;
    return Number(rows[0]?.n ?? 0);
  }
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n
    FROM niche_taxonomy_nodes
    WHERE parent_id = ${parentId}::uuid
      AND language = ${language}
      AND region = ${region}
  `;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Score CRUD
// ---------------------------------------------------------------------------

export interface UpsertScoreArgs {
  nodeId: string;
  workspaceId: string;
  scores: NicheScores;
  sampleSize: number;
  sourceUrl?: string | null;
}

/** Upsert a score row for (node_id, workspace_id). Replaces any
 *  existing row in place — the composite PK guarantees one row per
 *  (node, workspace). */
export async function upsertScore(args: UpsertScoreArgs): Promise<void> {
  await sql`
    INSERT INTO niche_taxonomy_scores (
      node_id, workspace_id, scored_at, scores, sample_size, source_url
    ) VALUES (
      ${args.nodeId}::uuid,
      ${args.workspaceId}::uuid,
      NOW(),
      ${JSON.stringify(args.scores)}::jsonb,
      ${args.sampleSize},
      ${args.sourceUrl ?? null}
    )
    ON CONFLICT (node_id, workspace_id) DO UPDATE SET
      scored_at = EXCLUDED.scored_at,
      scores = EXCLUDED.scores,
      sample_size = EXCLUDED.sample_size,
      source_url = EXCLUDED.source_url
  `;
}

/** Fetch the score rows for many nodes at once for the requesting
 *  workspace. Used when the lazy-score endpoint needs to decide which
 *  nodes to re-fetch vs serve from cache. */
export async function getScoresForNodes(
  workspaceId: string,
  nodeIds: readonly string[],
): Promise<Map<string, { scores: NicheScores; scored_at: string; sample_size: number }>> {
  if (nodeIds.length === 0) return new Map();
  const { rows } = await sql.query<{
    node_id: string;
    scores: NicheScores;
    scored_at: string;
    sample_size: number;
  }>(
    `SELECT node_id::text, scores, scored_at, sample_size
       FROM niche_taxonomy_scores
      WHERE workspace_id = $1::uuid
        AND node_id = ANY($2::uuid[])`,
    [workspaceId, nodeIds as string[]],
  );
  const out = new Map<string, { scores: NicheScores; scored_at: string; sample_size: number }>();
  for (const r of rows) {
    out.set(r.node_id, { scores: r.scores, scored_at: r.scored_at, sample_size: r.sample_size });
  }
  return out;
}

/** Score freshness window. A score older than this is considered
 *  stale and the lazy-score endpoint will re-run it on demand. Matches
 *  the discovery cache TTL (7d) so the operator never sees mixed-age
 *  data on the same page. */
export const SCORE_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

/** True when a score row is fresh enough to skip re-fetching. */
export function isScoreFresh(scoredAt: string | null): boolean {
  if (!scoredAt) return false;
  const t = Date.parse(scoredAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < SCORE_FRESHNESS_MS;
}

// ---------------------------------------------------------------------------
// Cross-category scan helpers
// ---------------------------------------------------------------------------

/** A scored leaf-or-near-leaf node with enough ancestor info to render
 *  a category breadcrumb in the UI. Used by the cross-category sweet-
 *  spot scanner. `grandparent_name` is NULL when the node is a sub-
 *  niche (only one level above it to walk). */
export interface ScoredNodeWithPath {
  id: string;
  slug: string;
  name: string;
  level: TaxonomyLevel;
  rationale: string | null;
  parent_id: string | null;
  parent_name: string | null;
  grandparent_id: string | null;
  grandparent_name: string | null;
  scores: NicheScores;
  sample_size: number;
  scored_at: string;
}

/** Pull every scored sub-niche + micro-niche for a workspace in a
 *  given locale, joined with up to two levels of ancestor name. Used
 *  by the cross-category sweet-spot scanner — no YouTube / no AI
 *  calls, this is a pure cached-data read.
 *
 *  Category-level nodes are excluded (they're navigation, not
 *  destinations, and never have score rows in the first place). */
export async function listScoredLeavesForLocale(args: {
  workspaceId: string;
  language: string;
  region: string;
}): Promise<ScoredNodeWithPath[]> {
  const { rows } = await sql<ScoredNodeWithPath>`
    SELECT
      n.id::text,
      n.slug,
      n.name,
      n.level,
      n.rationale,
      n.parent_id::text,
      p.name AS parent_name,
      p.parent_id::text AS grandparent_id,
      g.name AS grandparent_name,
      s.scores,
      s.sample_size,
      s.scored_at
    FROM niche_taxonomy_nodes n
    INNER JOIN niche_taxonomy_scores s
      ON s.node_id = n.id AND s.workspace_id = ${args.workspaceId}::uuid
    LEFT JOIN niche_taxonomy_nodes p ON p.id = n.parent_id
    LEFT JOIN niche_taxonomy_nodes g ON g.id = p.parent_id
    WHERE n.language = ${args.language}
      AND n.region = ${args.region}
      AND n.level IN ('subniche', 'microniche')
    ORDER BY s.scored_at DESC
  `;
  return rows;
}

/** Find the N stalest scored nodes across all workspaces. Used by the
 *  nightly sweep cron to prioritise re-scoring. Skips nodes whose
 *  scores are still fresh; orders by `scored_at` ascending so the
 *  oldest scores get refreshed first. */
export interface StaleScoreRow {
  workspace_id: string;
  node_id: string;
  scored_at: string;
}

export async function listStalestScores(limit: number): Promise<StaleScoreRow[]> {
  const cutoffMs = Date.now() - SCORE_FRESHNESS_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const { rows } = await sql<StaleScoreRow>`
    SELECT workspace_id::text, node_id::text, scored_at
    FROM niche_taxonomy_scores
    WHERE scored_at < ${cutoffIso}::timestamptz
    ORDER BY scored_at ASC
    LIMIT ${limit}
  `;
  return rows;
}
