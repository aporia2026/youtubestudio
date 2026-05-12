/**
 * Resolve the model fallback chain for a pipeline feature.
 *
 * Priority:
 *   1. Preset override (`fallback_chains_jsonb[feature]`)
 *   2. Registry default (`DEFAULT_FALLBACK_CHAINS[feature]` in ai-models.ts)
 *   3. Single-model fallback via Phase 6.2's `getEffectiveModelId`
 *
 * Always returns a non-empty array — the orchestrator can always
 * call generateTextWithFallback with the result. The single-model
 * path produces a one-entry chain so the wrapper's chain-loop is
 * the only call shape.
 */
import { DEFAULT_FALLBACK_CHAINS } from '../ai-models';
import { getEffectiveModelId } from '../model-defaults';
import type { AppFeature } from '../ai-models';
import type { PipelinePreset } from './types';

export async function resolveChain(
  feature: AppFeature,
  preset: PipelinePreset,
): Promise<readonly string[]> {
  const presetChain = preset.fallback_chains_jsonb?.[feature];
  if (presetChain && Array.isArray(presetChain) && presetChain.length > 0) {
    return presetChain;
  }

  const registryChain = DEFAULT_FALLBACK_CHAINS[feature];
  if (registryChain && registryChain.length > 0) {
    return registryChain;
  }

  const single = await getEffectiveModelId(preset.workspace_id, feature);
  return [single];
}
