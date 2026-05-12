/**
 * Pure failure-classifier + fallback-policy primitives for
 * `generateTextWithFallback` in [./ai.ts](./ai.ts).
 *
 * Why pure: classification logic must be unit-testable without
 * importing the whole ai.ts surface (which pulls Next.js cookies,
 * provider SDKs, and the spend-log infra). This file has zero
 * runtime deps so the test file can import + exercise it directly.
 *
 * The six-class split was set by the LLM Council pass on the
 * auto-pipeline plan — see `_plans/2026-05-12-auto-pipeline.md` for
 * the design rationale. The load-bearing rule: **content refusals
 * never trigger fallback**. A model declining to write something is
 * a content decision, not a transient error — silently retrying
 * into a different provider would ship content the primary model
 * declined to produce.
 *
 * Unknown errors also don't fall through. The council was explicit:
 * an unrecognised failure mode should surface so we learn what to
 * classify next time, not be papered over by a retry.
 */

/**
 * Failure classes the wrapper distinguishes. Append-only — never
 * reorder or rename (these strings are persisted in
 * `pipeline_run_videos.failure_class`).
 */
export type FailureClass =
  | 'transient_5xx'
  | 'rate_limit'
  | 'timeout'
  | 'empty_or_malformed'
  | 'content_refusal'
  | 'unknown';

/**
 * Classes that trigger fallback to the next model in the chain.
 * Refusal + unknown deliberately omitted.
 */
export const FALLBACK_TRIGGERS: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'transient_5xx',
  'rate_limit',
  'timeout',
  'empty_or_malformed',
]);

export interface FallbackAttempt {
  modelId: string;
  /** Set when the attempt failed. Absent on the successful attempt. */
  failureClass?: FailureClass;
  /** Short human-readable message — included verbatim in the
   *  surfaced error so callers can show the user what went wrong. */
  failureMessage?: string;
  durationMs: number;
}

/**
 * Thrown when the whole chain is exhausted, OR when an attempt
 * hits a non-fallback class (refusal/unknown) and the wrapper
 * short-circuits. The `attempts` field carries the full history
 * so the orchestrator can persist it onto `pipeline_run_videos`.
 */
export class GenerateFailure extends Error {
  public readonly failureClass: FailureClass;
  public readonly attempts: ReadonlyArray<FallbackAttempt>;

  constructor(failureClass: FailureClass, attempts: ReadonlyArray<FallbackAttempt>) {
    const summary = attempts
      .map((a) => `${a.modelId}: ${a.failureClass ?? 'ok'}`)
      .join(' → ');
    super(`generateTextWithFallback: ${failureClass} after ${attempts.length} attempt(s) [${summary}]`);
    this.name = 'GenerateFailure';
    this.failureClass = failureClass;
    this.attempts = attempts;
  }
}

/**
 * Classify a thrown error from `generateText`. Provider SDKs put
 * the HTTP status on an unspecified subset of fields (anthropic
 * SDK uses `status`, OpenAI uses `status` too, Google wraps
 * everything in a regenerated Error), so we duck-type the
 * common shapes and fall through to message-text heuristics.
 *
 * Returns `'unknown'` when nothing matches — the caller must NOT
 * fall through on unknown errors. That's the safe default.
 */
export function classifyFailure(err: unknown): FailureClass {
  if (err === null || err === undefined) return 'unknown';

  // Native AbortError or anything labelled as one — fetch + several
  // SDKs surface timeouts this way. Check before the message
  // heuristics so AbortError doesn't get mis-classified as unknown
  // when its message is something generic like "aborted".
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return 'timeout';
  }

  // Status code from typed SDK errors. The exact field varies by
  // provider — `status` (Anthropic, OpenAI), `statusCode` (some
  // fetch wrappers), `response.status` (axios-style).
  const status = extractStatus(err);
  if (typeof status === 'number') {
    if (status === 429) return 'rate_limit';
    if (status >= 500 && status < 600) return 'transient_5xx';
    // Other 4xx are typically caller-side mistakes (400, 401, 403,
    // 404, 422). Don't fall through — those need a code fix, not a
    // different model.
    if (status >= 400 && status < 500) return 'unknown';
  }

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Content-policy refusals from the SDK exception layer. Most
  // providers return refusals as text (handled by classifyResponse),
  // but occasionally they raise instead — Anthropic's
  // policy_violation_error is the canonical example.
  if (
    lower.includes('policy_violation') ||
    lower.includes('content_policy') ||
    lower.includes('content policy') ||
    (lower.includes('policy') && (lower.includes('violation') || lower.includes('refused') || lower.includes('declined')))
  ) {
    return 'content_refusal';
  }

  // Message-text patterns for rate limits and 5xx — covers the
  // Perplexity / Kie / plain-fetch paths where the HTTP status was
  // baked into the thrown message but didn't land on a typed field.
  if (/\b429\b/.test(msg) || lower.includes('rate limit') || lower.includes('ratelimit') || lower.includes('too many requests')) {
    return 'rate_limit';
  }
  if (/\b5\d{2}\b/.test(msg) || lower.includes('internal server error') || lower.includes('bad gateway') || lower.includes('service unavailable') || lower.includes('gateway timeout')) {
    // gateway timeout maps to 504 — keep as 5xx not timeout (the
    // upstream's timeout, not ours; falling to next model is the
    // right move either way).
    return 'transient_5xx';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout') || lower.includes('econnreset')) {
    return 'timeout';
  }

  return 'unknown';
}

/**
 * Classify a non-throwing response from `generateText`. Returns
 * `null` when the response is acceptable; otherwise returns the
 * failure class so the wrapper can decide whether to fall through.
 *
 * Empty / whitespace-only response → `empty_or_malformed` (fall
 * through). A canonical refusal opening → `content_refusal` (do
 * NOT fall through). Anything else passes.
 */
export function classifyResponse(text: string): FailureClass | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty_or_malformed';
  if (isRefusalText(trimmed)) return 'content_refusal';
  return null;
}

/**
 * Tight prefix-match on canonical refusal openings. False negatives
 * (a refusal phrased differently) are acceptable — they fall through
 * to the next model, which is the original failure mode the council
 * warned about, but at least no worse than the status quo. False
 * positives (legitimate content that happens to start with these
 * phrases) would prevent fallback on a real transient failure — but
 * "I cannot guarantee X" or "I won't be able to attend" is vanishing
 * rare in a script-generation context.
 *
 * The opening anchor matters: a refusal that surfaces mid-paragraph
 * is much rarer than one that opens the response, and the false-
 * positive risk on a mid-text match is higher.
 */
function isRefusalText(trimmed: string): boolean {
  // Only inspect the opening — refusals lead with the refusal.
  const opening = trimmed.slice(0, 200).toLowerCase();
  return REFUSAL_OPENINGS.test(opening);
}

/**
 * Canonical refusal openings. Anchored to the start of the string.
 * Add new patterns here as we observe them in production — keep the
 * patterns specific to avoid false positives.
 */
// Multiple branches because "I'm" (no space after `i`) can't share a
// branch with "I cannot" (space after `i`). Splitting keeps each
// alternative simple and avoids \s? optionality everywhere.
const REFUSAL_OPENINGS = new RegExp(
  '^(?:' +
    // "I cannot ...", "I can't ...", "I won't ...", "I am unable to ...",
    // "I do not feel comfortable", "I must decline"
    "i (?:cannot|can'?t|won'?t|am unable to|do not (?:feel comfortable|feel able)|must decline)" +
    // "I'm unable to ...", "I'm not able to ..."
    "|i'?m (?:unable to|not able to)" +
    // "I'm sorry, but I can't ..."
    "|i'?m sorry,? but i (?:can'?t|cannot|won'?t)" +
    // "I apologize, but I can't ..."
    "|i apologize,? but i (?:can'?t|cannot|won'?t)" +
    // "Sorry, I can't ..." / "Sorry, but I can't ..."
    "|sorry,? (?:but )?i (?:can'?t|cannot|won'?t)" +
    // "As an AI, I can't ..."
    "|as an ai,? i (?:can'?t|cannot|won'?t)" +
    // "Unfortunately, I can't ..."
    "|unfortunately,? i (?:can'?t|cannot|won'?t)" +
  ')'
);

export interface FallbackChainResult {
  /** The successful response text. */
  text: string;
  /** Which model in the chain produced the success. */
  modelUsed: string;
  /** Per-attempt log including failed prior attempts. The last
   *  entry is the successful one (no `failureClass`). */
  attempts: ReadonlyArray<FallbackAttempt>;
}

/**
 * Pure chain-loop. Takes a `call(modelId)` function and walks the
 * chain, classifying failures and short-circuiting on non-fallback
 * classes (refusal, unknown). The wrapper in ai.ts is a 3-line shim
 * that supplies `call` as `generateText(buildOpts(modelId))`.
 *
 * Pure here means: no provider SDK imports, no Next.js imports, no
 * env-var reads. The test file imports this directly + supplies a
 * stub `call`. Logging is delegated via the optional `onAttempt`
 * hook so the ai.ts shim can wire it into the project logger
 * without forcing the test path through it.
 *
 * Throws `GenerateFailure` when the chain is exhausted OR a
 * non-fallback class is hit. Throws plain `Error` for malformed
 * input (empty chain, unknown model ids).
 */
export async function runFallbackChain(
  chain: readonly string[],
  call: (modelId: string) => Promise<string>,
  opts: {
    isKnownModel?: (modelId: string) => boolean;
    onAttempt?: (attempt: FallbackAttempt) => void;
    now?: () => number;
  } = {},
): Promise<FallbackChainResult> {
  if (chain.length === 0) {
    throw new Error('runFallbackChain: empty model chain');
  }

  const isKnownModel = opts.isKnownModel ?? (() => true);
  const now = opts.now ?? (() => Date.now());

  // Filter out unknown ids up front. Silently skipping would let a
  // typo in the chain config silently degrade to a shorter chain.
  const unknown = chain.filter((id) => !isKnownModel(id));
  if (unknown.length > 0) {
    throw new Error(`runFallbackChain: unknown model id(s) in chain: ${unknown.join(', ')}`);
  }

  const attempts: FallbackAttempt[] = [];
  let lastClass: FailureClass = 'unknown';

  for (const modelId of chain) {
    const t0 = now();
    try {
      const text = await call(modelId);
      const responseClass = classifyResponse(text);

      if (responseClass === null) {
        // Success.
        const attempt: FallbackAttempt = { modelId, durationMs: now() - t0 };
        attempts.push(attempt);
        opts.onAttempt?.(attempt);
        return { text, modelUsed: modelId, attempts };
      }

      const attempt: FallbackAttempt = {
        modelId,
        failureClass: responseClass,
        failureMessage: `response classified as ${responseClass}`,
        durationMs: now() - t0,
      };
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      lastClass = responseClass;

      if (!FALLBACK_TRIGGERS.has(responseClass)) {
        throw new GenerateFailure(responseClass, attempts);
      }
      // Else loop to next model.
    } catch (err) {
      if (err instanceof GenerateFailure) throw err;

      const failureClass = classifyFailure(err);
      const failureMessage = err instanceof Error ? err.message : String(err);
      const attempt: FallbackAttempt = {
        modelId,
        failureClass,
        failureMessage,
        durationMs: now() - t0,
      };
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      lastClass = failureClass;

      if (!FALLBACK_TRIGGERS.has(failureClass)) {
        throw new GenerateFailure(failureClass, attempts);
      }
      // Else loop to next model.
    }
  }

  throw new GenerateFailure(lastClass, attempts);
}

/**
 * Best-effort HTTP-status extraction from a thrown error of unknown
 * shape. Walks the typical provider-SDK fields. Returns `undefined`
 * when nothing looks numeric.
 */
function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const obj = err as Record<string, unknown>;

  if (typeof obj.status === 'number') return obj.status;
  if (typeof obj.statusCode === 'number') return obj.statusCode;

  const response = obj.response;
  if (typeof response === 'object' && response !== null) {
    const rs = (response as Record<string, unknown>).status;
    if (typeof rs === 'number') return rs;
  }

  // Anthropic SDK wraps status inside `error.status` on some
  // responses. Defensive — only checked if the prior fields missed.
  const inner = obj.error;
  if (typeof inner === 'object' && inner !== null) {
    const is = (inner as Record<string, unknown>).status;
    if (typeof is === 'number') return is;
  }

  return undefined;
}
