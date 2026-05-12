import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  classifyResponse,
  FALLBACK_TRIGGERS,
  GenerateFailure,
  runFallbackChain,
  type FailureClass,
} from '@/lib/ai-fallback';

// ────────────────────────────────────────────────────────────────────
// classifyFailure
// ────────────────────────────────────────────────────────────────────

describe('classifyFailure', () => {
  it('returns unknown for null/undefined', () => {
    expect(classifyFailure(null)).toBe('unknown');
    expect(classifyFailure(undefined)).toBe('unknown');
  });

  it('detects AbortError as timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyFailure(err)).toBe('timeout');
  });

  it('detects TimeoutError name as timeout', () => {
    const err = new Error('whatever');
    err.name = 'TimeoutError';
    expect(classifyFailure(err)).toBe('timeout');
  });

  it('detects status 429 as rate_limit', () => {
    expect(classifyFailure({ status: 429, message: 'too many' })).toBe('rate_limit');
  });

  it('detects 5xx statuses as transient_5xx', () => {
    expect(classifyFailure({ status: 500 })).toBe('transient_5xx');
    expect(classifyFailure({ status: 502 })).toBe('transient_5xx');
    expect(classifyFailure({ status: 503 })).toBe('transient_5xx');
    expect(classifyFailure({ status: 504 })).toBe('transient_5xx');
    expect(classifyFailure({ status: 599 })).toBe('transient_5xx');
  });

  it('classifies caller-side 4xx (other than 429) as unknown', () => {
    // 400/401/403/404 are usually a code bug, not a transient failure.
    // Falling over to another model would mask the real issue.
    expect(classifyFailure({ status: 400 })).toBe('unknown');
    expect(classifyFailure({ status: 401 })).toBe('unknown');
    expect(classifyFailure({ status: 403 })).toBe('unknown');
    expect(classifyFailure({ status: 404 })).toBe('unknown');
    expect(classifyFailure({ status: 422 })).toBe('unknown');
  });

  it('reads status from response.status (axios shape)', () => {
    expect(classifyFailure({ response: { status: 503 } })).toBe('transient_5xx');
  });

  it('reads status from error.status (nested SDK shape)', () => {
    expect(classifyFailure({ error: { status: 429 } })).toBe('rate_limit');
  });

  it('detects rate_limit from message text when status is missing', () => {
    expect(classifyFailure(new Error('Rate limit exceeded'))).toBe('rate_limit');
    expect(classifyFailure(new Error('HTTP 429 Too Many Requests'))).toBe('rate_limit');
    expect(classifyFailure(new Error('429'))).toBe('rate_limit');
  });

  it('detects transient_5xx from message text', () => {
    expect(classifyFailure(new Error('500 Internal Server Error'))).toBe('transient_5xx');
    expect(classifyFailure(new Error('Bad Gateway'))).toBe('transient_5xx');
    expect(classifyFailure(new Error('Service Unavailable'))).toBe('transient_5xx');
    expect(classifyFailure(new Error('Gateway Timeout'))).toBe('transient_5xx');
  });

  it('detects timeout from message text', () => {
    expect(classifyFailure(new Error('Request timeout'))).toBe('timeout');
    expect(classifyFailure(new Error('connection timed out'))).toBe('timeout');
    expect(classifyFailure(new Error('ETIMEDOUT'))).toBe('timeout');
    expect(classifyFailure(new Error('ECONNRESET'))).toBe('timeout');
  });

  it('detects content_refusal from policy messages', () => {
    expect(classifyFailure(new Error('policy_violation_error'))).toBe('content_refusal');
    expect(classifyFailure(new Error('content_policy violated'))).toBe('content_refusal');
    expect(classifyFailure(new Error('Content policy violation'))).toBe('content_refusal');
    expect(classifyFailure(new Error('request refused due to policy'))).toBe('content_refusal');
    expect(classifyFailure(new Error('declined due to policy'))).toBe('content_refusal');
  });

  it('returns unknown for unrecognised errors', () => {
    expect(classifyFailure(new Error('something weird happened'))).toBe('unknown');
    expect(classifyFailure('plain string')).toBe('unknown');
    expect(classifyFailure(42)).toBe('unknown');
    expect(classifyFailure({})).toBe('unknown');
  });

  it('prefers AbortError over a 5xx-looking message', () => {
    const err = new Error('aborted with 500 something'); // status not set
    err.name = 'AbortError';
    expect(classifyFailure(err)).toBe('timeout');
  });

  it('prefers numeric status over message heuristics', () => {
    // status 429 wins over a message that mentions 5xx
    expect(classifyFailure({ status: 429, message: '500 Internal Server Error' })).toBe('rate_limit');
  });
});

// ────────────────────────────────────────────────────────────────────
// classifyResponse
// ────────────────────────────────────────────────────────────────────

describe('classifyResponse', () => {
  it('returns null for normal content', () => {
    expect(classifyResponse('Here is your script: Once upon a time...')).toBeNull();
    expect(classifyResponse('Hello world')).toBeNull();
    expect(classifyResponse('A short but valid response.')).toBeNull();
  });

  it('detects empty / whitespace-only as empty_or_malformed', () => {
    expect(classifyResponse('')).toBe('empty_or_malformed');
    expect(classifyResponse('   ')).toBe('empty_or_malformed');
    expect(classifyResponse('\n\n\t')).toBe('empty_or_malformed');
  });

  it('detects common refusal openings', () => {
    expect(classifyResponse("I cannot help with that request.")).toBe('content_refusal');
    expect(classifyResponse("I can't write that.")).toBe('content_refusal');
    expect(classifyResponse("I won't generate that content.")).toBe('content_refusal');
    expect(classifyResponse("I am unable to comply with this request.")).toBe('content_refusal');
    expect(classifyResponse("I'm unable to help with that.")).toBe('content_refusal');
    expect(classifyResponse("I'm not able to write that script.")).toBe('content_refusal');
    expect(classifyResponse("I'm sorry, but I can't do that.")).toBe('content_refusal');
    expect(classifyResponse("I apologize, but I cannot fulfill this.")).toBe('content_refusal');
    expect(classifyResponse("Sorry, but I can't help with this.")).toBe('content_refusal');
    expect(classifyResponse("As an AI, I cannot assist with that.")).toBe('content_refusal');
    expect(classifyResponse("Unfortunately, I cannot write this.")).toBe('content_refusal');
    expect(classifyResponse("I must decline this request.")).toBe('content_refusal');
  });

  it('only matches refusals at the opening — mid-text "I cannot" passes through', () => {
    // Realistic case: a script that contains "the protagonist says 'I cannot believe it'"
    const text = "Once upon a time, the hero said 'I cannot believe my eyes' when he saw the dragon.";
    expect(classifyResponse(text)).toBeNull();
  });

  it('case-insensitive on refusal openings', () => {
    expect(classifyResponse("I CANNOT HELP")).toBe('content_refusal');
    expect(classifyResponse("i can't help")).toBe('content_refusal');
  });

  it('trims before checking — leading whitespace does not hide a refusal', () => {
    expect(classifyResponse("\n\n   I cannot help with that.")).toBe('content_refusal');
  });
});

// ────────────────────────────────────────────────────────────────────
// FALLBACK_TRIGGERS — must include transient classes, exclude
// refusal + unknown
// ────────────────────────────────────────────────────────────────────

describe('FALLBACK_TRIGGERS', () => {
  it('includes the four transient classes', () => {
    expect(FALLBACK_TRIGGERS.has('transient_5xx')).toBe(true);
    expect(FALLBACK_TRIGGERS.has('rate_limit')).toBe(true);
    expect(FALLBACK_TRIGGERS.has('timeout')).toBe(true);
    expect(FALLBACK_TRIGGERS.has('empty_or_malformed')).toBe(true);
  });

  it('excludes content_refusal — council-mandated safety rail', () => {
    expect(FALLBACK_TRIGGERS.has('content_refusal')).toBe(false);
  });

  it('excludes unknown — unknown errors must surface, not get papered over', () => {
    expect(FALLBACK_TRIGGERS.has('unknown')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// runFallbackChain — chain-loop behaviour
// ────────────────────────────────────────────────────────────────────

describe('runFallbackChain', () => {
  // A fake `call(modelId)` that pulls from a scripted sequence of
  // results. Each entry is either {text} (resolves) or {throw}
  // (rejects). The same modelId can map to a different behaviour
  // per attempt because the chain visits each id at most once.
  function scripted(results: Record<string, { text?: string; throw?: unknown }>) {
    const seen: string[] = [];
    const call = async (modelId: string): Promise<string> => {
      seen.push(modelId);
      const r = results[modelId];
      if (!r) throw new Error(`scripted: no result for ${modelId}`);
      if (r.throw !== undefined) throw r.throw;
      return r.text ?? '';
    };
    return { call, seen };
  }

  it('throws on empty chain', async () => {
    await expect(runFallbackChain([], async () => 'x')).rejects.toThrow(/empty model chain/);
  });

  it('throws on unknown model ids in chain', async () => {
    await expect(
      runFallbackChain(['a', 'b'], async () => 'x', { isKnownModel: (id) => id === 'a' }),
    ).rejects.toThrow(/unknown model id\(s\) in chain: b/);
  });

  it('returns the first model on first-attempt success', async () => {
    const { call, seen } = scripted({ a: { text: 'hello' }, b: { text: 'unused' } });
    const result = await runFallbackChain(['a', 'b'], call);
    expect(result.text).toBe('hello');
    expect(result.modelUsed).toBe('a');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].failureClass).toBeUndefined();
    expect(seen).toEqual(['a']); // didn't touch b
  });

  it('falls through on transient failure and returns the next model', async () => {
    const { call, seen } = scripted({
      a: { throw: Object.assign(new Error('503'), { status: 503 }) },
      b: { text: 'recovered' },
    });
    const result = await runFallbackChain(['a', 'b'], call);
    expect(result.text).toBe('recovered');
    expect(result.modelUsed).toBe('b');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].failureClass).toBe('transient_5xx');
    expect(result.attempts[1].failureClass).toBeUndefined();
    expect(seen).toEqual(['a', 'b']);
  });

  it('falls through on rate_limit', async () => {
    const { call } = scripted({
      a: { throw: Object.assign(new Error('429'), { status: 429 }) },
      b: { text: 'ok' },
    });
    const result = await runFallbackChain(['a', 'b'], call);
    expect(result.modelUsed).toBe('b');
    expect(result.attempts[0].failureClass).toBe('rate_limit');
  });

  it('falls through on timeout', async () => {
    const timeoutErr = new Error('aborted');
    timeoutErr.name = 'AbortError';
    const { call } = scripted({ a: { throw: timeoutErr }, b: { text: 'ok' } });
    const result = await runFallbackChain(['a', 'b'], call);
    expect(result.modelUsed).toBe('b');
    expect(result.attempts[0].failureClass).toBe('timeout');
  });

  it('falls through on empty response', async () => {
    const { call } = scripted({ a: { text: '' }, b: { text: 'ok' } });
    const result = await runFallbackChain(['a', 'b'], call);
    expect(result.modelUsed).toBe('b');
    expect(result.attempts[0].failureClass).toBe('empty_or_malformed');
  });

  it('does NOT fall through on content refusal — short-circuits with GenerateFailure', async () => {
    const { call, seen } = scripted({
      a: { text: "I cannot help with that request." },
      b: { text: 'this would have shipped declined content' },
    });
    await expect(runFallbackChain(['a', 'b'], call)).rejects.toBeInstanceOf(GenerateFailure);
    // b should NOT have been called.
    expect(seen).toEqual(['a']);
  });

  it('does NOT fall through on unknown failure — short-circuits', async () => {
    const { call, seen } = scripted({
      a: { throw: new Error('some weird error nobody saw before') },
      b: { text: 'unused' },
    });
    await expect(runFallbackChain(['a', 'b'], call)).rejects.toBeInstanceOf(GenerateFailure);
    expect(seen).toEqual(['a']);
  });

  it('does NOT fall through on caller-side 4xx (e.g. 400 bad request)', async () => {
    const { call, seen } = scripted({
      a: { throw: Object.assign(new Error('bad request'), { status: 400 }) },
      b: { text: 'unused' },
    });
    await expect(runFallbackChain(['a', 'b'], call)).rejects.toBeInstanceOf(GenerateFailure);
    expect(seen).toEqual(['a']);
  });

  it('GenerateFailure carries the full attempt history on short-circuit', async () => {
    const refusalErr = new Error('policy violation');
    const { call } = scripted({
      a: { throw: Object.assign(new Error('503'), { status: 503 }) },
      b: { throw: refusalErr },
      c: { text: 'never reached' },
    });
    let caught: GenerateFailure | null = null;
    try {
      await runFallbackChain(['a', 'b', 'c'], call);
    } catch (err) {
      caught = err as GenerateFailure;
    }
    expect(caught).toBeInstanceOf(GenerateFailure);
    expect(caught!.failureClass).toBe('content_refusal');
    expect(caught!.attempts).toHaveLength(2); // a + b, not c
    expect(caught!.attempts[0].modelId).toBe('a');
    expect(caught!.attempts[0].failureClass).toBe('transient_5xx');
    expect(caught!.attempts[1].modelId).toBe('b');
    expect(caught!.attempts[1].failureClass).toBe('content_refusal');
  });

  it('exhausts the chain when every model hits a transient failure', async () => {
    const { call, seen } = scripted({
      a: { throw: Object.assign(new Error('503'), { status: 503 }) },
      b: { throw: Object.assign(new Error('429'), { status: 429 }) },
      c: { text: '' }, // empty also counts as transient
    });
    let caught: GenerateFailure | null = null;
    try {
      await runFallbackChain(['a', 'b', 'c'], call);
    } catch (err) {
      caught = err as GenerateFailure;
    }
    expect(caught).toBeInstanceOf(GenerateFailure);
    expect(caught!.failureClass).toBe('empty_or_malformed'); // last class seen
    expect(caught!.attempts).toHaveLength(3);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('records duration for every attempt', async () => {
    // Inject a deterministic `now` so timing is testable.
    let t = 0;
    const now = () => {
      t += 100;
      return t;
    };
    const { call } = scripted({
      a: { throw: Object.assign(new Error('503'), { status: 503 }) },
      b: { text: 'ok' },
    });
    const result = await runFallbackChain(['a', 'b'], call, { now });
    // Each attempt opens with one now() call and closes with another,
    // so durationMs is exactly 100 per attempt.
    expect(result.attempts[0].durationMs).toBe(100);
    expect(result.attempts[1].durationMs).toBe(100);
  });

  it('fires onAttempt for each attempt including the successful one', async () => {
    const log: Array<{ modelId: string; failureClass: FailureClass | undefined }> = [];
    const { call } = scripted({
      a: { throw: Object.assign(new Error('503'), { status: 503 }) },
      b: { text: 'ok' },
    });
    await runFallbackChain(['a', 'b'], call, {
      onAttempt: (a) => log.push({ modelId: a.modelId, failureClass: a.failureClass }),
    });
    expect(log).toEqual([
      { modelId: 'a', failureClass: 'transient_5xx' },
      { modelId: 'b', failureClass: undefined },
    ]);
  });

  it('re-throws an existing GenerateFailure without re-classifying', async () => {
    const original = new GenerateFailure('content_refusal', []);
    const call = async () => {
      throw original;
    };
    let caught: GenerateFailure | null = null;
    try {
      await runFallbackChain(['a'], call);
    } catch (err) {
      caught = err as GenerateFailure;
    }
    expect(caught).toBe(original); // same instance, not wrapped
  });
});
