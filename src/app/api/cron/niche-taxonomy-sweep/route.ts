/**
 * Vercel cron entry — nightly stale-score sweep for the hierarchical
 * niche taxonomy (migration 0061 schema, scoring orchestrator in
 * taxonomy-score.ts).
 *
 * Strategy:
 *   1. Query the N stalest score rows across all workspaces. "Stale"
 *      means older than SCORE_FRESHNESS_MS (7d), so a workspace that
 *      hasn't touched the niche finder in months keeps its scores
 *      from drifting indefinitely.
 *   2. For each, re-score the node (1× YouTube sample + the four
 *      dimension scorers).
 *   3. Stop when the per-run cap (MAX_NODES_PER_RUN) is reached.
 *
 * The cap is a budget: ~100 YouTube quota units per node × 30 nodes
 * per run = 3,000 units, which is 30% of the default 10k/day quota,
 * leaving 70% for interactive users (per plan §4 PR3).
 *
 * Auth gate matches every other cron in `src/app/api/cron/*`:
 * `Authorization: Bearer ${CRON_SECRET}`, bypassed in local dev.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';
import {
  getNode,
  listStalestScores,
  type TaxonomyNodeRow,
} from '@/lib/niche-finder/taxonomy-db';
import { scoreOneNode } from '@/lib/niche-finder/taxonomy-score';

/** Per-run cap on nodes scored. 30 nodes × ~100 YouTube quota units
 *  per node = 3,000 units, ~30% of the default daily YouTube quota.
 *  The remaining 70% stays available for interactive users. */
const MAX_NODES_PER_RUN = 30;

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  const isLocal =
    process.env.NODE_ENV !== 'production' &&
    (req.nextUrl.hostname === 'localhost' || req.nextUrl.hostname === '127.0.0.1');

  if (!isLocal) {
    if (!cronSecret) {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
    }
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const startedAt = Date.now();
  logger.info('cron niche-taxonomy-sweep: start');

  const stale = await listStalestScores(MAX_NODES_PER_RUN);
  if (stale.length === 0) {
    logger.info('cron niche-taxonomy-sweep: no stale scores');
    return NextResponse.json({ scored: 0, skipped: 0, errors: 0, considered: 0 });
  }

  // Pre-fetch the nodes in one round-trip. Some rows may have been
  // deleted between the stalest-scan and the fetch (rare but possible
  // if a category was removed) — those entries are skipped.
  const nodes = await Promise.all(stale.map((s) => getNode(s.node_id)));
  const validNodes: { node: TaxonomyNodeRow; workspaceId: string }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    if (n.level === 'category') continue; // categories aren't scored
    validNodes.push({ node: n, workspaceId: stale[i].workspace_id });
  }

  let scored = 0;
  let errors = 0;
  for (const { node, workspaceId } of validNodes) {
    try {
      const categoryHint = await findCategoryHint(node);
      const result = await scoreOneNode({
        workspaceId,
        node,
        categoryHint,
        // Use the same neutral OperatorFit as the interactive default —
        // a workspace-specific fit would need a per-workspace setting
        // pulled here, which we don't have yet. Phase 4 of the niche
        // finder may surface it.
        fit: {
          interests: [],
          language: node.language,
          region: node.region,
          llmFitScore: 0.5,
          llmRationale: 'Cron sweep — neutral fit prior.',
        },
      });
      if (result.scores) {
        scored++;
      } else {
        errors++;
      }
    } catch (err) {
      errors++;
      logger.warn('cron niche-taxonomy-sweep: node failed', {
        node_id: node.id,
        workspace_id: workspaceId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const skipped = stale.length - validNodes.length;
  logger.info('cron niche-taxonomy-sweep: done', {
    duration_ms: Date.now() - startedAt,
    considered: stale.length,
    scored,
    skipped,
    errors,
  });

  return NextResponse.json({
    considered: stale.length,
    scored,
    skipped,
    errors,
  });
}

/** Walk up the parent chain to find the category-level ancestor.
 *  Mirrors the helper in /taxonomy/score/route.ts but kept local so
 *  the cron doesn't import from a route file (server-side routes are
 *  technically importable but conceptually one-way). */
async function findCategoryHint(node: TaxonomyNodeRow): Promise<string> {
  if (node.level === 'category') return node.name;
  if (!node.parent_id) return '';
  const { rows: parentRows } = await sql<{ name: string; parent_id: string | null; level: string }>`
    SELECT name, parent_id::text, level
    FROM niche_taxonomy_nodes
    WHERE id = ${node.parent_id}::uuid
    LIMIT 1
  `;
  const parent = parentRows[0];
  if (!parent) return '';
  if (parent.level === 'category') return parent.name;
  if (!parent.parent_id) return '';
  const { rows: grandRows } = await sql<{ name: string; level: string }>`
    SELECT name, level
    FROM niche_taxonomy_nodes
    WHERE id = ${parent.parent_id}::uuid
    LIMIT 1
  `;
  return grandRows[0]?.name ?? '';
}
