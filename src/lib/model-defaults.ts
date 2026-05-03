/**
 * Server-side AI model-defaults resolver.
 *
 * Every server-side `generateText` caller should resolve its model id
 * via `getEffectiveModelId(workspaceId, feature)` instead of hardcoding
 * a literal. The resolver applies the user's per-workspace overrides
 * stored in `workspace_model_defaults` with the documented precedence:
 *
 *   1. feature override   (scope = `feature:<feature>`)
 *   2. section override   (scope = `section:<section>`)
 *   3. workspace override (scope = `workspace`)
 *   4. feature's hardcoded fallback (`APP_FEATURES[…].defaultModelId`)
 *
 * The resolver caches per-workspace lookups for the lifetime of the
 * request. The cache is process-local; cross-instance staleness is
 * bounded by the request lifetime, which is fine because the only
 * mutator is the user clicking Save in /settings.
 */

import { sql } from '@vercel/postgres';
import {
  APP_FEATURES,
  AI_MODELS,
  FEATURE_SECTIONS,
  type AppFeature,
  type FeatureSection,
  type ModelDefaultsBlob,
  getFeatureSpec,
  getModelById,
  resolveFeatureModelId,
} from './ai-models';

/** A scope that can be set/cleared by the user. */
export type DefaultScope =
  | { kind: 'workspace' }
  | { kind: 'section'; section: FeatureSection }
  | { kind: 'feature'; feature: AppFeature };

/** Encode a scope into the TEXT form stored in the DB. */
export function encodeScope(scope: DefaultScope): string {
  switch (scope.kind) {
    case 'workspace':
      return 'workspace';
    case 'section':
      return `section:${scope.section}`;
    case 'feature':
      return `feature:${scope.feature}`;
  }
}

/** Decode a stored scope string back into a typed DefaultScope. Returns
 *  null when the string references an unknown section/feature — the row
 *  is then ignored by the resolver, which falls through to lower tiers. */
export function decodeScope(raw: string): DefaultScope | null {
  if (raw === 'workspace') return { kind: 'workspace' };
  if (raw.startsWith('section:')) {
    const section = raw.slice('section:'.length);
    if (FEATURE_SECTIONS.some((s) => s.id === section)) {
      return { kind: 'section', section: section as FeatureSection };
    }
    return null;
  }
  if (raw.startsWith('feature:')) {
    const feature = raw.slice('feature:'.length);
    if (APP_FEATURES.some((f) => f.id === feature)) {
      return { kind: 'feature', feature: feature as AppFeature };
    }
    return null;
  }
  return null;
}

interface DefaultsRow {
  scope: string;
  model_id: string;
}

/** Per-request memoization cache. Keyed by workspaceId. The Map lives
 *  on globalThis so multiple calls in the same Node.js worker share it
 *  (Vercel's lambda warmth + Next.js App Router request lifetime). */
type CacheKey = string;
const CACHE_KEY = Symbol.for('youtubestudio.model-defaults-cache');
interface CacheEntry { blob: ModelDefaultsBlob; loadedAt: number }

function getCache(): Map<CacheKey, CacheEntry> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map<CacheKey, CacheEntry>();
  return g[CACHE_KEY] as Map<CacheKey, CacheEntry>;
}

/** Cache TTL in ms. Short enough that a Settings → Save propagates
 *  within ~5s on any warm lambda; long enough to avoid hammering the DB
 *  for high-traffic workspaces. */
const CACHE_TTL_MS = 5_000;

export function clearModelDefaultsCache(workspaceId?: string): void {
  const cache = getCache();
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/** Build the resolver blob for a workspace. Loads from
 *  `workspace_model_defaults`, decoding each row into the typed blob.
 *  Cached per workspace for CACHE_TTL_MS. */
export async function loadDefaults(workspaceId: string): Promise<ModelDefaultsBlob> {
  const cache = getCache();
  const cached = cache.get(workspaceId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.blob;

  const { rows } = await sql<DefaultsRow>`
    SELECT scope, model_id
      FROM workspace_model_defaults
     WHERE workspace_id = ${workspaceId}::uuid
  `;

  const blob: ModelDefaultsBlob = { workspace: null, sections: {}, features: {} };
  for (const row of rows) {
    const scope = decodeScope(row.scope);
    if (!scope) continue;
    if (!getModelById(row.model_id)) continue; // ignore stale rows for retired models
    if (scope.kind === 'workspace') blob.workspace = row.model_id;
    else if (scope.kind === 'section') blob.sections[scope.section] = row.model_id;
    else if (scope.kind === 'feature') blob.features[scope.feature] = row.model_id;
  }

  cache.set(workspaceId, { blob, loadedAt: Date.now() });
  return blob;
}

/** Resolve the effective model id for a feature in a workspace. Falls
 *  back to the feature's hardcoded default (and ultimately to
 *  AI_MODELS[0]) if no override is set. */
export async function getEffectiveModelId(
  workspaceId: string,
  feature: AppFeature,
): Promise<string> {
  try {
    const blob = await loadDefaults(workspaceId);
    return resolveFeatureModelId(feature, blob);
  } catch {
    // DB hiccup: fall back to the hardcoded default — better to ship a
    // known-good model than 500 the user's request.
    return getFeatureSpec(feature)?.defaultModelId ?? AI_MODELS[0].id;
  }
}

/** Read the full defaults blob for a workspace. Used by the Settings
 *  page to render the current state. */
export async function getDefaults(workspaceId: string): Promise<ModelDefaultsBlob> {
  return loadDefaults(workspaceId);
}

/** Upsert one scope's model id. Pass `null` model id to clear the
 *  scope (revert to inherit from the next tier up). Invalidates the
 *  per-workspace cache. */
export async function setDefault(
  workspaceId: string,
  scope: DefaultScope,
  modelId: string | null,
): Promise<void> {
  const scopeStr = encodeScope(scope);
  if (modelId === null) {
    await sql`
      DELETE FROM workspace_model_defaults
       WHERE workspace_id = ${workspaceId}::uuid
         AND scope = ${scopeStr}
    `;
  } else {
    if (!getModelById(modelId)) {
      throw new Error(`Unknown model id: ${modelId}`);
    }
    await sql`
      INSERT INTO workspace_model_defaults (workspace_id, scope, model_id, updated_at)
      VALUES (${workspaceId}::uuid, ${scopeStr}, ${modelId}, NOW())
      ON CONFLICT (workspace_id, scope) DO UPDATE
        SET model_id = EXCLUDED.model_id,
            updated_at = NOW()
    `;
  }
  clearModelDefaultsCache(workspaceId);
}
