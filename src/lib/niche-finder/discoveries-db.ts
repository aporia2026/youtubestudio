/**
 * Persistence layer for the discovery cache (niche_discoveries).
 *
 * Per the migration 0058 doc: one table, three discovery modes
 * (interests / channel / category). Each row caches a discovery
 * keyed by `(workspace_id, kind, input_hash)`.
 *
 * Mode D (outliers) does NOT live here — it's fetch-on-demand and
 * uses the existing `niche_finder_api_cache` for its caching.
 *
 * Pure DB-layer only — no AI, no HTTP, no logger emit on happy paths.
 */
import { sql } from '@vercel/postgres';
import { createHash } from 'node:crypto';
import type { NicheScores } from './types';

export type DiscoveryKind = 'interests' | 'channel' | 'category';

/** Cache TTL — 7 days. Matches the YouTube derived-data envelope
 *  used by the API-response cache so the operator never sees a
 *  discovery referencing data older than the underlying YouTube
 *  cache. */
export const DISCOVERY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One discovered niche surfaced by an A/B/C discovery. The slug
 *  links into the v0.5 deep-dive page at `/insights/niches/[slug]`. */
export interface DiscoveryResultItem {
  slug: string;
  name: string;
  /** Optional one-line rationale from the AI ("strong demand and
   *  room to enter; sample mid-roll-eligible"). Capped at 200 chars. */
  rationale?: string;
  scores: NicheScores;
}

export interface NicheDiscoveryRow {
  id: string;
  workspace_id: string;
  kind: DiscoveryKind;
  input_hash: string;
  input_summary: string;
  results: DiscoveryResultItem[];
  created_at: string;
}

/** Hash a normalised input into the cache key.
 *
 *  - For `interests`: pass the sorted, lowercased, joined interest list.
 *  - For `channel`: pass the canonical channel id (UCxxxxxx).
 *  - For `category`: pass the category slug.
 *
 *  Hashing means cache keys never leak raw operator intent across
 *  any log or audit surface. */
export function hashDiscoveryInput(normalisedInput: string): string {
  return createHash('sha256').update(normalisedInput).digest('hex');
}

/** Sort + lowercase + join a free-form interest list into the
 *  canonical form fed to `hashDiscoveryInput`. Exported because the
 *  route handler and the cache reader must produce the same form. */
export function canonicaliseInterests(interests: readonly string[]): string {
  return interests
    .map((i) => i.trim().toLowerCase())
    .filter((i) => i.length > 0)
    .sort()
    .join('|');
}

/** Fetch a cached discovery row. Returns null on miss or when the
 *  row is older than the TTL. */
export async function getDiscovery(args: {
  workspaceId: string;
  kind: DiscoveryKind;
  inputHash: string;
}): Promise<NicheDiscoveryRow | null> {
  const { rows } = await sql<NicheDiscoveryRow>`
    SELECT id::text, workspace_id::text, kind, input_hash, input_summary,
      results, created_at
    FROM niche_discoveries
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND kind = ${args.kind}
      AND input_hash = ${args.inputHash}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const fetchedAt = Date.parse(rows[0].created_at);
  if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > DISCOVERY_CACHE_TTL_MS) {
    return null;
  }
  return rows[0];
}

export interface UpsertDiscoveryArgs {
  workspaceId: string;
  kind: DiscoveryKind;
  inputHash: string;
  inputSummary: string;
  results: readonly DiscoveryResultItem[];
}

/** Insert-or-replace a discovery. `created_at` flips on every
 *  overwrite so cache TTLs are measured from the most recent run. */
export async function upsertDiscovery(args: UpsertDiscoveryArgs): Promise<NicheDiscoveryRow> {
  const summary = args.inputSummary.slice(0, 200);
  const { rows } = await sql<NicheDiscoveryRow>`
    INSERT INTO niche_discoveries (
      workspace_id, kind, input_hash, input_summary, results
    )
    VALUES (
      ${args.workspaceId}::uuid,
      ${args.kind},
      ${args.inputHash},
      ${summary},
      ${JSON.stringify(args.results)}::jsonb
    )
    ON CONFLICT (workspace_id, kind, input_hash) DO UPDATE SET
      input_summary = EXCLUDED.input_summary,
      results = EXCLUDED.results,
      created_at = NOW()
    RETURNING id::text, workspace_id::text, kind, input_hash, input_summary,
      results, created_at
  `;
  return rows[0];
}

/** Recent discoveries for a workspace — used to populate the
 *  "Recent" list on the hub page. Capped at 20 rows. */
export async function listRecentDiscoveries(workspaceId: string): Promise<NicheDiscoveryRow[]> {
  const { rows } = await sql<NicheDiscoveryRow>`
    SELECT id::text, workspace_id::text, kind, input_hash, input_summary,
      results, created_at
    FROM niche_discoveries
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT 20
  `;
  return rows;
}
