/**
 * Pure helpers backing the channel-clone mid-run model picker.
 *
 * Two responsibilities:
 *
 *   1. `pickRetryAlternative(failedModelId)` — choose a sensible
 *      cross-provider lateral move when a stage's primary model
 *      failed. Most stage failures in production turn out to be
 *      rate-limits, content-filter refusals, or transient 5xx on
 *      the primary provider; jumping providers clears them more
 *      often than picking a different tier on the same provider.
 *      The function returns the alternative as a model id from
 *      `AI_MODELS`.
 *
 *   2. `isModelCompatibleWithStage(modelId, stage)` — capability
 *      gate so the picker can disable models that would crash the
 *      retry. `analyze` feeds frames to the model; text-only models
 *      (Perplexity Sonar chat, OpenAI o-series on chat completions,
 *      Kie Codex variants on /api/v1/responses) can't accept those
 *      content parts. `voice-profile` (Plan 1) feeds audio bytes;
 *      only Gemini-family models in our registry handle audio
 *      reliably.
 *
 * Both helpers are pure: no I/O, no React. They live here (not
 * inside the picker component) so the unit tests can exercise the
 * full registry without spinning up jsdom.
 *
 * See `_plans/2026-06-07-channel-clone-mid-run-model-picker-cross-provider.md`
 * for the design rationale, including the "no model defaults
 * changes" constraint (memory/feedback_model_defaults_user_owned.md).
 */

import {
  AI_MODELS,
  getModelById,
  type AIModel,
  type AppFeature,
} from '@/lib/ai-models';

/** Stages where the mid-run picker is meaningful — i.e. stages
 *  that make an LLM call. `intake` and `handoff` are listed for
 *  type-completeness with `failedStatusToStage` but never trigger
 *  the model-aware branches because they don't use LLMs. */
export type ChannelCloneRetryStage =
  | 'intake'
  | 'analyze'
  | 'topics'
  | 'hooks'
  | 'script'
  | 'rowify'
  | 'publish-pack'
  | 'handoff'
  | 'voice-profile';

/** Stages that send non-text content (images, audio) to the model.
 *  These need a capability gate. */
const MULTIMODAL_IMAGE_STAGES: ReadonlySet<ChannelCloneRetryStage> = new Set([
  'analyze',
]);

/** Stages that need an audio-capable model (Plan 1 wires this on).
 *  Until Plan 1 ships, no stage in this set actually surfaces in the
 *  retry picker — but the helper is future-proof. */
const MULTIMODAL_AUDIO_STAGES: ReadonlySet<ChannelCloneRetryStage> = new Set([
  'voice-profile',
]);

/** Models whose wire format cannot accept image content parts in our
 *  current provider routers. Listed by exact id so a future addition
 *  to AI_MODELS doesn't silently regress.
 *
 *  - Perplexity Sonar — chat + web search, no image input.
 *  - OpenAI o-series — image input flows through the Responses API,
 *    not the chat completions endpoint our router uses.
 *  - Kie Codex variants — routed via /api/v1/responses with a
 *    coding-focused payload shape; no image surface.
 *  - Direct Google Gemini 3.x — flagged "(unverified)" in the
 *    registry because Google's v1beta endpoint 404s them. The
 *    user can pick them anyway; we don't pre-disable since the
 *    Kie variants of the same models work fine. */
const TEXT_ONLY_MODEL_IDS: ReadonlySet<string> = new Set<string>([
  // Perplexity
  'sonar',
  'sonar-pro',
  'sonar-reasoning',
  'sonar-reasoning-pro',
  'sonar-deep-research',
  // OpenAI reasoning (chat completions image not wired)
  'o3',
  'o3-mini',
  'o4-mini',
  // Kie GPT Codex variants (responses-only, no image part)
  'kie-gpt-5-codex',
  'kie-gpt-5-1-codex',
  'kie-gpt-5-2-codex',
  'kie-gpt-5-3-codex',
  'kie-gpt-5-4-codex',
]);

/** Returns true when the model can be picked for this stage without
 *  the retry crashing on its first content-part. Text-only stages
 *  accept any registered model; multimodal stages filter to those
 *  whose provider router actually serializes the right parts. */
export function isModelCompatibleWithStage(
  modelId: string,
  stage: ChannelCloneRetryStage,
): boolean {
  const model = getModelById(modelId);
  if (!model) return false;
  if (MULTIMODAL_AUDIO_STAGES.has(stage)) {
    // voice-profile-runner hand-rolls a call to Kie's Google-native
    // `:generateContent` endpoint with `inline_data` audio. Direct
    // Google models are NOT wired (they'd need a separate router
    // branch) and non-Gemini providers don't accept audio at all.
    // So today the only audio-capable models are the kie-gemini-*
    // family — six models, all the variants from 2.5 through 3.5
    // Flash. Verified by the Plan 1B spike on 2026-06-07.
    return model.provider === 'kie' && modelId.startsWith('kie-gemini');
  }
  if (MULTIMODAL_IMAGE_STAGES.has(stage)) {
    return !TEXT_ONLY_MODEL_IDS.has(modelId);
  }
  return true;
}

/** Filter AI_MODELS down to the picker's selectable set for this
 *  stage. Stable order: provider grouping preserved from AI_MODELS. */
export function getCompatibleModelsForStage(
  stage: ChannelCloneRetryStage,
): AIModel[] {
  return AI_MODELS.filter((m) => isModelCompatibleWithStage(m.id, stage));
}

/** Choose a sensible cross-provider alternative when the named model
 *  just failed. Heuristic, deliberately simple:
 *
 *   - Anthropic failure → balanced OpenAI ('gpt-5.4-mini').
 *   - OpenAI failure → balanced Anthropic ('claude-sonnet-4-6').
 *   - Kie alias failure → the direct-provider equivalent if it
 *     exists in the registry; otherwise balanced Anthropic.
 *   - Google direct failure → equivalent Kie Gemini (more reliable
 *     today; the direct flavours are unverified).
 *   - Perplexity failure → balanced Anthropic.
 *   - Unknown failed id → balanced Anthropic.
 *
 *  The returned id is guaranteed to be present in `AI_MODELS` AND
 *  compatible with the supplied stage. Falls back to the first
 *  compatible model when the heuristic's pick isn't compatible. */
export function pickRetryAlternative(
  failedModelId: string,
  stage: ChannelCloneRetryStage,
): string {
  const compatible = getCompatibleModelsForStage(stage);
  if (compatible.length === 0) {
    // Defensive — should never happen because every stage has at
    // least one compatible model in the registry today. Return the
    // first registry entry so the caller has a valid id.
    return AI_MODELS[0].id;
  }
  const ensureCompatible = (candidateId: string): string => {
    if (isModelCompatibleWithStage(candidateId, stage)) return candidateId;
    return compatible[0].id;
  };

  // voice-profile is audio-only; cross-provider doesn't apply (only
  // Kie Gemini works). Stay within the family and pick a sibling
  // variant so a Kie outage on one Gemini version routes to another.
  if (stage === 'voice-profile') {
    if (failedModelId === 'kie-gemini-3-5-flash') return ensureCompatible('kie-gemini-2.5-flash');
    if (failedModelId === 'kie-gemini-2.5-flash') return ensureCompatible('kie-gemini-3-5-flash');
    if (failedModelId === 'kie-gemini-3-pro') return ensureCompatible('kie-gemini-2.5-pro');
    if (failedModelId === 'kie-gemini-2.5-pro') return ensureCompatible('kie-gemini-3-pro');
    if (failedModelId === 'kie-gemini-3.1-pro') return ensureCompatible('kie-gemini-3-pro');
    if (failedModelId === 'kie-gemini-3-flash') return ensureCompatible('kie-gemini-3-5-flash');
    return ensureCompatible('kie-gemini-3-5-flash');
  }

  const failed = getModelById(failedModelId);
  if (!failed) {
    return ensureCompatible('claude-sonnet-4-6');
  }
  switch (failed.provider) {
    case 'anthropic':
      return ensureCompatible('gpt-5.4-mini');
    case 'openai':
      return ensureCompatible('claude-sonnet-4-6');
    case 'kie': {
      const direct = kieToDirectEquivalent(failed.id);
      if (direct && getModelById(direct)) return ensureCompatible(direct);
      return ensureCompatible('claude-sonnet-4-6');
    }
    case 'google': {
      const viaKie = directGoogleToKieEquivalent(failed.id);
      if (viaKie && getModelById(viaKie)) return ensureCompatible(viaKie);
      return ensureCompatible('kie-gemini-2.5-flash');
    }
    case 'perplexity':
      return ensureCompatible('claude-sonnet-4-6');
  }
}

/** Map a Kie alias id to its direct-provider equivalent in the
 *  registry, when one exists. Used by `pickRetryAlternative` so a
 *  Kie outage routes to the same model via the original vendor. */
function kieToDirectEquivalent(kieId: string): string | undefined {
  switch (kieId) {
    case 'kie-claude-opus-4-7':
      return 'claude-opus-4-7';
    case 'kie-claude-opus-4-6':
      return 'claude-opus-4-6';
    case 'kie-claude-sonnet-4-6':
      return 'claude-sonnet-4-6';
    case 'kie-claude-haiku-4-5':
      return 'claude-haiku-4-5-20251001';
    case 'kie-gpt-5-2':
      return 'gpt-5.2';
    case 'kie-gpt-5-4':
      return 'gpt-5.4';
    case 'kie-gpt-5-5':
      return 'gpt-5.5';
    default:
      return undefined;
  }
}

/** Map a retry-stage segment to its corresponding AppFeature id.
 *  Stages that don't make LLM calls (`intake`, `handoff`) return
 *  `null`. Plan 1 adds `voice-profile`; until that ships the
 *  `channel-clone-voice-profile` feature may not exist in the
 *  registry yet — the caller resolves that via `getFeatureSpec`. */
export function stageToAppFeature(stage: ChannelCloneRetryStage): AppFeature | null {
  switch (stage) {
    case 'analyze':
      return 'channel-clone-analyze';
    case 'topics':
      return 'channel-clone-topic-generation';
    case 'hooks':
      return 'channel-clone-hook-engineering';
    case 'script':
      return 'channel-clone-script-generation';
    case 'rowify':
      return 'channel-clone-rowify';
    case 'publish-pack':
      return 'channel-clone-publish-pack';
    case 'voice-profile':
      // Plan 1 ships this AppFeature; until then resolveFeatureModelId
      // will fall through to the registry's first entry. Defensive but
      // not load-bearing — Plan 1's wiring will populate it.
      return 'channel-clone-voice-profile' as AppFeature;
    case 'intake':
    case 'handoff':
      return null;
  }
}

/** Inverse of `kieToDirectEquivalent` for the Google flavour: the
 *  direct google entries are flagged unverified, so a failure on
 *  one of them should jump to the Kie counterpart which routes
 *  through Kie's working alias. */
function directGoogleToKieEquivalent(googleId: string): string | undefined {
  switch (googleId) {
    case 'gemini-2.5-flash':
      return 'kie-gemini-2.5-flash';
    case 'gemini-2.5-pro':
      return 'kie-gemini-2.5-pro';
    case 'gemini-3-flash':
      return 'kie-gemini-3-flash';
    case 'gemini-3-pro':
      return 'kie-gemini-3-pro';
    case 'gemini-3.1-pro':
      return 'kie-gemini-3.1-pro';
    default:
      return undefined;
  }
}
