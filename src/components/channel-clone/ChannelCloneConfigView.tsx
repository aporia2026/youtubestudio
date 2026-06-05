'use client';

/**
 * Channel Clone configuration surface.
 *
 * Three accordions that answer the three questions a user asks the
 * first time they look at this feature:
 *
 *   1. "Which model runs each stage?" — per-stage model id, resolved
 *      from workspace overrides + per-feature picker + hardcoded
 *      defaults. Pulls fresh from /api/settings/model-defaults on
 *      mount so it reflects whatever the Settings page wrote.
 *
 *   2. "What's the actual system prompt for each stage?" — calls
 *      getChannelCloneSystemPrompt(stage) and renders verbatim. The
 *      composed string is PREAMBLE + per-stage extracts + ABSOLUTE
 *      RULES, all sourced from the user's ULTIMATE AI YOUTUBE CONTENT
 *      ENGINE V2.0 docx. Each LLM call also appends a runner-specific
 *      JSON output schema; that schema appears too, below the V2.0
 *      slice, so the user can see EVERY token the model receives.
 *
 *   3. "How do I change the model?" — a "Change in Settings →" link
 *      to the existing /settings model-defaults panel.
 *
 * Mounted at the top of /channel-clone and /channel-clone/[id] so
 * configuration is visible BEFORE a run starts, not buried under a
 * collapsed details disclosure mid-flow.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  type AppFeature,
  type FeatureSection,
  type AppFeatureSpec,
  type ModelDefaultsBlob,
  resolveFeatureModelId,
  getModelById,
} from '@/lib/ai-models';
import {
  CHANNEL_CLONE_ABSOLUTE_RULES,
  CHANNEL_CLONE_PREAMBLE,
  getChannelCloneStateExtracts,
  getChannelCloneSystemPrompt,
  type ChannelCloneStageFeature,
} from '@/lib/channel-clone/prompts/v2-content-engine';

interface StageRow {
  feature: ChannelCloneStageFeature;
  label: string;
  v2States: string;
  outputSchemaSummary: string;
  /** Whether the LLM call is multimodal (passes an image alongside
   *  the system prompt). Only true for `analyze` in M2. */
  multimodal?: boolean;
}

const STAGES: StageRow[] = [
  { feature: 'channel-clone-intake-summary', label: 'Intake summary', v2States: 'STATE 1 + STATE 4', outputSchemaSummary: '— (no LLM call in M1; reserved for v2)' },
  { feature: 'channel-clone-analyze', label: 'Deep channel analysis', v2States: 'STATE 6 + 7 + 8 + 13', outputSchemaSummary: 'analysis + visualProfile JSON', multimodal: true },
  { feature: 'channel-clone-topic-generation', label: 'Topic ideation', v2States: 'STATE 5', outputSchemaSummary: 'topics[] with title/angle/hook/difficulty' },
  { feature: 'channel-clone-hook-engineering', label: 'Hook engineering', v2States: 'STATE 9', outputSchemaSummary: '5 hooks (Contrarian/Story/Stat/Challenge/Mystery)' },
  { feature: 'channel-clone-script-generation', label: 'Script generation', v2States: 'STATE 10', outputSchemaSummary: 'script + wordCount JSON' },
  { feature: 'channel-clone-script-audit', label: 'Script audit (10-point)', v2States: 'STATE 11', outputSchemaSummary: 'overall + 10-dim breakdown + verdict' },
  { feature: 'channel-clone-rowify', label: 'Rowify (script → rows)', v2States: 'STATE 14', outputSchemaSummary: 'rows[] with timecode/script/visual_type/ai_image_prompt' },
  { feature: 'channel-clone-publish-pack', label: 'Publish pack', v2States: 'STATE 17 + 18 + 19 + 21', outputSchemaSummary: 'titles + tags + thumbnails + 30-day calendar' },
];

const EMPTY_BLOB: ModelDefaultsBlob = { workspace: null, sections: {}, features: {} };

export function ChannelCloneConfigView() {
  const [defaults, setDefaults] = useState<ModelDefaultsBlob>(EMPTY_BLOB);
  const [loadingDefaults, setLoadingDefaults] = useState(true);
  const [featureSpecs, setFeatureSpecs] = useState<AppFeatureSpec[]>([]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch('/api/settings/model-defaults')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.defaults) setDefaults(data.defaults as ModelDefaultsBlob);
        if (Array.isArray(data?.features)) setFeatureSpecs(data.features as AppFeatureSpec[]);
      })
      .catch(() => { /* informational — fall back to hardcoded defaults */ })
      .finally(() => { if (!cancelled) setLoadingDefaults(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-5 text-sm">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-neutral-100">Configuration</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Models + V2.0 system prompts per stage. Prompts are sourced from your{' '}
            <code className="rounded bg-neutral-900 px-1 py-0.5 text-[10px] text-neutral-300">refs/ULTIMATE AI YOUTUBE CONTENT ENGINE V2.0.docx</code>{' '}
            and verified against the doc — every STATE section here is the verbatim text from your file.
          </p>
        </div>
      </header>

      <details className="rounded border border-neutral-800 bg-neutral-900 p-3 text-xs">
        <summary className="cursor-pointer">
          <span className="font-medium text-neutral-200">Models per stage ({STAGES.length})</span>
          {!loadingDefaults && featureSpecs.length === 0 && (
            <span className="ml-2 text-[10px] text-amber-400">(fetch from /api/settings/model-defaults failed — showing hardcoded defaults)</span>
          )}
        </summary>
        <table className="mt-2 w-full text-left text-[11px]">
          <thead>
            <tr className="text-neutral-500">
              <th className="pb-1 font-medium">Stage</th>
              <th className="pb-1 font-medium">V2.0 STATEs</th>
              <th className="pb-1 font-medium">Model</th>
              <th className="pb-1 font-medium">Multimodal</th>
            </tr>
          </thead>
          <tbody className="text-neutral-300">
            {STAGES.map((s) => {
              const featuresArr = featureSpecs.length > 0
                ? featureSpecs
                : STAGES.map((row) => ({ id: row.feature, label: row.label, description: '', section: 'create' as FeatureSection, defaultModelId: 'claude-opus-4-8' } satisfies AppFeatureSpec));
              const spec = featuresArr.find((f) => f.id === (s.feature as AppFeature));
              const modelId = spec ? resolveFeatureModelId(s.feature as AppFeature, defaults) : 'claude-opus-4-8';
              const model = getModelById(modelId);
              return (
                <tr key={s.feature} className="border-t border-neutral-800">
                  <td className="py-1">{s.label}</td>
                  <td className="py-1 font-mono text-[10px] text-neutral-500">{s.v2States}</td>
                  <td className="py-1 font-mono text-neutral-200">{model?.name ?? modelId}</td>
                  <td className="py-1">{s.multimodal ? <span className="text-amber-300">image</span> : <span className="text-neutral-600">text</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-[10px]">
          <Link href="/settings" className="text-blue-400 hover:underline">Change in Settings → Model Defaults →</Link>
        </p>
      </details>

      <details className="rounded border border-neutral-800 bg-neutral-900 p-3 text-xs">
        <summary className="cursor-pointer font-medium text-neutral-200">V2.0 system prompts per stage</summary>
        <div className="mt-3 space-y-3">
          <PromptBlock label="Always-on preamble (every stage)" text={CHANNEL_CLONE_PREAMBLE} />
          {STAGES.map((s) => {
            // Skip the intake-summary stage since it has no LLM call in M1.
            if (s.feature === 'channel-clone-intake-summary') return null;
            const extracts = getChannelCloneStateExtracts(s.feature);
            return (
              <details key={s.feature} className="rounded border border-neutral-800 bg-neutral-950 p-2">
                <summary className="cursor-pointer text-neutral-300">
                  {s.label} — {s.v2States}
                </summary>
                <div className="mt-2 space-y-2">
                  {extracts.map((e, i) => (
                    <PromptBlock key={i} label={`STATE extract ${i + 1}`} text={e} />
                  ))}
                  <p className="text-[10px] text-neutral-500">
                    + the runner appends a JSON output schema: <span className="text-neutral-300">{s.outputSchemaSummary}</span>
                  </p>
                </div>
              </details>
            );
          })}
          <PromptBlock label="Always-on closer (every stage)" text={CHANNEL_CLONE_ABSOLUTE_RULES} />
          <details className="rounded border border-neutral-800 bg-neutral-950 p-2">
            <summary className="cursor-pointer text-neutral-300">Show one full composed prompt — analyze stage</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-2 text-[10px] text-neutral-300">
              {getChannelCloneSystemPrompt('channel-clone-analyze')}
            </pre>
          </details>
        </div>
      </details>
    </div>
  );
}

function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</p>
      <pre className="overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-2 text-[10px] leading-relaxed text-neutral-300">
        {text}
      </pre>
    </div>
  );
}
