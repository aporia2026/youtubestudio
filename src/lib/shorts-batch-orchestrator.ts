/**
 * Tick-based orchestrator for the bulk-batch shorts generation flow.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Drives the per-short generation pipeline for shorts that belong to
 * a batch. Mirrors the long-form auto-pipeline orchestrator pattern
 * but stays scoped to shorts so its blast radius is small.
 *
 * Per-short stage progression (state derived from observable columns,
 * see `shorts-batches.ts` doc):
 *   1. extract          — short_script IS NULL → LLM extraction from
 *                         generation_params.batch_idea_input
 *   2. voiceover        — voiceover_audio_url IS NULL → ElevenLabs/
 *                         Google TTS via the existing dispatch
 *   3. seo              — seo_result IS NULL → SEO grader → seed
 *                         youtube_metadata for the review queue
 *   4. (render — out of orchestrator scope; the existing shorts
 *      asset pipeline owns this. The orchestrator waits for
 *      rendered_video_url to appear before declaring "ready".)
 *
 * Concurrency: up to `MAX_PER_TICK` (3) shorts advance per tick.
 * Picked to fit comfortably inside the Vercel 300 s budget while
 * keeping LLM API rate-limit pressure low.
 *
 * Errors: stage failures are recorded on the short's
 * `generation_progress` JSONB with `phase='error'` + `error_message`
 * — mirroring the existing asset-pipeline convention so the editor's
 * error strip displays them uniformly. The orchestrator does NOT
 * automatically retry — the user (or the route) can re-trigger by
 * clearing generation_progress.
 *
 * Batch transition: after every tick, the orchestrator checks
 * whether every short in the batch is at a terminal state (rendered
 * video OR generation error). When yes, transitions the batch to
 * 'review' so the UI can show the queue.
 */
import { sql } from '@vercel/postgres';
import { generateText } from './ai';
import { getEffectiveModelId } from './model-defaults';
import {
  buildShortExtractionPrompt,
  parseExtractedShort,
  estimateShortDurationSeconds,
  generateShortVoiceover,
} from './shorts';
import { buildShortSeoPrompt, parseShortSeoResult } from './shorts-seo';
import {
  getBatchWithShorts,
  recomputeBatchTotals,
  seedYoutubeMetadataFromBatch,
  updateBatchStatus,
} from './shorts-batches';
import type { BatchIdeaInput } from './shorts-batches';
import type { ShortRow } from './shorts-types';
import type {
  BatchTickResult,
  ShortsBatchRow,
  YoutubeUploadMetadata,
} from './shorts-batches-types';
// Pure stage helpers live in their own module so client components
// (Step3Progress) can use them without dragging this server-only
// orchestrator (and its transitive Node-only deps) into the browser
// bundle. Re-exported here for callers that already import from this
// path.
export {
  isShortTerminal,
  nextStageFor,
  allShortsAtTerminal,
  type BatchStage,
} from './shorts-batch-stages';
import { isShortTerminal, nextStageFor, allShortsAtTerminal } from './shorts-batch-stages';
import type { BatchStage } from './shorts-batch-stages';

/** Concurrency cap per tick. Three is enough to keep wall-clock
 *  decent (3 voiceover calls in parallel ≈ 30s instead of 90s) while
 *  staying well under ElevenLabs's typical concurrency limits and
 *  the Vercel function budget. */
export const MAX_PER_TICK = 3;

/** Pick up to `MAX_PER_TICK` shorts from the batch that the
 *  orchestrator can actually advance this tick (i.e. nextStage is
 *  'extract' | 'voiceover' | 'seo'). 'awaiting_render' shorts are
 *  intentionally skipped — they're owned by the existing asset
 *  pipeline cron, not this orchestrator. */
export function pickShortsToAdvance(shorts: readonly ShortRow[]): ShortRow[] {
  const out: ShortRow[] = [];
  for (const s of shorts) {
    const stage = nextStageFor(s);
    if (stage === 'extract' || stage === 'voiceover' || stage === 'seo') {
      out.push(s);
      if (out.length >= MAX_PER_TICK) break;
    }
  }
  return out;
}

// ─── Stage executors ────────────────────────────────────────────────

interface StageOutcome {
  stage: BatchStage;
  shortId: string;
  ok: boolean;
  error?: string;
  duration_ms: number;
}

async function recordGenerationError(shortId: string, stage: string, message: string): Promise<void> {
  const progress = {
    phase: 'error' as const,
    label: `Batch ${stage} failed`,
    error_message: message.slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  await sql`
    UPDATE shorts
       SET generation_progress = ${JSON.stringify(progress)}::jsonb,
           updated_at = NOW()
     WHERE id = ${shortId}::uuid
  `;
}

async function runExtractStage(short: ShortRow): Promise<StageOutcome> {
  const t0 = Date.now();
  try {
    const params = (short.generation_params ?? {}) as { batch_idea_input?: BatchIdeaInput };
    const idea = params.batch_idea_input;
    if (!idea) {
      throw new Error('Placeholder short has no batch_idea_input in generation_params.');
    }

    const targetSeconds = Math.max(10, Math.min(90, idea.targetSeconds ?? 45));
    const modelId = await getEffectiveModelId(short.workspace_id, 'shorts-extract');

    const sourceContent =
      `Idea brief.

HOOK (open with this literal line, first 1-3 seconds): "${idea.hook}"
PAYOFF (close with this literal line): "${idea.payoff}"
WORKING TITLE: "${idea.ideaTitle}"
${idea.thesis ? `THESIS (what this Short proves): ${idea.thesis}\n` : ''}${idea.shotConcept ? `SHOT CONCEPT (visual shape): ${idea.shotConcept}\n` : ''}
Write the FULL Short script that opens on the literal HOOK line, delivers the thesis in the body, and lands on the literal PAYOFF line.`;

    const { system, user } = buildShortExtractionPrompt({
      longScript: sourceContent,
      niche: idea.niche,
      tone: idea.tone,
      targetSeconds,
    });

    const raw = await generateText({
      modelId,
      systemPrompt: system,
      prompt: user,
      maxTokens: 4000,
      temperature: 0.75,
      spend: {
        workspaceId: short.workspace_id,
        projectId: short.project_id,
        featureArea: 'shorts_batch_extract',
        metadata: { batch_id: short.batch_id, target_seconds: targetSeconds, niche: idea.niche.slice(0, 60) },
      },
    });

    const parsed = parseExtractedShort(raw);
    const duration = estimateShortDurationSeconds(parsed.word_count);

    await sql`
      UPDATE shorts
         SET title = ${parsed.title || idea.ideaTitle},
             short_script = ${parsed.short_script},
             hook = ${parsed.hook || idea.hook},
             payoff = ${parsed.payoff || idea.payoff},
             word_count = ${parsed.word_count},
             estimated_duration_seconds = ${duration},
             ai_model = ${modelId},
             updated_at = NOW()
       WHERE id = ${short.id}::uuid
    `;

    const ms = Date.now() - t0;
    console.info('[shorts-batch stage extract]', { short_id: short.id, batch_id: short.batch_id, duration_ms: ms, word_count: parsed.word_count });
    return { stage: 'extract', shortId: short.id, ok: true, duration_ms: ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    await recordGenerationError(short.id, 'extract', message);
    console.info('[shorts-batch stage error]', { short_id: short.id, stage: 'extract', message: message.slice(0, 200) });
    return { stage: 'extract', shortId: short.id, ok: false, error: message, duration_ms: ms };
  }
}

async function runVoiceoverStage(short: ShortRow, batch: ShortsBatchRow): Promise<StageOutcome> {
  const t0 = Date.now();
  try {
    const voiceId = batch.defaults.voiceId;
    if (!voiceId) {
      throw new Error('Batch defaults are missing voiceId — set a default voice on the batch before generating.');
    }

    await generateShortVoiceover({
      shortId: short.id,
      workspaceId: short.workspace_id,
      voiceId,
    });

    const ms = Date.now() - t0;
    console.info('[shorts-batch stage voiceover]', { short_id: short.id, batch_id: short.batch_id, duration_ms: ms, voice_id: voiceId });
    return { stage: 'voiceover', shortId: short.id, ok: true, duration_ms: ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    await recordGenerationError(short.id, 'voiceover', message);
    console.info('[shorts-batch stage error]', { short_id: short.id, stage: 'voiceover', message: message.slice(0, 200) });
    return { stage: 'voiceover', shortId: short.id, ok: false, error: message, duration_ms: ms };
  }
}

async function runSeoStage(short: ShortRow, batch: ShortsBatchRow): Promise<StageOutcome> {
  const t0 = Date.now();
  try {
    const params = (short.generation_params ?? {}) as { batch_idea_input?: BatchIdeaInput };
    const niche = params.batch_idea_input?.niche ?? '';

    const lengthSeconds = Math.max(1, Math.min(600, short.estimated_duration_seconds ?? 45));
    const modelId = await getEffectiveModelId(short.workspace_id, 'shorts-seo');

    const { system, user } = buildShortSeoPrompt({
      enteredTitle: short.title ?? '',
      enteredDescription: short.short_script ?? '',
      lengthSeconds,
      niche,
    });

    const raw = await generateText({
      modelId,
      systemPrompt: system,
      prompt: user,
      maxTokens: 4000,
      temperature: 0.7,
      spend: {
        workspaceId: short.workspace_id,
        projectId: short.project_id,
        featureArea: 'shorts_batch_seo',
        metadata: { batch_id: short.batch_id, length_seconds: lengthSeconds },
      },
    });

    const seo = parseShortSeoResult(raw);

    // Apply the SEO to the row + seed the youtube_metadata from
    // batch defaults + SEO output in the same UPDATE so the review
    // queue immediately has editable metadata.
    const seeded: YoutubeUploadMetadata = seedYoutubeMetadataFromBatch({
      short: { ...short, seo_result: seo },
      defaults: batch.defaults,
    });

    await sql`
      UPDATE shorts
         SET seo_result = ${JSON.stringify(seo)}::jsonb,
             youtube_metadata = ${JSON.stringify(seeded)}::jsonb,
             ai_model = ${modelId},
             updated_at = NOW()
       WHERE id = ${short.id}::uuid
    `;

    const ms = Date.now() - t0;
    console.info('[shorts-batch stage seo]', { short_id: short.id, batch_id: short.batch_id, duration_ms: ms, primary_keyword: seo.primary_keyword });

    // After SEO completes, hand the short to the existing asset
    // pipeline. Mirrors what POST /api/shorts/[id]/generate-style-assets
    // does — sets style_id + a queued generation_progress blob with
    // the model/vendor metadata the cron needs, then kicks the drain
    // so work starts immediately. Failure here is logged but doesn't
    // fail the SEO stage; the cron is also a backstop.
    void enqueueAssetGeneration(short, batch).catch((err) => {
      console.info('[shorts-batch stage assets-enqueue error]', {
        short_id: short.id,
        message: err instanceof Error ? err.message : String(err),
      });
    });

    return { stage: 'seo', shortId: short.id, ok: true, duration_ms: ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    await recordGenerationError(short.id, 'seo', message);
    console.info('[shorts-batch stage error]', { short_id: short.id, stage: 'seo', message: message.slice(0, 200) });
    return { stage: 'seo', shortId: short.id, ok: false, error: message, duration_ms: ms };
  }
}

/**
 * Asset-generation enqueue helper. Mirrors the per-short
 * /generate-style-assets route's DB writes + kicks the cron drain.
 *
 * The default style for batch shorts is 'doodle_explainer_2_short'
 * (the standard explainer look). The user can override per-short in
 * step 4 after assets render if they want a different style.
 */
async function enqueueAssetGeneration(short: ShortRow, batch: ShortsBatchRow): Promise<void> {
  // Don't double-enqueue.
  if (short.style_id || short.generation_progress?.phase) return;

  const params = (short.generation_params ?? {}) as { batch_idea_input?: BatchIdeaInput };
  const niche = params.batch_idea_input?.niche ?? 'general';

  const seconds =
    short.voiceover_duration_seconds
    ?? short.estimated_duration_seconds
    ?? Math.max(15, Math.round((short.word_count ?? 0) / 2.33));

  const styleId = 'doodle_explainer_2_short';
  const now = new Date().toISOString();
  const queued = {
    phase: 'queued' as const,
    label: 'Queued — Doodle assets will start shortly…',
    style_id: styleId,
    started_at: now,
    updated_at: now,
    job: {
      niche,
      base_t2i_model_id: 'atlas-gpt-image-2',
      variant_edit_primary: 'atlas' as const,
      max_variants: Math.max(4, Math.min(10, Math.round(seconds / 6))),
    },
  };

  await sql`
    UPDATE shorts
       SET style_id = ${styleId},
           generation_progress = ${JSON.stringify(queued)}::jsonb,
           updated_at = NOW()
     WHERE id = ${short.id}::uuid AND workspace_id = ${short.workspace_id}::uuid
  `;

  console.info('[shorts-batch assets-enqueued]', {
    short_id: short.id,
    batch_id: batch.id,
    style_id: styleId,
    niche,
    max_variants: queued.job.max_variants,
  });

  // Kick the shared shorts asset cron drain so the work starts now.
  // The drain is single-flight-locked, so concurrent calls collapse.
  try {
    const { triggerShortsAssetDrain } = await import('./shorts-asset-cron');
    await triggerShortsAssetDrain('batch-after-seo');
  } catch (err) {
    console.info('[shorts-batch assets-drain-trigger-failed]', {
      short_id: short.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Dispatch a short to the correct stage runner. Exposed so a
 *  per-short retry route can re-run just one short without going
 *  through the batch tick. */
export async function advanceShort(short: ShortRow, batch: ShortsBatchRow): Promise<StageOutcome> {
  const stage = nextStageFor(short);
  switch (stage) {
    case 'extract':   return runExtractStage(short);
    case 'voiceover': return runVoiceoverStage(short, batch);
    case 'seo':       return runSeoStage(short, batch);
    default:
      return { stage, shortId: short.id, ok: true, duration_ms: 0 };
  }
}

/**
 * Run one tick of the orchestrator for a single batch. Claims up to
 * MAX_PER_TICK shorts, runs each one's next stage in parallel,
 * recomputes batch totals, and (when applicable) advances the batch
 * status. Idempotent — calling twice in a row is safe; the second
 * call is a no-op if no shorts are advanceable.
 */
export async function processBatchTick(args: {
  batchId: string;
  workspaceId: string;
}): Promise<BatchTickResult> {
  const { batchId, workspaceId } = args;
  const t0 = Date.now();

  const bundle = await getBatchWithShorts(batchId, workspaceId);
  if (!bundle) {
    return { batch_id: batchId, claimed: 0, advanced: 0, failed: 0, done: false, duration_ms: 0 };
  }
  const { batch, shorts } = bundle;

  if (batch.status !== 'generating') {
    return { batch_id: batchId, claimed: 0, advanced: 0, failed: 0, done: false, duration_ms: Date.now() - t0 };
  }

  const claimed = pickShortsToAdvance(shorts);

  console.info('[shorts-batch claim-tick]', {
    batch_id: batchId,
    claimed_short_ids: claimed.map((s) => s.id),
    concurrency: claimed.length,
  });

  const outcomes = await Promise.all(claimed.map((s) => advanceShort(s, batch)));

  const advanced = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.filter((o) => !o.ok).length;

  // Re-fetch to see the post-tick state — totals + done check.
  const after = await getBatchWithShorts(batchId, workspaceId);
  let done = false;
  if (after && allShortsAtTerminal(after.shorts)) {
    await updateBatchStatus(batchId, workspaceId, 'review');
    done = true;
  }
  await recomputeBatchTotals(batchId, workspaceId);

  return {
    batch_id: batchId,
    claimed: claimed.length,
    advanced,
    failed,
    done,
    duration_ms: Date.now() - t0,
  };
}
