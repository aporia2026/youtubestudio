'use client';

/**
 * Cross-provider model picker for the channel-clone mid-run retry.
 *
 * Replaces the original three-Anthropic-options hardcoded list with
 * a provider-grouped `<select>` over the full AI_MODELS registry,
 * gated by `isModelCompatibleWithStage(modelId, stage)` so multimodal
 * stages don't surface text-only models.
 *
 * Native `<optgroup>` was chosen over a custom combobox: zero new
 * deps, accessible by default, the mobile system picker handles
 * long lists gracefully. See
 * `_plans/2026-06-07-channel-clone-mid-run-model-picker-cross-provider.md`.
 *
 * IMPORTANT: this component does NOT modify any default-model
 * settings (memory/feedback_model_defaults_user_owned.md). It is a
 * one-shot override surface; the operator's persisted Settings →
 * Model Defaults selection is untouched.
 */

import { useMemo } from 'react';
import {
  AI_MODELS,
  formatModelPricing,
  getModelById,
  type AIModel,
} from '@/lib/ai-models';
import {
  getCompatibleModelsForStage,
  isModelCompatibleWithStage,
  type ChannelCloneRetryStage,
} from '@/lib/channel-clone/retry-alternative';

export interface ModelRetryPickerProps {
  /** Currently selected model id. Controlled value. */
  value: string;
  /** Notify parent of new selection. */
  onChange: (modelId: string) => void;
  /** Which stage we're retrying — drives the compatibility filter. */
  stage: ChannelCloneRetryStage;
  /** The model id the stage originally used, if known. Surfaced as
   *  "Originally used: …" so the operator can see what didn't work
   *  without having to dig. Falls back to the controlled `value` if
   *  the runner never persisted the original model id (legacy jobs). */
  originalModelId: string | null;
  /** Disable the picker while a retry is in flight or the panel is
   *  otherwise blocked. */
  disabled: boolean;
}

interface OptGroupSpec {
  label: string;
  predicate: (m: AIModel) => boolean;
}

/** Provider grouping order. Anthropic first because it's the
 *  largest pool of safe lateral moves. Kie groups come BEFORE OpenAI
 *  so operators who chose a Kie model (or want to migrate to one)
 *  can find them without scrolling past ~21 OpenAI entries — that
 *  long-scroll was the 2026-06-08 "I don't see any kie.ai models in
 *  the picker" complaint. Google direct + Perplexity at the bottom
 *  because they're niche picks. */
const OPT_GROUPS: OptGroupSpec[] = [
  { label: 'Anthropic', predicate: (m) => m.provider === 'anthropic' },
  {
    label: 'Kie.ai — Gemini',
    predicate: (m) => m.provider === 'kie' && m.id.startsWith('kie-gemini'),
  },
  {
    label: 'Kie.ai — Claude',
    predicate: (m) => m.provider === 'kie' && m.id.startsWith('kie-claude'),
  },
  {
    label: 'Kie.ai — GPT / Codex',
    predicate: (m) => m.provider === 'kie' && m.id.startsWith('kie-gpt'),
  },
  { label: 'OpenAI', predicate: (m) => m.provider === 'openai' },
  { label: 'Google (direct)', predicate: (m) => m.provider === 'google' },
  { label: 'Perplexity Sonar', predicate: (m) => m.provider === 'perplexity' },
];

export function ModelRetryPicker({
  value,
  onChange,
  stage,
  originalModelId,
  disabled,
}: ModelRetryPickerProps) {
  // Re-derive on every render only when stage changes — the result
  // set is keyed off the registry, which is module-static.
  const compatible = useMemo(() => getCompatibleModelsForStage(stage), [stage]);

  // Pre-compute groups so the JSX stays flat. Each group keeps the
  // AI_MODELS source order so adjacent models cluster by family.
  const groupedOptions = useMemo(() => {
    return OPT_GROUPS.map((group) => {
      const models = compatible.filter((m) => group.predicate(m));
      return { label: group.label, models };
    }).filter((g) => g.models.length > 0);
  }, [compatible]);

  const originalLabel = useMemo(() => {
    if (!originalModelId) return null;
    const m = getModelById(originalModelId);
    if (!m) return `${originalModelId} (no longer in registry)`;
    const incompat = !isModelCompatibleWithStage(originalModelId, stage)
      ? ' — incompatible with this stage'
      : '';
    // Show the provider so "Gemini 3.5 Flash" reads as
    // "Gemini 3.5 Flash (via Kie.ai)" — otherwise the operator can't
    // tell which gateway just failed when both Kie and Google route
    // share the same display name. Bug-report 2026-06-08.
    const providerHint = providerDisplay(m.provider);
    return `${m.name}${providerHint ? ` (via ${providerHint})` : ''}${incompat}`;
  }, [originalModelId, stage]);

  // The "selected" model may not be compatible (e.g. operator just
  // navigated here from a stage where it was fine). Surface a clear
  // warning rather than silently letting them retry with a broken pick.
  const selectionWarning = useMemo(() => {
    if (!value) return null;
    if (!getModelById(value)) {
      return 'Selected model is not in the registry — pick another.';
    }
    if (!isModelCompatibleWithStage(value, stage)) {
      return `Selected model can't handle this stage's content. Pick another.`;
    }
    return null;
  }, [value, stage]);

  // Compute a stable count for the visible-options label so the
  // operator knows how big the picker is at a glance.
  const totalVisible = compatible.length;
  const totalRegistry = AI_MODELS.length;

  return (
    <div className="space-y-1">
      {originalLabel && (
        <p className="text-[10px] text-amber-200/60">
          Originally used: <span className="text-amber-200/80">{originalLabel}</span>
        </p>
      )}
      <select
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          // eslint-disable-next-line no-console -- per CLAUDE.md rule 14
          console.info('[channel-clone retry-picker]', {
            stage,
            originalModelId,
            pickedModelId: next,
            reason: 'user-selected',
          });
          onChange(next);
        }}
        disabled={disabled}
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100 outline-none focus:border-neutral-500 disabled:opacity-60"
        style={{ minWidth: 260, maxWidth: 420 }}
      >
        {groupedOptions.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.models.map((m) => (
              <option key={m.id} value={m.id}>
                {formatOptionLabel(m)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <p className="text-[10px] text-neutral-500">
        {totalVisible} of {totalRegistry} registered models compatible with this stage.
      </p>
      {selectionWarning && (
        <p className="text-[10px] text-red-300">{selectionWarning}</p>
      )}
    </div>
  );
}

/** "Claude Opus 4.8 — $5 in / $25 out / MTok". Inline price keeps
 *  the cost decision visible per Plan 3's chosen UX path (A). */
function formatOptionLabel(m: AIModel): string {
  return `${m.name} — ${formatModelPricing(m)}`;
}

/** Short, human-friendly provider name for the "Originally used"
 *  label. Returns null when there's nothing useful to add (e.g. the
 *  provider is already implied by the model name). */
function providerDisplay(provider: AIModel['provider']): string | null {
  switch (provider) {
    case 'anthropic': return 'Anthropic';
    case 'openai': return 'OpenAI';
    case 'kie': return 'Kie.ai';
    case 'google': return 'Google';
    case 'perplexity': return 'Perplexity';
  }
}
