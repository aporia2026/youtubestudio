/**
 * Lazy scorer for the hierarchical taxonomy.
 *
 *   POST /api/niche-finder/taxonomy/score
 *   Body: {
 *     nodeIds: string[],          // up to 20 ids
 *     fit?: OperatorFit,          // optional — fit dimension input
 *     force?: boolean,            // bypass freshness cache
 *   }
 *
 * For each requested node:
 *   - If a fresh score exists (within SCORE_FRESHNESS_MS) → skip and
 *     return the cached version, no YouTube call.
 *   - Otherwise → fetch a 30-video sample, score, persist, return.
 *
 * Concurrency is bounded inside taxonomy-score.ts (4 workers) so a
 * 20-node request finishes in ~5–10 sec on warm cache. Persistence is
 * synchronous so a follow-up GET sees the new rows.
 *
 * Rate-limited per-workspace to keep a runaway client from burning
 * YouTube quota.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { checkAndIncrementRateLimit } from '@/lib/rate-limit-db';
import {
  getNodesByIds,
  getScoresForNodes,
  isScoreFresh,
  type TaxonomyNodeRow,
} from '@/lib/niche-finder/taxonomy-db';
import { scoreNodeBatch, type ScoreOneNodeResult } from '@/lib/niche-finder/taxonomy-score';
import type { NicheScores, OperatorFit } from '@/lib/niche-finder/types';
import { sql } from '@vercel/postgres';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NODES_PER_REQUEST = 20;
const SCORE_RATE_LIMIT = 60;
const SCORE_RATE_WINDOW_MS = 60 * 1000;

interface ScoreRowPayload {
  nodeId: string;
  scores: NicheScores | null;
  sampleSize: number;
  scoredAt: string | null;
  fromCache: boolean;
  error: string | null;
}

function parseFit(value: unknown): OperatorFit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const interestsRaw = Array.isArray(obj.interests) ? obj.interests : [];
  const interests: string[] = [];
  for (const i of interestsRaw) {
    if (typeof i === 'string' && i.trim().length > 0 && interests.length < 10) {
      interests.push(i.trim().slice(0, 80));
    }
  }
  const llmFitScoreRaw = obj.llmFitScore;
  const llmFitScore =
    typeof llmFitScoreRaw === 'number' && Number.isFinite(llmFitScoreRaw)
      ? Math.max(0, Math.min(1, llmFitScoreRaw))
      : 0.5;
  const llmRationale =
    typeof obj.llmRationale === 'string' ? obj.llmRationale.slice(0, 300) : '';
  const language = typeof obj.language === 'string' ? obj.language.slice(0, 16) : 'en';
  const region = typeof obj.region === 'string' ? obj.region.slice(0, 16) : 'US';
  return { interests, language, region, llmFitScore, llmRationale };
}

/** Walk up the parent chain to find the category-level ancestor of a
 *  node. Returns the category name (or '' if not found) — fed to the
 *  monetization scorer as a category hint. Bounded at depth 3 to avoid
 *  a runaway query if the data is malformed. */
async function findCategoryHint(node: TaxonomyNodeRow): Promise<string> {
  if (node.level === 'category') return node.name;
  if (!node.parent_id) return '';
  // Two-step walk: subniche → category. If the node is a microniche,
  // walk twice (microniche → subniche → category).
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

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Rate-limit: YouTube quota is the real cost here. 60 requests/min
  // per workspace is generous for normal use but stops a tight loop.
  const limit = await checkAndIncrementRateLimit({
    key: `niche-taxonomy.score:${session.ws}`,
    limit: SCORE_RATE_LIMIT,
    windowMs: SCORE_RATE_WINDOW_MS,
  });
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: `Slow down — at most ${SCORE_RATE_LIMIT} score requests per minute.`,
      },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const raw = (body ?? {}) as Record<string, unknown>;
  const idsRaw = Array.isArray(raw.nodeIds) ? raw.nodeIds : [];
  const seen = new Set<string>();
  const nodeIds: string[] = [];
  for (const v of idsRaw) {
    if (typeof v !== 'string') continue;
    if (!UUID_RE.test(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    nodeIds.push(v);
    if (nodeIds.length >= MAX_NODES_PER_REQUEST) break;
  }
  if (nodeIds.length === 0) {
    return NextResponse.json(
      { error: 'nodeIds is required (1–20 UUIDs).' },
      { status: 400 },
    );
  }
  const fit = parseFit(raw.fit);
  const force = raw.force === true;

  try {
    const nodes = await getNodesByIds(nodeIds);
    if (nodes.length === 0) {
      return NextResponse.json({ error: 'No matching nodes' }, { status: 404 });
    }

    // Categories don't get scored — they're navigation, not destinations.
    // Filter them out at the gate to avoid wasting YouTube quota on
    // overly-broad queries that wouldn't produce a meaningful score.
    const scorables = nodes.filter((n) => n.level !== 'category');
    if (scorables.length === 0) {
      return NextResponse.json({
        results: [] as ScoreRowPayload[],
        skipped: nodes.map((n) => ({ nodeId: n.id, reason: 'category-level' })),
      });
    }

    // Cache short-circuit: pull the existing rows and skip any that
    // are fresh enough. `force` bypasses this.
    const existing = force
      ? new Map()
      : await getScoresForNodes(session.ws, scorables.map((n) => n.id));

    const needScoring: TaxonomyNodeRow[] = [];
    const cachedResults: ScoreRowPayload[] = [];
    for (const node of scorables) {
      const cached = existing.get(node.id);
      if (cached && isScoreFresh(cached.scored_at)) {
        cachedResults.push({
          nodeId: node.id,
          scores: cached.scores,
          sampleSize: cached.sample_size,
          scoredAt: cached.scored_at,
          fromCache: true,
          error: null,
        });
      } else {
        needScoring.push(node);
      }
    }

    // Compute category hint per node (one chain-walk each, parallel).
    // For large batches this is `needScoring.length` cheap DB hits — fine.
    const hintByNodeId = new Map<string, string>();
    await Promise.all(
      needScoring.map(async (n) => {
        const hint = await findCategoryHint(n);
        hintByNodeId.set(n.id, hint);
      }),
    );

    const freshResults: ScoreOneNodeResult[] =
      needScoring.length > 0
        ? await scoreNodeBatch({
            workspaceId: session.ws,
            nodes: needScoring,
            categoryHintByNodeId: hintByNodeId,
            fit,
          })
        : [];

    const freshPayload: ScoreRowPayload[] = freshResults.map((r) => ({
      nodeId: r.nodeId,
      scores: r.scores,
      sampleSize: r.sampleSize,
      scoredAt: r.scores ? new Date().toISOString() : null,
      fromCache: false,
      error: r.error,
    }));

    // Preserve the input order in the response.
    const byId = new Map([...cachedResults, ...freshPayload].map((r) => [r.nodeId, r]));
    const ordered: ScoreRowPayload[] = nodeIds
      .map((id) => byId.get(id))
      .filter((r): r is ScoreRowPayload => !!r);

    return NextResponse.json({
      results: ordered,
      skipped: nodes
        .filter((n) => n.level === 'category')
        .map((n) => ({ nodeId: n.id, reason: 'category-level' })),
    });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: taxonomy score',
      fallbackMessage: 'Could not score these niches — please try again.',
    });
  }
});
