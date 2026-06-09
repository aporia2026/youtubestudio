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
import { retryTransient } from './shorts-batch-retry';
import { DEFAULT_BASE_T2I_MODEL_ID, resolveBaseT2iModelId } from './shorts-base-t2i-types';

/** Concurrency cap per tick. Three is enough to keep wall-clock
 *  decent (3 voiceover calls in parallel ≈ 30s instead of 90s) while
 *  staying well under ElevenLabs's typical concurrency limits and
 *  the Vercel function budget. */
export const MAX_PER_TICK = 3;

/** How long a per-short batch-tick claim is valid. Picked to be longer
 *  than any single stage (the slowest are voiceover ~30 s and SEO
 *  generation ~20 s), but short enough that a crashed function unlocks
 *  before the user gets impatient. The orchestrator releases its own
 *  claims at end-of-tick; this lease is a backstop. */
const BATCH_TICK_LEASE_SECONDS = 180;

/** Pick up to `MAX_PER_TICK` shorts from the batch that the
 *  orchestrator can actually advance this tick. 'awaiting_render'
 *  shorts are intentionally skipped — they're owned by the existing
 *  asset pipeline cron + the render route, not this orchestrator. */
export function pickShortsToAdvance(shorts: readonly ShortRow[]): ShortRow[] {
  const out: ShortRow[] = [];
  for (const s of shorts) {
    const stage = nextStageFor(s);
    if (
      stage === 'extract' ||
      stage === 'voiceover' ||
      stage === 'seo' ||
      stage === 'trigger_render'
    ) {
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

    const raw = await retryTransient(
      () =>
        generateText({
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
        }),
      {
        onRetry: ({ attempt, delayMs, failureClass, message }) =>
          console.info('[shorts-batch retry]', {
            stage: 'extract', short_id: short.id, attempt, delay_ms: delayMs, failure_class: failureClass, message,
          }),
      },
    );

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
      // Per QA L2: the prior message told the user to "set a default
      // voice on the batch before generating" — but by the time the
      // orchestrator runs, the batch is in 'generating' status and
      // `updateBatchDefaults` is guarded against that status, so the
      // user literally can't act on the message.
      throw new Error('Voice id was missing when the batch started generating. Cancel the batch and recreate it with a voice picked in step 2.');
    }

    await retryTransient(
      () =>
        generateShortVoiceover({
          shortId: short.id,
          workspaceId: short.workspace_id,
          voiceId,
        }),
      {
        onRetry: ({ attempt, delayMs, failureClass, message }) =>
          console.info('[shorts-batch retry]', {
            stage: 'voiceover', short_id: short.id, attempt, delay_ms: delayMs, failure_class: failureClass, message,
          }),
      },
    );

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

    const raw = await retryTransient(
      () =>
        generateText({
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
        }),
      {
        onRetry: ({ attempt, delayMs, failureClass, message }) =>
          console.info('[shorts-batch retry]', {
            stage: 'seo', short_id: short.id, attempt, delay_ms: delayMs, failure_class: failureClass, message,
          }),
      },
    );

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
    // so work starts immediately. AWAITED (not fire-and-forget):
    // Vercel suspends the function the instant the response returns,
    // so an unregistered background promise gets killed mid-step.
    // The drain has its own time budget (~280s) and the per-tick cap
    // bounds wall-clock; the cron is also a backstop. Failure here is
    // logged but doesn't fail the SEO stage.
    try {
      await enqueueAssetGeneration(short, batch);
    } catch (err) {
      console.info('[shorts-batch stage assets-enqueue error]', {
        short_id: short.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }

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
  // Honour the per-batch picker if set, otherwise fall back to the
  // user's per-account default (resolved by the asset cron's model
  // resolver further downstream), with the registry-level default as
  // the floor. `resolveBaseT2iModelId` narrows + sanitises any stale
  // model id stored on an old batch.
  const baseT2iModelId = resolveBaseT2iModelId(batch.defaults.baseT2iModelId ?? DEFAULT_BASE_T2I_MODEL_ID);
  const queued = {
    phase: 'queued' as const,
    label: 'Queued — Doodle assets will start shortly…',
    style_id: styleId,
    started_at: now,
    updated_at: now,
    job: {
      niche,
      base_t2i_model_id: baseT2iModelId,
      variant_edit_primary: 'atlas' as const,
      max_variants: Math.max(4, Math.min(10, Math.round(seconds / 6))),
    },
  };

  // Clear generation_claimed_at + generation_claimed_by_tick at the
  // same time so any stale claim from a previous crashed attempt
  // doesn't keep the cron's WHERE clause from picking this short up.
  // (Mirrors the /generate-style-assets route's UPDATE — without these,
  // a short whose previous tick died with a non-null lease would sit
  // queued forever until LEASE_SECONDS expired, and on a fresh row
  // they're already null so this is a no-op.)
  const { rowCount } = await sql`
    UPDATE shorts
       SET style_id = ${styleId},
           generation_progress = ${JSON.stringify(queued)}::jsonb,
           generation_claimed_at = NULL,
           generation_claimed_by_tick = NULL,
           updated_at = NOW()
     WHERE id = ${short.id}::uuid AND workspace_id = ${short.workspace_id}::uuid
  `;

  // Per QA finding H3: previously this UPDATE was silently a no-op if
  // the WHERE clause didn't match (cross-workspace drift, deleted row,
  // etc.). Without a rowCount check the enqueue would keep "succeeding"
  // every tick because nothing observable changed on the row, locking
  // the orchestrator into an infinite loop of no-ops. Log explicitly
  // so the failure is greppable.
  if (rowCount === 0) {
    console.error('[shorts-batch assets-enqueue-no-match]', {
      short_id: short.id,
      batch_id: batch.id,
      workspace_id: short.workspace_id,
      message: 'Asset enqueue UPDATE matched 0 rows — short may have been deleted or moved workspaces. Will retry next tick.',
    });
    return;
  }

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
 *  through the batch tick.
 *
 *  `sessionCookie` is the caller's `yt_studio_session` cookie value,
 *  forwarded so the render stage can call POST /api/render/short
 *  with the same auth the user has. Optional — the trigger_render
 *  stage degrades to "skipped, user must trigger render manually"
 *  if it's missing. */
export async function advanceShort(
  short: ShortRow,
  batch: ShortsBatchRow,
  sessionCookie?: string,
): Promise<StageOutcome> {
  const stage = nextStageFor(short);
  switch (stage) {
    case 'extract':         return runExtractStage(short);
    case 'voiceover':       return runVoiceoverStage(short, batch);
    case 'seo':             return runSeoStage(short, batch);
    case 'trigger_render':  return runTriggerRenderStage(short, sessionCookie);
    default:
      return { stage, shortId: short.id, ok: true, duration_ms: 0 };
  }
}

/** Kick off the final mp4 render for a short whose assets are ready.
 *  Sets phase='rendering' before the call so a parallel tick doesn't
 *  re-fire. On failure, falls back to 'awaiting_render' so the next
 *  tick can retry (or the user can trigger manually). */
async function runTriggerRenderStage(short: ShortRow, sessionCookie?: string): Promise<StageOutcome> {
  const t0 = Date.now();
  try {
    if (!sessionCookie) {
      return {
        stage: 'trigger_render',
        shortId: short.id,
        ok: true,
        duration_ms: Date.now() - t0,
      };
    }

    // Mark as rendering BEFORE the kickoff so concurrent ticks don't
    // both fire the render route. The kickoff returns ~300ms (Lambda)
    // or holds the function for the duration of the render (Vercel);
    // either way nextStageFor sees 'rendering' and returns
    // 'awaiting_render', which pickShortsToAdvance skips.
    const now = new Date().toISOString();
    await sql`
      UPDATE shorts
         SET generation_progress = jsonb_set(
               COALESCE(generation_progress, '{}'::jsonb),
               '{phase}',
               '"rendering"'::jsonb
             ) || jsonb_build_object(
               'label', 'Render queued — final mp4 will appear when done',
               'updated_at', ${now}::text
             ),
             updated_at = NOW()
       WHERE id = ${short.id}::uuid
    `;

    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL
      || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
      || (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`)
      || 'http://localhost:3000';

    await retryTransient(
      async () => {
        const res = await fetch(`${baseUrl}/api/render/short`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `yt_studio_session=${sessionCookie}`,
          },
          body: JSON.stringify({ shortId: short.id }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => `HTTP ${res.status}`);
          // Throw with the HTTP status baked into the message so the
          // classifier picks up the 5xx vs 4xx split correctly.
          throw new Error(`HTTP ${res.status}: ${(detail || '').slice(0, 200)}`);
        }
      },
      {
        onRetry: ({ attempt, delayMs, failureClass, message }) =>
          console.info('[shorts-batch retry]', {
            stage: 'trigger_render', short_id: short.id, attempt, delay_ms: delayMs, failure_class: failureClass, message,
          }),
      },
    );

    const ms = Date.now() - t0;
    console.info('[shorts-batch stage trigger-render]', {
      short_id: short.id,
      batch_id: short.batch_id,
      duration_ms: ms,
    });
    return { stage: 'trigger_render', shortId: short.id, ok: true, duration_ms: ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    // Roll back the 'rendering' marker so a subsequent tick can retry.
    // Per QA finding H1: the previous `.catch(() => {})` swallowed
    // rollback failures silently, leaving the row stuck at
    // phase='rendering' permanently with no log evidence. Now we log
    // the rollback failure explicitly so debugging is possible.
    try {
      await sql`
        UPDATE shorts
           SET generation_progress = generation_progress - 'phase',
               updated_at = NOW()
         WHERE id = ${short.id}::uuid
      `;
    } catch (rollbackErr) {
      const rmsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      console.error('[shorts-batch stage rollback-failed]', {
        short_id: short.id,
        stage: 'trigger_render',
        original_error: message.slice(0, 200),
        rollback_error: rmsg.slice(0, 200),
      });
    }
    console.info('[shorts-batch stage error]', { short_id: short.id, stage: 'trigger_render', message: message.slice(0, 200) });
    return { stage: 'trigger_render', shortId: short.id, ok: false, error: message, duration_ms: ms };
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
  /** Forwarded from run-tick so the trigger_render stage can call
   *  /api/render/short with the user's auth. Optional. */
  sessionCookie?: string;
}): Promise<BatchTickResult> {
  const { batchId, workspaceId, sessionCookie } = args;
  const t0 = Date.now();

  const bundle = await getBatchWithShorts(batchId, workspaceId);
  if (!bundle) {
    return { batch_id: batchId, claimed: 0, advanced: 0, failed: 0, done: false, duration_ms: 0 };
  }
  const { batch, shorts } = bundle;

  if (batch.status !== 'generating') {
    return { batch_id: batchId, claimed: 0, advanced: 0, failed: 0, done: false, duration_ms: Date.now() - t0 };
  }

  const candidates = pickShortsToAdvance(shorts);

  // Per QA finding H5: atomic per-short claim before running any
  // stage. Without this, two concurrent run-tick calls (browser +
  // Vercel cron + a second browser tab) would each spawn the same
  // stage runner for the same short, doubling LLM/voiceover spend
  // and racing on column writes. The `generation_claimed_at` column
  // is shared with the asset cron, but the two never claim the same
  // short — the cron only touches phase IN ('queued', 'planning',
  // 'base', 'variant'), the orchestrator's pre-asset stages run
  // when phase is undefined/{}, and trigger_render runs after the
  // cron has finalized (cleared phase). The lease auto-expires
  // after BATCH_TICK_LEASE_SECONDS so a crashed function doesn't
  // permanently quarantine the short.
  const claimed: ShortRow[] = [];
  for (const candidate of candidates) {
    const { rowCount } = await sql`
      UPDATE shorts
         SET generation_claimed_at = NOW(),
             generation_claimed_by_tick = ${'batch-tick:' + Date.now()}
       WHERE id = ${candidate.id}::uuid
         AND workspace_id = ${workspaceId}::uuid
         AND (
           generation_claimed_at IS NULL
           OR generation_claimed_at < NOW() - make_interval(secs => ${BATCH_TICK_LEASE_SECONDS})
         )
    `;
    if (rowCount === 1) {
      claimed.push(candidate);
    } else {
      console.info('[shorts-batch claim-skipped]', {
        short_id: candidate.id,
        reason: 'another tick holds the lease',
      });
    }
  }

  console.info('[shorts-batch claim-tick]', {
    batch_id: batchId,
    candidate_short_ids: candidates.map((s) => s.id),
    claimed_short_ids: claimed.map((s) => s.id),
    concurrency: claimed.length,
  });

  // Release leases after stages complete, regardless of success.
  // Use try/finally so a thrown stage runner still releases.
  let outcomes: StageOutcome[];
  try {
    outcomes = await Promise.all(claimed.map((s) => advanceShort(s, batch, sessionCookie)));
  } finally {
    // Release leases in parallel — one statement per short because
    // @vercel/postgres's tagged template doesn't accept array
    // parameters for ANY(...). Cost is ~3 round-trips at MAX_PER_TICK
    // = 3, which is fine for the end-of-tick cleanup path.
    if (claimed.length > 0) {
      await Promise.all(
        claimed.map((s) =>
          sql`
            UPDATE shorts
               SET generation_claimed_at = NULL,
                   generation_claimed_by_tick = NULL
             WHERE id = ${s.id}::uuid
               AND workspace_id = ${workspaceId}::uuid
          `.catch((err) => {
            console.error('[shorts-batch claim-release-failed]', {
              short_id: s.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
        ),
      );
    }
  }

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
