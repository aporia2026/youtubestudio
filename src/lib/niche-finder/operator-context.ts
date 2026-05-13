/**
 * Operator context fetcher.
 *
 * Pulls the workspace-specific data that grounds the Niche Brief's
 * `operator_fit` section — without this, "fit" is hallucinated. Per
 * the council Contrarian's critique, an LLM with no operator data
 * pattern-matches generic "anyone could win this" prose. With this
 * data threaded into the prompt, the model is forced to either name
 * specific operator strengths or admit low confidence.
 *
 * v1 inputs:
 *   - Channel name + description from the most-recently-synced
 *     `channels` row in the workspace. When multiple channels exist
 *     (the operator manages a portfolio) we pick the most recently
 *     touched one; future iteration can take a `primary_channel_id`
 *     explicitly.
 *   - Produced niches: every distinct niche from `niche_favorites`
 *     where the outcome was set to 'produced'. This is the operator's
 *     own track record, surfaced back to them.
 *   - Interest tags: empty in v1. When an operator-profile feature
 *     lands later it'll populate.
 *
 * Workspace-scoped — every query joins on workspace_id from the
 * caller-provided session.
 */
import { sql } from '@vercel/postgres';
import type { OperatorContext } from './brief';

export async function fetchOperatorContext(workspaceId: string): Promise<OperatorContext> {
  // Run both queries in parallel — they're independent.
  const [channel, produced] = await Promise.all([
    fetchPrimaryChannel(workspaceId),
    fetchProducedNiches(workspaceId),
  ]);

  return {
    channel_description: channel?.description ?? null,
    channel_name: channel?.name ?? null,
    produced_niches: produced,
    interest_tags: [], // populated by a future operator-profile feature
  };
}

interface ChannelRow {
  name: string;
  description: string | null;
  niche: string | null;
}

async function fetchPrimaryChannel(workspaceId: string): Promise<ChannelRow | null> {
  // Most recently synced channel wins. If nothing has synced yet, fall
  // back to most recently created. This matches the Channel tab's
  // intuition about "the operator's main channel."
  const { rows } = await sql<ChannelRow>`
    SELECT name, description, niche
      FROM channels
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY last_synced_at DESC NULLS LAST, created_at DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function fetchProducedNiches(workspaceId: string): Promise<string[]> {
  // Two sources, unioned:
  //   1. niche_favorites rows where outcome='produced' — the explicit
  //      learning-loop signal the operator marks themselves.
  //   2. channels.niche — the loose self-reported niche on the workspace's
  //      connected channel(s). Useful even before any produced outcomes
  //      have been recorded.
  // Dedup + cap at 12 names so the prompt doesn't bloat.
  const { rows } = await sql<{ niche: string }>`
    WITH from_favorites AS (
      SELECT niche_name AS niche
        FROM niche_favorites
       WHERE workspace_id = ${workspaceId}::uuid
         AND outcome = 'produced'
         AND deleted_at IS NULL
    ),
    from_channels AS (
      SELECT niche
        FROM channels
       WHERE workspace_id = ${workspaceId}::uuid
         AND niche IS NOT NULL
         AND niche <> ''
    )
    SELECT DISTINCT niche FROM (
      SELECT niche FROM from_favorites
      UNION ALL
      SELECT niche FROM from_channels
    ) AS combined
    WHERE niche IS NOT NULL
    LIMIT 12
  `;
  return rows.map((r) => r.niche).filter((n) => n && n.length > 0);
}
