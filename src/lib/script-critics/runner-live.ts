/**
 * Live (streaming) script-panel runner.
 *
 * The synchronous runner in `runner.ts` blocks for ~90-120s and returns
 * one giant verdict. The live variant is an `AsyncGenerator<PanelEvent>`:
 * it runs the same four phases (Charter → Drafts → Deliberation → Chair)
 * but yields a typed event each time something interesting happens
 * (a phase started, a critic's draft finished, etc.).
 *
 * The route handler awaits each yield, persists the event to
 * `critic_panel_events` with a monotonic sequence number, and pushes a
 * matching `data:` frame down the SSE pipe to the client. A client that
 * disconnects mid-run can rejoin via /events?since=N and replay anything
 * it missed.
 *
 * Design choices:
 *   - Per-critic events for drafts + deliberations are emitted as each
 *     critic *finishes* (not in declaration order) — the parallel
 *     `Promise.all` is replaced with a "race + remove" loop. This gives
 *     the courtroom UI the natural "first verdict in" feel.
 *   - The runner intentionally REUSES helpers exported from `runner.ts`
 *     (normalizers, charter, unanimity check). Forking them would drift
 *     in a quarter and silently start producing different verdicts than
 *     the synchronous runner.
 *   - The runner does NOT touch the DB itself — persistence is the
 *     route's job. Keeping the runner pure-AsyncIterable also makes it
 *     trivial to unit-test without a postgres instance.
 */

import { generateText, getModelById } from '@/lib/ai';
import {
  SCRIPT_CRITICS,
  buildDraftPrompt,
  buildDeliberationPrompt,
  buildChairPrompt,
} from './prompts';
import {
  CHAIR_MODEL,
  checkScriptBundleUnanimity,
  emptyDraft,
  normalizeChair,
  normalizeDeliberation,
  normalizeDraft,
  runScriptCharter,
  safeParseLlmJson,
  type RawChairOutput,
  type RawDeliberationOutput,
  type RawDraftOutput,
} from './runner';
import type {
  ScriptCharter,
  ScriptCriticContext,
  ScriptCriticId,
  ScriptCriticReport,
  ScriptDeliberationNote,
  ScriptPanelVerdict,
} from './types';
import type { PanelEvent, PanelEventPhase, PanelEventType } from './panel-events';

export interface RunScriptPanelLiveArgs extends ScriptCriticContext {
  /** Pre-existing charter — pass on retry to skip the alignment phase. */
  charter?: ScriptCharter;
}

export interface RunScriptPanelLiveResult {
  verdict: ScriptPanelVerdict;
  charter: ScriptCharter | undefined;
}

/**
 * Strip the heavyweight `sequence_no` and `captured_at` fields from a
 * partial event payload — the runner doesn't know its sequence number
 * (the route assigns it) or wall clock (the route stamps it on persist).
 */
type EmittedEvent = Omit<PanelEvent, 'sequence_no' | 'captured_at'>;

const now = () => new Date().toISOString();

function event<P extends PanelEventPhase, T extends PanelEventType>(
  phase: P,
  event_type: T,
  critic_id: ScriptCriticId | null,
  payload: Record<string, unknown>,
): EmittedEvent {
  // The cast is safe because the caller threads the right phase + type +
  // payload combination at the call site below; widening the union here
  // keeps the call sites readable without losing exhaustiveness.
  return { phase, event_type, critic_id, payload } as EmittedEvent;
}

/**
 * Race a list of indexed in-flight promises and yield the first one that
 * settles (either fulfilled or rejected). The settled entry is removed from
 * the input list in place. Returns null when the list is empty.
 *
 * This is the load-bearing primitive that lets us emit per-critic events
 * as each critic finishes, rather than in declaration order.
 */
interface RaceWin<T> {
  ok: true;
  key: string;
  value: T;
}
interface RaceLoss {
  ok: false;
  key: string;
  error: unknown;
}
type RaceResult<T> = RaceWin<T> | RaceLoss;

async function raceFirst<T>(
  pending: Array<{ key: string; promise: Promise<T> }>,
): Promise<RaceResult<T> | null> {
  if (pending.length === 0) return null;
  const tagged: Array<Promise<RaceResult<T>>> = pending.map((p) =>
    p.promise.then(
      (value): RaceResult<T> => ({ ok: true, key: p.key, value }),
      (error: unknown): RaceResult<T> => ({ ok: false, key: p.key, error }),
    ),
  );
  const winner = await Promise.race(tagged);
  const idx = pending.findIndex((p) => p.key === winner.key);
  if (idx >= 0) pending.splice(idx, 1);
  return winner;
}

/**
 * The live runner. Yields events as the panel progresses; final yield is
 * the `panel:complete` event carrying the synthesized verdict.
 */
export async function* runScriptPanelLive(
  args: RunScriptPanelLiveArgs,
): AsyncGenerator<EmittedEvent, RunScriptPanelLiveResult, void> {
  const startedAt = Date.now();
  const ctx: ScriptCriticContext = {
    script: args.script,
    niche: args.niche,
    passNumber: args.passNumber,
    previousFeedback: args.previousFeedback,
    aggressiveness: args.aggressiveness,
    modelId: args.modelId,
  };

  yield event('panel', 'start', null, {
    niche: ctx.niche,
    pass_number: ctx.passNumber,
    aggressiveness: ctx.aggressiveness,
    model_id: ctx.modelId,
    script_preview: ctx.script.slice(0, 280),
  });

  // ─── Phase 0: Charter ────────────────────────────────────────────────
  let charter = args.charter;
  if (!charter) {
    yield event('charter', 'start', null, {});
    try {
      charter = await runScriptCharter(ctx);
      yield event('charter', 'complete', null, { charter });
    } catch (err) {
      yield event('charter', 'error', null, { message: errMsg(err) });
      // Charter failure is non-fatal — drafts run without alignment context.
      charter = undefined;
    }
  }

  // ─── Phase 1: Drafts (parallel, emit per-critic as each finishes) ─────
  const draftsByCritic: Partial<Record<ScriptCriticId, ScriptCriticReport>> = {};
  const draftPending: Array<{ key: string; promise: Promise<ScriptCriticReport> }> = [];
  for (const spec of SCRIPT_CRITICS) {
    yield event('draft', 'start', spec.id, {});
    draftPending.push({
      key: spec.id,
      promise: (async () => {
        const { system, user, userCachePrefix } = buildDraftPrompt(spec, ctx, charter);
        try {
          const raw = await generateText({
            modelId: ctx.modelId,
            prompt: user,
            systemPrompt: system,
            maxTokens: 3000,
            temperature: 0.3,
            cache: true,
            userCachePrefix,
          });
          const parsed = safeParseLlmJson<RawDraftOutput>(raw);
          if (!parsed) return emptyDraft(spec.id, 'Model returned unparseable JSON.');
          return normalizeDraft(spec.id, parsed);
        } catch (err) {
          return emptyDraft(spec.id, `Draft failed: ${errMsg(err)}`);
        }
      })(),
    });
  }
  while (draftPending.length > 0) {
    const winner = await raceFirst(draftPending);
    if (!winner) break;
    const criticId = winner.key as ScriptCriticId;
    if (!winner.ok) {
      // emptyDraft fallback already applied inside the worker — this branch
      // is defensive (should never fire) so the outer loop can never hang.
      yield event('draft', 'error', criticId, { message: errMsg(winner.error) });
      draftsByCritic[criticId] = emptyDraft(
        criticId,
        `Draft worker rejected: ${errMsg(winner.error)}`,
      );
      continue;
    }
    draftsByCritic[criticId] = winner.value;
    yield event('draft', 'complete', criticId, { draft: winner.value });
  }

  // Stable order matters for the deliberation phase (each critic sees its
  // peers' drafts) — re-collect in the SCRIPT_CRITICS declaration order.
  const drafts: ScriptCriticReport[] = SCRIPT_CRITICS.map(
    (spec) => draftsByCritic[spec.id] ?? emptyDraft(spec.id, 'Draft missing.'),
  );

  // ─── Phase 2: Deliberation (same race-and-emit pattern) ──────────────
  const notesByCritic: Partial<Record<ScriptCriticId, ScriptDeliberationNote>> = {};
  const delibPending: Array<{ key: string; promise: Promise<ScriptDeliberationNote> }> = [];
  for (const spec of SCRIPT_CRITICS) {
    yield event('deliberation', 'start', spec.id, {});
    const ownDraft = drafts.find((d) => d.critic === spec.id)!;
    const peerDrafts = drafts.filter((d) => d.critic !== spec.id);
    delibPending.push({
      key: spec.id,
      promise: (async () => {
        const { system, user, userCachePrefix } = buildDeliberationPrompt(
          spec,
          ctx,
          ownDraft,
          peerDrafts,
          charter,
        );
        try {
          const raw = await generateText({
            modelId: ctx.modelId,
            prompt: user,
            systemPrompt: system,
            maxTokens: 3000,
            temperature: 0.25,
            cache: true,
            userCachePrefix,
          });
          const parsed = safeParseLlmJson<RawDeliberationOutput>(raw);
          if (!parsed) {
            return {
              critic: spec.id,
              peerResponses: [],
              updatedScore: ownDraft.overall_score,
              updatedCategories: ownDraft.categories,
              updatedIssues: ownDraft.critical_issues,
              summary: 'Deliberation JSON unparseable; draft used as-is.',
              myNonNegotiables: [],
              myWillingToAccept: [],
              myPredictedScoreIfBundleApplied: ownDraft.overall_score,
            };
          }
          return normalizeDeliberation(spec.id, ownDraft, parsed);
        } catch {
          return {
            critic: spec.id,
            peerResponses: [],
            updatedScore: ownDraft.overall_score,
            updatedCategories: ownDraft.categories,
            updatedIssues: ownDraft.critical_issues,
            summary: 'Deliberation skipped; draft used as-is.',
            myNonNegotiables: [],
            myWillingToAccept: [],
            myPredictedScoreIfBundleApplied: ownDraft.overall_score,
          };
        }
      })(),
    });
  }
  while (delibPending.length > 0) {
    const winner = await raceFirst(delibPending);
    if (!winner) break;
    const criticId = winner.key as ScriptCriticId;
    if (!winner.ok) {
      yield event('deliberation', 'error', criticId, { message: errMsg(winner.error) });
      const own = drafts.find((d) => d.critic === criticId)!;
      notesByCritic[criticId] = {
        critic: criticId,
        peerResponses: [],
        updatedScore: own.overall_score,
        updatedCategories: own.categories,
        updatedIssues: own.critical_issues,
        summary: 'Deliberation worker rejected; draft used as-is.',
        myNonNegotiables: [],
        myWillingToAccept: [],
        myPredictedScoreIfBundleApplied: own.overall_score,
      };
      continue;
    }
    notesByCritic[criticId] = winner.value;
    yield event('deliberation', 'complete', criticId, { note: winner.value });
  }
  const deliberations: ScriptDeliberationNote[] = SCRIPT_CRITICS.map(
    (spec) => notesByCritic[spec.id]!,
  );

  // ─── Phase 3: Chair ──────────────────────────────────────────────────
  const chairModelId = getModelById(CHAIR_MODEL) ? CHAIR_MODEL : ctx.modelId;
  const chairFellBack = chairModelId !== CHAIR_MODEL;
  yield event('chair', 'start', null, { model_id: chairModelId });

  const { system: chairSystem, user: chairUser, userCachePrefix: chairPrefix } = buildChairPrompt(
    ctx,
    drafts,
    deliberations,
    charter,
  );
  let chairParsed: RawChairOutput | null = null;
  let chairError: string | null = null;
  try {
    const chairRaw = await generateText({
      modelId: chairModelId,
      prompt: chairUser,
      systemPrompt: chairSystem,
      maxTokens: 6000,
      temperature: 0.25,
      cache: true,
      userCachePrefix: chairPrefix,
    });
    chairParsed = safeParseLlmJson<RawChairOutput>(chairRaw);
    if (!chairParsed) chairError = 'Chair JSON unparseable — using deliberation consensus directly.';
  } catch (err) {
    chairError = `Chair call failed: ${errMsg(err)}`;
  }

  const verdict = normalizeChair(chairParsed ?? {}, drafts, deliberations);
  const prefixBits: string[] = [];
  if (chairFellBack) prefixBits.push(`[Chair fell back from ${CHAIR_MODEL} to ${chairModelId}]`);
  if (chairError) prefixBits.push(`[${chairError}]`);
  if (prefixBits.length > 0) {
    verdict.chair_summary = `${prefixBits.join(' ')}\n${verdict.chair_summary}`.slice(0, 1400);
    if (chairError) verdict.consensus_pass = false;
  }

  // Unanimity + per-critic predictions + charter — same logic as the
  // synchronous runner so both produce structurally identical verdicts.
  const llmSaysUnanimous =
    chairParsed && typeof (chairParsed as { bundle_unanimous?: boolean }).bundle_unanimous === 'boolean'
      ? (chairParsed as { bundle_unanimous: boolean }).bundle_unanimous
      : true;
  const objectiveCheck = checkScriptBundleUnanimity(verdict, deliberations);
  const bundleUnanimous = llmSaysUnanimous && objectiveCheck.unanimous;
  const dissent: ScriptPanelVerdict['dissent'] = bundleUnanimous
    ? []
    : [
        ...((chairParsed as { dissent?: Array<{ critic: string; objection: string }> } | null)?.dissent ?? [])
          .map((d) => ({
            critic: (SCRIPT_CRITICS.find((s) => s.id === d.critic)?.id ?? 'hook-coach') as ScriptCriticId,
            objection: String(d.objection || '').slice(0, 400),
          }))
          .filter((d) => d.objection),
        ...objectiveCheck.violations,
      ];
  const perCriticPredictions: Partial<Record<ScriptCriticId, number>> = {};
  for (const note of deliberations) perCriticPredictions[note.critic] = note.myPredictedScoreIfBundleApplied;

  verdict.bundle_unanimous = bundleUnanimous;
  verdict.dissent = dissent;
  verdict.per_critic_predictions = perCriticPredictions;
  verdict.charter = charter;
  verdict.deliberations = deliberations;

  if (chairError) {
    yield event('chair', 'error', null, { message: chairError });
  }
  yield event('chair', 'complete', null, { verdict });

  yield event('panel', 'complete', null, {
    verdict,
    duration_ms: Date.now() - startedAt,
  });

  return { verdict, charter };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// `now` is exported only for tests that want to stub the timestamp.
export const _internalsForTest = { now };
