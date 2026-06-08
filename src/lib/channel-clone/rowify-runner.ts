/**
 * Channel-clone rowify runner — V2.0 STATE 14.
 *
 * Takes the audit-approved script and a chosen style preset, and
 * emits the per-row production-doc structure the existing image-gen
 * pipeline consumes (`generate-production-doc-images` walks
 * `rows[].ai_image_prompt` and produces images).
 *
 * Composition of the system prompt:
 *   - V2.0 PREAMBLE (CORE BEHAVIOR + VISUAL GATING + BRANDING)
 *   - STATE 14 (Scene-by-Scene Image Prompts) — the STANDALONE RULE
 *     is load-bearing here. Image generators are stateless, so each
 *     row's prompt must fully describe the scene without referencing
 *     earlier rows.
 *   - The chosen style preset's `ai_image_suffix` (style lock) and
 *     `mixing_rules` (preset-specific row composition guidance).
 *   - The visual style profile from the analyze stage, if available
 *     — adds palette + mood + line-weight cues on top of the preset.
 *   - A strict JSON output schema.
 *
 * Output rows are persisted on `state_jsonb.productionRows`. The
 * `chosenStylePresetId` is persisted alongside so a future
 * "Send to production pipeline" handoff knows which preset to apply.
 */

import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import { getBuiltInStyle } from '@/lib/production-doc-styles';
import type { ProductionDocRowLike } from '@/lib/production-doc-postprocess';
import { extractScriptTitles, type ExtractedTitle } from '@/lib/script-titles';
import { normalizeTitleCards } from '@/lib/title-card-repair';
import { deriveChannelStyle } from './derive-channel-style';
import {
  getChannelCloneJob,
  replaceChannelCloneJobState,
  setChannelCloneJobStatus,
} from './job-store';
import { isCandidateStylePresetId, matchStylePreset } from './match-style-preset';
import { extractJsonObjectFromModelResponse } from './parse-llm-json';
import { getChannelCloneSystemPrompt } from './prompts/v2-content-engine';
import type { ChannelCloneJobState } from './types';

const ROWIFY_OUTPUT_SCHEMA = `Respond with a single JSON object of this shape:
{
  "rows": [
    {
      "timecode": string,                       // "0:00-0:03" format, no spaces, end > start
      "script_text": string,                    // EXACT excerpt from the approved script, OR the heading text from the matching <<TITLE_N>> sentinel for a Title Card row; do not paraphrase
      "visual_type": "ai_image" | "stock" | "overlay" | "Title Card",
      "visual_description": string,             // 1-2 sentences describing what the viewer sees. For Title Card rows: \`Title card displaying "<heading text>"\`.
      "stock_search_terms": string,             // Empty string when visual_type !== "stock"
      "ai_image_prompt": string,                // FULL standalone prompt — subject, environment, lighting, mood, camera, style. NEVER references earlier rows. EMPTY STRING for Title Card rows (they render as typography, no image).
      "on_screen_text": string,                 // Yellow bold callout word or short phrase. Empty string when none. For Title Card rows: the heading text exactly.
      "notes": string                           // Free-form rationale (1 sentence max). Helps you, the editor, not the renderer.
    }
  ]
}

Constraints:
- One row per ~3-5 seconds of narration (channel WPS supplied below × 3-5 = words per row).
- script_text segments MUST be a contiguous, non-overlapping partition of the approved script. Concatenated, they reproduce the full script in order. Title Card rows do not count toward this partition — their script_text is the heading text, not narration.
- Cover EVERY word of the script. No gaps. No skipping.
- The first row's hook MUST be a verbatim slice of the script's opening.
- ai_image_prompt is FULLY STANDALONE — never reference "the previous shot" or "as before". An image generator with no context must be able to render this row alone.

Title card sentinels:
- The input script may contain \`<<TITLE_N>>\` sentinels on their own line (where N is 0, 1, 2, ...). Each sentinel marks a place where the original \`## Heading\` line was — those headings render as full-screen title cards in the final video.
- For EACH sentinel in the script (in the order they appear), emit ONE standalone Title Card row at that position:
  - \`script_text\` = the heading text EXACTLY as listed under "Title cards" below
  - \`visual_type\` = "Title Card"
  - \`visual_description\` = \`Title card displaying "<heading text>"\`
  - \`ai_image_prompt\` = "" (empty — the renderer draws the text without an image)
  - \`on_screen_text\` = the heading text
  - \`stock_search_terms\` = ""
- "Title Card" is RESERVED EXCLUSIVELY for these sentinel rows. Do NOT use it for any other shot.
- If the script contains no \`<<TITLE_N>>\` sentinels, emit no Title Card rows.
- EVERY sentinel in the script MUST become exactly one Title Card row at that position. Do NOT skip any sentinel.

Output ONLY the JSON object. First char \`{\`, last char \`}\`.`;

export interface ChannelCloneProductionRow {
  timecode: string;
  script_text: string;
  visual_type: 'ai_image' | 'stock' | 'overlay' | 'Title Card';
  visual_description: string;
  stock_search_terms: string;
  ai_image_prompt: string;
  on_screen_text: string;
  notes: string;
}

export interface RunRowifyOptions {
  jobId: string;
  workspaceId: string;
  projectId?: string | null;
  /** Optional user-picked style preset id. When omitted, the
   *  runner falls back to `matchStylePreset(visualProfile)`. */
  stylePresetId?: string;
  /** When true (the default), the runner DERIVES a per-job custom
   *  style from the visual profile + intake frames AND uses it in
   *  the LLM prompt instead of the built-in preset's suffix. The
   *  preset stays around for its mixing_rules + as the structural
   *  base. The handoff stage then carries the custom style into the
   *  production-doc so the image-gen pipeline references the
   *  channel's actual frames.
   *
   *  Set to false to opt out (e.g., the operator wants a clean
   *  built-in style with no channel-specific overrides). */
  useChannelStyle?: boolean;
  /** Per-invocation model override. See `RunAnalyzeOptions.modelOverride`. */
  modelOverride?: string;
}

export async function runRowify(opts: RunRowifyOptions): Promise<void> {
  const { jobId, workspaceId } = opts;
  logger.info('[channel-clone rowify] start', { jobId, stylePresetIdHint: opts.stylePresetId ?? null });
  await setChannelCloneJobStatus(jobId, workspaceId, 'rowify_running');

  const job = await getChannelCloneJob(jobId, workspaceId);
  if (!job) {
    logger.error('[channel-clone rowify] job missing', { jobId });
    return;
  }
  const { analysis, visualProfile, approvedScript, intake } = job.state_jsonb;
  if (!analysis || !approvedScript) {
    return failJob(jobId, workspaceId, 'Cannot rowify: analysis + approvedScript must both be present.');
  }

  // Resolve the style preset. User pick wins; otherwise match to
  // visual profile; otherwise default to paint_explainer_v1. The
  // preset's mixing_rules + label are still used even when
  // channelStyle is on — they provide row-composition guidance and
  // a structural base for the production-doc.
  let presetId: string;
  let presetReason: string;
  if (opts.stylePresetId && isCandidateStylePresetId(opts.stylePresetId)) {
    presetId = opts.stylePresetId;
    presetReason = 'user-supplied';
  } else {
    const matched = matchStylePreset(visualProfile);
    presetId = matched.presetId;
    presetReason = matched.reason;
  }
  const preset = getBuiltInStyle(presetId);
  if (!preset) {
    return failJob(jobId, workspaceId, `Unknown style preset: ${presetId}`);
  }
  logger.info('[channel-clone rowify] preset resolved', {
    jobId,
    presetId,
    presetReason,
    presetLabel: preset.label,
  });

  // Derive the per-job custom style from the visual profile + intake
  // frames. Defaults to ON because the WHOLE POINT of channel-clone
  // is to reproduce the channel's visual DNA — using a built-in
  // preset's suffix would just classify the channel into one of our
  // existing buckets instead.
  const useChannelStyle = opts.useChannelStyle !== false;
  const channelStyle = useChannelStyle
    ? deriveChannelStyle(visualProfile, intake)
    : null;
  if (channelStyle) {
    logger.info('[channel-clone rowify] channel style derived', {
      jobId,
      suffixPreview: channelStyle.aiImageSuffix.slice(0, 200),
      refCount: channelStyle.refR2Keys.length,
      reason: channelStyle.reason,
    });
  }

  // Pick the style cue that lands in every ai_image_prompt: the
  // channel-derived suffix when channelStyle is on, the preset's
  // suffix otherwise.
  const styleSuffix = channelStyle?.aiImageSuffix ?? preset.ai_image_suffix;
  const suffixSource = channelStyle ? 'channel-derived (cloning the channel\'s visual DNA)' : `built-in preset "${preset.id}"`;

  const modelId = opts.modelOverride ?? await getEffectiveModelId(workspaceId, 'channel-clone-rowify');
  const systemPrompt = [
    getChannelCloneSystemPrompt('channel-clone-rowify'),
    '',
    `Style source: ${suffixSource}`,
    `Style mixing-rules base: ${preset.label} (id: ${preset.id})`,
    'Style ai_image_suffix to append onto every ai_image_prompt:',
    styleSuffix,
    '',
    preset.mixing_rules ? `Style mixing rules:\n${preset.mixing_rules}` : '',
    '',
    ROWIFY_OUTPUT_SCHEMA,
  ].filter(Boolean).join('\n\n');

  // Extract `## Heading` lines into `<<TITLE_N>>` sentinels BEFORE the
  // LLM sees the script. The LLM emits one Title Card row per sentinel
  // (per the schema's "Title card sentinels" section); after parse,
  // `normalizeTitleCards` demotes mistagged cards and synthesizes
  // missing ones. Mirrors the main pipeline at
  // `src/lib/auto-pipeline/stages/generate-production-doc.ts:122-298`.
  const extracted = extractScriptTitles(approvedScript.text);
  logger.info('[channel-clone rowify titles-extracted]', {
    jobId,
    titleCount: extracted.titles.length,
    titles: extracted.titles.map((t) => t.text).slice(0, 8),
  });

  const userPrompt = buildRowifyUserPrompt(
    analysis,
    visualProfile,
    { ...approvedScript, text: extracted.stripped },
    extracted.titles,
  );

  // Token budget: each row averages ~150 output tokens (timecode +
  // 1-2 sentences × 3 + standalone prompt). Average video is ~1300
  // words ÷ ~12 words/row = ~110 rows worst case. Budget 200 tokens
  // per row × 110 = 22000 max — capped to model output ceiling.
  const tokenBudget = Math.min(16000, Math.max(6000, Math.ceil(approvedScript.wordCount * 2.5)));

  let raw: string;
  try {
    raw = await generateText({
      modelId,
      systemPrompt,
      prompt: userPrompt,
      maxTokens: tokenBudget,
      temperature: 0.65,
      spend: {
        workspaceId,
        projectId: opts.projectId ?? null,
        featureArea: 'channel_clone_rowify',
        metadata: { jobId, presetId, wordCount: approvedScript.wordCount },
      },
    });
  } catch (err) {
    return failJob(jobId, workspaceId, `Model call failed: ${errorMessage(err)}`);
  }

  let parsed: ChannelCloneProductionRow[];
  try {
    parsed = parseRowifyResponse(raw);
  } catch (err) {
    logger.error('[channel-clone rowify] parse failed', {
      jobId,
      modelId,
      rawPreview: raw.slice(0, 400),
      error: errorMessage(err),
    });
    return failJob(jobId, workspaceId, `Could not parse rowify output: ${errorMessage(err)}`);
  }

  // Deterministic title-card repair: demote LLM-mistagged Title Cards
  // back to ai_image and synthesize any sentinel rows the LLM dropped.
  // `allowOverlay: false` — channel-clone Title Cards render as pure
  // typography, no real-image overlay branch (consistent with the main
  // pipeline's behaviour for paint_explainer_v1 / doodle_explainer_2).
  // The `as ProductionDocRowLike[]` bridge mirrors the main pipeline at
  // `src/lib/auto-pipeline/stages/generate-production-doc.ts:290` —
  // ChannelCloneProductionRow's strict union doesn't satisfy the
  // index-signature constraint on R, but the runtime shape is
  // compatible.
  const normalized = normalizeTitleCards(
    parsed as unknown as ProductionDocRowLike[],
    extracted.titles,
    extracted.stripped,
    { allowOverlay: false },
  );
  // Cards demoted by normalize land back as `visual_type: 'Animation'`
  // (the main pipeline's "generated still" value), but channel-clone's
  // enum is `ai_image | stock | overlay | Title Card`. Map any
  // demoted-Animation row to 'ai_image' (channel-clone's equivalent
  // of "generated still") so the row stays schema-valid downstream.
  const rows: ChannelCloneProductionRow[] = normalized.rows.map((r) => {
    const cc = r as unknown as ChannelCloneProductionRow;
    return (r.visual_type as string) === 'Animation'
      ? { ...cc, visual_type: 'ai_image' as const }
      : cc;
  });
  logger.info('[channel-clone rowify title-cards-normalized]', {
    jobId,
    demotedCount: normalized.demotedCount,
    insertedCount: normalized.insertedCount,
    insertedTitles: normalized.insertedTitles,
  });

  // Coverage sanity check — STATE 14's "every beat" rule. If the
  // emitted rows' script_text segments are missing more than a small
  // fraction of the approved script, we surface a warning but don't
  // fail. The image-gen pipeline still works with partial rows.
  const coverage = computeCoverageFraction(rows, approvedScript.text);
  if (coverage < 0.85) {
    logger.warn('[channel-clone rowify] script coverage below 85%', {
      jobId,
      coverage: Number(coverage.toFixed(3)),
      rowCount: rows.length,
    });
  }

  const fresh = await getChannelCloneJob(jobId, workspaceId);
  if (!fresh) return;
  const nextState: ChannelCloneJobState = {
    ...fresh.state_jsonb,
    chosenStylePresetId: presetId,
    channelStyle: channelStyle
      ? {
          aiImageSuffix: channelStyle.aiImageSuffix,
          refR2Keys: channelStyle.refR2Keys,
          reason: channelStyle.reason,
          derivedAt: new Date().toISOString(),
        }
      : fresh.state_jsonb.channelStyle, // preserve prior derivation if any
    productionRows: rows,
  };
  await replaceChannelCloneJobState(jobId, workspaceId, nextState);
  await setChannelCloneJobStatus(jobId, workspaceId, 'rowify_complete');
  logger.info('[channel-clone rowify] done', {
    jobId,
    modelId,
    presetId,
    rowCount: rows.length,
    coverage: Number(coverage.toFixed(3)),
  });
}

function buildRowifyUserPrompt(
  analysis: NonNullable<ChannelCloneJobState['analysis']>,
  visualProfile: ChannelCloneJobState['visualProfile'],
  approvedScript: NonNullable<ChannelCloneJobState['approvedScript']>,
  /** Headings extracted from the approved script and replaced in
   *  `approvedScript.text` with `<<TITLE_N>>` sentinels. The LLM
   *  emits one Title Card row per sentinel; empty array ⇒ no Title
   *  Cards expected and the "Title cards" block is omitted. */
  titles: readonly ExtractedTitle[] = [],
): string {
  const visualBlock = visualProfile
    ? [
        'Visual style profile from the competitor frames:',
        `- Art style: ${visualProfile.artStyle}`,
        `- Mood: ${visualProfile.mood}`,
        `- Lighting: ${visualProfile.lightingStyle}`,
        `- Composition: ${visualProfile.compositionPatterns}`,
        `- Detail level: ${visualProfile.detailLevel}`,
        `- Palette (hex): ${visualProfile.paletteHex.join(', ')}`,
      ].join('\n')
    : 'No visual profile available — derive style from the preset suffix + mixing rules alone.';

  const titleBlock = titles.length > 0
    ? [
        'Title cards (one Title Card row per sentinel; emit each at its sentinel position in the script):',
        ...titles.map((t) => `- ${t.sentinel} → "${t.text}"`),
      ].join('\n')
    : 'Title cards: none in this script.';

  return [
    'You are at STATE 14. Convert the approved script into scene-by-scene image prompts.',
    '',
    `Channel WPS: ${analysis.wpsEstimate.toFixed(2)}`,
    `Target row duration: 3-5 seconds (= ${Math.round(analysis.wpsEstimate * 3)}-${Math.round(analysis.wpsEstimate * 5)} words per row).`,
    `Approved script length: ${approvedScript.wordCount} words.`,
    '',
    visualBlock,
    '',
    titleBlock,
    '',
    'Approved script:',
    approvedScript.text,
  ].join('\n');
}

/** Parse the model's response into typed rows. Exported for unit tests. */
export function parseRowifyResponse(raw: string): ChannelCloneProductionRow[] {
  const obj = extractJsonObjectFromModelResponse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('response was not a JSON object');
  const arr = (obj as Record<string, unknown>).rows;
  if (!Array.isArray(arr)) throw new Error('rows must be an array');
  if (arr.length === 0) throw new Error('rows must not be empty');
  return arr.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`rows[${i}] is not an object`);
    const e = entry as Record<string, unknown>;
    const timecode = e.timecode;
    if (typeof timecode !== 'string' || !/^\d+:\d{2}-\d+:\d{2}$/.test(timecode)) {
      throw new Error(`rows[${i}].timecode must look like "0:00-0:03"`);
    }
    const visualType = e.visual_type;
    if (
      visualType !== 'ai_image'
      && visualType !== 'stock'
      && visualType !== 'overlay'
      && visualType !== 'Title Card'
    ) {
      throw new Error(`rows[${i}].visual_type must be ai_image | stock | overlay | Title Card`);
    }
    if (typeof e.script_text !== 'string' || e.script_text.length === 0) {
      throw new Error(`rows[${i}].script_text must be a non-empty string`);
    }
    if (typeof e.visual_description !== 'string') {
      throw new Error(`rows[${i}].visual_description must be a string`);
    }
    if (typeof e.ai_image_prompt !== 'string') {
      throw new Error(`rows[${i}].ai_image_prompt must be a string`);
    }
    if (typeof e.stock_search_terms !== 'string') {
      throw new Error(`rows[${i}].stock_search_terms must be a string`);
    }
    if (typeof e.on_screen_text !== 'string') {
      throw new Error(`rows[${i}].on_screen_text must be a string`);
    }
    if (typeof e.notes !== 'string') {
      throw new Error(`rows[${i}].notes must be a string`);
    }
    // ai_image rows must carry a prompt; stock rows must carry terms.
    // Title Card rows render typography — no image, no stock terms.
    if (visualType === 'ai_image' && e.ai_image_prompt.length === 0) {
      throw new Error(`rows[${i}]: visual_type=ai_image requires a non-empty ai_image_prompt`);
    }
    if (visualType === 'stock' && e.stock_search_terms.length === 0) {
      throw new Error(`rows[${i}]: visual_type=stock requires non-empty stock_search_terms`);
    }
    return {
      timecode,
      script_text: e.script_text,
      visual_type: visualType,
      visual_description: e.visual_description,
      stock_search_terms: e.stock_search_terms,
      ai_image_prompt: e.ai_image_prompt,
      on_screen_text: e.on_screen_text,
      notes: e.notes,
    };
  });
}

/** Compute what fraction of the approved script (by normalized
 *  character count) is covered by the row script_text segments.
 *  Used to surface a warning when the model dropped meaningful
 *  content during rowification. Title Card rows are excluded — their
 *  script_text is the heading, not a script excerpt, so counting them
 *  would inflate coverage and the comparison script must be the
 *  heading-stripped form. Exported for tests. */
export function computeCoverageFraction(rows: ChannelCloneProductionRow[], scriptText: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  // Strip `## Heading` lines from the reference script before
  // comparing — those lines were extracted into sentinels and are
  // never part of any narration row's script_text. Without this, a
  // script with headings always reports < 100% coverage.
  const stripped = scriptText.replace(/^\s*##\s+.+$/gm, '').replace(/\n{3,}/g, '\n\n');
  const scriptNorm = norm(stripped);
  if (scriptNorm.length === 0) return 1;
  const concat = rows
    .filter((r) => r.visual_type !== 'Title Card')
    .map((r) => r.script_text)
    .join(' ');
  const concatNorm = norm(concat);
  // Cheap coverage metric: ratio of concat length to script length,
  // capped at 1.0. Doesn't catch reorderings, but catches drop-outs.
  return Math.min(1, concatNorm.length / scriptNorm.length);
}

async function failJob(jobId: string, workspaceId: string, message: string): Promise<void> {
  logger.error('[channel-clone rowify] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, 'rowify_failed', { lastError: message });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
