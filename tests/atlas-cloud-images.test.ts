import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateAtlasT2I,
  generateAtlasEdit,
  generateAtlasI2I,
} from '@/lib/atlas-cloud-images';

// Atlas helpers wrap a plain fetch + 3 s poll loop, sibling to the kie-poll
// chokepoint. These tests assert: (a) the request body matches what Atlas
// documents, (b) the auth header is right, (c) terminal states are handled
// correctly, (d) the missing-API-key path throws with a usable message.
//
// We intentionally do NOT exercise the full 285 s ceiling — the kie-poll
// equivalent already proves the shape works, and Atlas's polling loop is a
// direct port. Faking timers lets us drain the 3 s setTimeout without
// stalling the test runner.

const ATLAS_BASE = 'https://api.atlascloud.ai/api/v1/model';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** Build a fetch mock that scripts a sequence of responses. The first call
 *  returns scripted[0], second returns scripted[1], and so on. Each entry
 *  is either a Response-like object or a function that returns one. */
function scriptedFetch(scripted: Array<Response | (() => Response)>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    if (i >= scripted.length) {
      throw new Error(`scriptedFetch: ran out of scripted responses at call ${i + 1} for ${String(url)}`);
    }
    const next = scripted[i++];
    return typeof next === 'function' ? next() : next;
  });
  return { mock, calls };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  process.env.ATLAS_CLOUD_API_KEY = 'test-atlas-key';
  vi.useFakeTimers();
});

afterEach(() => {
  delete process.env.ATLAS_CLOUD_API_KEY;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('generateAtlasT2I — request shape', () => {
  it('POSTs all fields at the top level (per OpenAPI schema) with bearer auth', async () => {
    const { mock, calls } = scriptedFetch([
      jsonResponse({ id: 'pred_abc' }),
      jsonResponse({
        id: 'pred_abc',
        status: 'completed',
        outputs: ['https://cdn.atlascloud.ai/x/img.png'],
        metrics: { predict_time: 8.3 },
      }),
    ]);
    vi.stubGlobal('fetch', mock);

    const promise = generateAtlasT2I({ prompt: 'a sunny field', size: '2560x1440', quality: 'low' });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.url).toBe('https://cdn.atlascloud.ai/x/img.png');
    expect(result.predictionId).toBe('pred_abc');
    expect(result.predictTimeMs).toBe(8300);

    // First call: create. Atlas's Input schema is FLAT — model + prompt +
    // size + quality all live at the top level, not nested under an
    // `input` key. Regression guard for the original bug that copied
    // Kie's nested envelope shape.
    expect(calls[0].url).toBe(`${ATLAS_BASE}/generateImage`);
    expect(calls[0].init?.method).toBe('POST');
    const headers0 = calls[0].init?.headers as Record<string, string>;
    expect(headers0.Authorization).toBe('Bearer test-atlas-key');
    expect(headers0['Content-Type']).toBe('application/json');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      model: 'openai/gpt-image-2/text-to-image',
      prompt: 'a sunny field',
      size: '2560x1440',
      quality: 'low',
    });
    // Explicit assertion that no `input` wrapper sneaks back in.
    expect(body.input).toBeUndefined();

    // Second call: poll. Path is `/prediction/{id}` per Atlas's official
    // Python example (verified against docs 2026-05-27). The earlier
    // `/result/{id}` path was a misreading and produced 404 in prod.
    expect(calls[1].url).toBe(`${ATLAS_BASE}/prediction/pred_abc`);
    const headers1 = calls[1].init?.headers as Record<string, string>;
    expect(headers1.Authorization).toBe('Bearer test-atlas-key');
  });

  it("omits `quality` from the request when caller doesn't pass it", async () => {
    const { mock, calls } = scriptedFetch([
      jsonResponse({ id: 'pred_def' }),
      jsonResponse({ id: 'pred_def', status: 'completed', outputs: ['https://cdn/y.png'] }),
    ]);
    vi.stubGlobal('fetch', mock);
    const promise = generateAtlasT2I({ prompt: 'minimal', size: '1024x1024' });
    await vi.runAllTimersAsync();
    await promise;
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      model: 'openai/gpt-image-2/text-to-image',
      prompt: 'minimal',
      size: '1024x1024',
    });
    expect(body.quality).toBeUndefined();
  });
});

describe('generateAtlasT2I — error paths', () => {
  it('throws when ATLAS_CLOUD_API_KEY is not set', async () => {
    delete process.env.ATLAS_CLOUD_API_KEY;
    await expect(generateAtlasT2I({ prompt: 'x', size: '2560x1440' })).rejects.toThrow(
      /ATLAS_CLOUD_API_KEY is not configured/,
    );
  });

  it('throws with `[atlas-images]` prefix when create returns 401', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ error: 'invalid_api_key' }, { status: 401 }),
    ]);
    vi.stubGlobal('fetch', mock);
    const promise = generateAtlasT2I({ prompt: 'x', size: '2560x1440' });
    // Attach the rejection handler synchronously (via expect.rejects) so
    // Vitest doesn't flag an unhandled rejection while the create/poll
    // loop drains. Then advance timers, then await the assertion.
    const assertion = expect(promise).rejects.toThrow(/\[atlas-images\] invalid_api_key/);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('retries on 502 then succeeds', async () => {
    const { mock, calls } = scriptedFetch([
      new Response('<html>503</html>', { status: 502 }),
      jsonResponse({ id: 'pred_retry' }),
      jsonResponse({ id: 'pred_retry', status: 'completed', outputs: ['https://cdn/z.png'] }),
    ]);
    vi.stubGlobal('fetch', mock);
    const promise = generateAtlasT2I({ prompt: 'x', size: '2560x1440' });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.url).toBe('https://cdn/z.png');
    // Two POST attempts (502 retry) + one poll.
    expect(calls.filter((c) => c.url.endsWith('/generateImage'))).toHaveLength(2);
  });

  it('throws when the prediction terminates as failed', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ id: 'pred_fail' }),
      jsonResponse({ id: 'pred_fail', status: 'failed', error: 'content policy violation' }),
    ]);
    vi.stubGlobal('fetch', mock);
    const promise = generateAtlasT2I({ prompt: 'x', size: '2560x1440' });
    const assertion = expect(promise).rejects.toThrow(
      /prediction pred_fail failed: content policy violation/,
    );
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('throws when the prediction completes without an output URL', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ id: 'pred_empty' }),
      jsonResponse({ id: 'pred_empty', status: 'completed', outputs: [] }),
    ]);
    vi.stubGlobal('fetch', mock);
    const promise = generateAtlasT2I({ prompt: 'x', size: '2560x1440' });
    const assertion = expect(promise).rejects.toThrow(/completed without an output URL/);
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe('generateAtlasEdit + generateAtlasI2I — input validation', () => {
  it('generateAtlasEdit rejects an empty images array', async () => {
    await expect(generateAtlasEdit({ prompt: 'x', images: [] })).rejects.toThrow(
      /at least one input image URL is required/,
    );
  });

  it('generateAtlasI2I rejects an empty images array', async () => {
    await expect(generateAtlasI2I({ prompt: 'x', images: [] })).rejects.toThrow(
      /at least one reference image URL is required/,
    );
  });

  it('generateAtlasEdit posts to the documented edit model with images field at top level', async () => {
    const { mock, calls } = scriptedFetch([
      jsonResponse({ id: 'pred_edit' }),
      jsonResponse({
        id: 'pred_edit',
        status: 'completed',
        outputs: ['https://cdn/edited.png'],
        metrics: { input_tokens: 100, output_tokens: 50, image_tokens: 1000 },
      }),
    ]);
    vi.stubGlobal('fetch', mock);
    const promise = generateAtlasEdit({
      prompt: 'add a hat',
      images: ['https://r2/in1.jpg', 'https://r2/in2.jpg'],
      size: '2560x1440',
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      model: 'openai/gpt-image-2/edit',
      prompt: 'add a hat',
      images: ['https://r2/in1.jpg', 'https://r2/in2.jpg'],
      size: '2560x1440',
    });
    // Token telemetry surfaces for cost-true-up.
    expect(result.tokens).toEqual({ input: 100, output: 50, image: 1000 });
  });

  it('generateAtlasI2I posts to the documented image-to-image model', async () => {
    const { mock, calls } = scriptedFetch([
      jsonResponse({ id: 'pred_i2i' }),
      jsonResponse({ id: 'pred_i2i', status: 'completed', outputs: ['https://cdn/i2i.png'] }),
    ]);
    vi.stubGlobal('fetch', mock);
    const promise = generateAtlasI2I({
      prompt: 'in the style of these refs',
      images: ['https://r2/ref1.jpg'],
    });
    await vi.runAllTimersAsync();
    await promise;
    const body = JSON.parse(calls[0].init?.body as string);
    // Atlas only ships ONE GPT Image 2 image-modification model (Edit);
    // it serves both single-image edit AND multi-image reference
    // generation via the same `images` array. Verified against
    // atlascloud.ai/collections/gpt-image-2 on 2026-05-27.
    expect(body).toEqual({
      model: 'openai/gpt-image-2/edit',
      prompt: 'in the style of these refs',
      images: ['https://r2/ref1.jpg'],
    });
  });
});
