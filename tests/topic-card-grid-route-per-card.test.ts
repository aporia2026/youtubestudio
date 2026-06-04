/**
 * Route-level tests for the per-card mode branch of
 * `POST /api/thumbnails/format/topic-card-grid/image`.
 *
 * Mocks all external boundaries (rate-limit, R2, OpenAI, the composite,
 * URL safety) and exercises the route handler directly. The assertions
 * focus on the three behaviours called out in the plan:
 *   1. Per-card mode triggers N parallel `generateImageOpenAI` calls
 *      (one per non-uploaded card) and threads the results into the
 *      composite's `uploads` array.
 *   2. A per-card failure substitutes a coloured placeholder instead of
 *      blowing up the whole request — the response is still 200 and
 *      reports `perCard.failed > 0`.
 *   3. One-shot mode (the existing default) calls `generateImageOpenAI`
 *      exactly once — the new branch is gated by the explicit
 *      `generationMode: 'per-card'` flag.
 *
 * Plan: `_plans/2026-06-04-topic-card-grid-per-card-generation.md`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Buffer } from 'node:buffer';

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ limited: false, resetIn: 0 }),
  getClientIP: () => '127.0.0.1',
}));

vi.mock('@/lib/r2', () => ({
  uploadToBucket: vi.fn(async () => undefined),
  getImagesBucket: () => 'test-bucket',
  getImagesDownloadUrl: vi.fn(async (key: string) => `https://r2.example.test/${key}`),
}));

vi.mock('@/lib/url-safety', () => ({
  assertSafePublicUrl: (u: string) => new URL(u),
}));

const generateImageOpenAIMock = vi.fn();
vi.mock('@/lib/openai-images', () => ({
  generateImageOpenAI: (...args: unknown[]) => generateImageOpenAIMock(...args),
}));

vi.mock('@/lib/kie-poll', () => ({
  createKieTask: vi.fn(async () => 'kie-task-stub'),
  pollKieResultThenUpscale: vi.fn(async () => 'https://kie.example.test/result.png'),
}));

const applyCellUploadsMock = vi.fn();
vi.mock('@/lib/thumbnail-formats/topic-card-grid-composite', async () => {
  const actual = await vi.importActual<typeof import('@/lib/thumbnail-formats/topic-card-grid-composite')>(
    '@/lib/thumbnail-formats/topic-card-grid-composite',
  );
  return {
    ...actual,
    applyCellUploads: (input: unknown) => {
      applyCellUploadsMock(input);
      return Promise.resolve(Buffer.from('final-stub'));
    },
  };
});

// `applySharedOverlays` only runs when `postProcess` or `titleBar` is
// present in the request. We don't send either in these tests, so the
// mock is defensive — if the route ever drifts into calling it, the
// stub keeps the test from doing real work.
vi.mock('@/lib/thumbnail-formats/shared-overlay-pipeline', async () => {
  const actual = await vi.importActual<typeof import('@/lib/thumbnail-formats/shared-overlay-pipeline')>(
    '@/lib/thumbnail-formats/shared-overlay-pipeline',
  );
  return {
    ...actual,
    applySharedOverlays: () => Promise.resolve(Buffer.from('overlay-stub')),
  };
});

import * as routeModule from '@/app/api/thumbnails/format/topic-card-grid/image/route';

type RoutePost = (req: NextRequest) => Promise<Response>;
const POST = (routeModule as unknown as { POST: RoutePost }).POST;

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/thumbnails/format/topic-card-grid/image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const baseCards = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    label: `Card ${i + 1}`,
    icon_concept: `subject ${i + 1}`,
    accent_color: '#3366cc',
  }));

const baseBody = (overrides: Record<string, unknown> = {}) => ({
  gridRows: 3,
  gridCols: 3,
  cards: baseCards(9),
  globalPalette: { background: '#000000', primary_accent: 'inherit', secondary_accent: 'inherit' },
  referenceImageUrl: 'https://example.test/ref.png',
  cardShape: 'circle',
  style: 'cartoon',
  brightness: 'bright',
  detail: 'clean',
  ...overrides,
});

beforeEach(() => {
  generateImageOpenAIMock.mockReset();
  applyCellUploadsMock.mockReset();
});

describe('POST /api/thumbnails/format/topic-card-grid/image — per-card mode', () => {
  it('fans out one generateImageOpenAI call per card and threads results into the composite uploads array', async () => {
    generateImageOpenAIMock.mockImplementation(async () => ({
      base64: Buffer.from('per-card-bytes').toString('base64'),
      mimeType: 'image/png' as const,
    }));

    const req = makeRequest(baseBody({ generationMode: 'per-card' }));
    const res = await POST(req);
    expect(res.status).toBe(200);

    // Nine cards in the grid, zero uploads, so the runner should fire
    // nine independent AI calls.
    expect(generateImageOpenAIMock).toHaveBeenCalledTimes(9);
    // Every call must request 1024×1024 medium — the per-card prompt
    // contract.
    for (const call of generateImageOpenAIMock.mock.calls) {
      expect(call[0]).toMatchObject({ size: '1024x1024', quality: 'medium' });
      // No reference image attached — the plan explicitly skips it in
      // per-card mode (each call is a single illustration, not a grid).
      expect(call[0]).not.toHaveProperty('referenceImage');
    }
    // The composite should have been fed nine synthetic uploads, one
    // per card.
    expect(applyCellUploadsMock).toHaveBeenCalledOnce();
    const compositeInput = applyCellUploadsMock.mock.calls[0][0] as { uploads: Array<{ cardIndex: number }> };
    expect(compositeInput.uploads).toHaveLength(9);
    expect(compositeInput.uploads.map((u) => u.cardIndex).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const data = await res.json() as { generationMode: string; perCard: { succeeded: number; failed: number; total: number } };
    expect(data.generationMode).toBe('per-card');
    expect(data.perCard).toEqual({ succeeded: 9, failed: 0, total: 9 });
  });

  it('substitutes a placeholder for a failed card and still returns 200', async () => {
    let callIndex = 0;
    generateImageOpenAIMock.mockImplementation(async () => {
      callIndex += 1;
      // Fail exactly one call so the route exercises the placeholder
      // branch. The runner captures the error per-card and never
      // throws — the route sees a successful Buffer + a failed entry.
      if (callIndex === 3) {
        throw new Error('content policy refusal (synthetic)');
      }
      return {
        base64: Buffer.from('ok').toString('base64'),
        mimeType: 'image/png' as const,
      };
    });

    const req = makeRequest(baseBody({ generationMode: 'per-card' }));
    const res = await POST(req);
    expect(res.status).toBe(200);

    const compositeInput = applyCellUploadsMock.mock.calls[0][0] as { uploads: Array<{ cardIndex: number; bytes: Buffer }> };
    // All nine cells still get a cellUpload — the failed one carries a
    // coloured placeholder instead of AI bytes. The composite never
    // sees a missing card.
    expect(compositeInput.uploads).toHaveLength(9);

    const data = await res.json() as { perCard: { succeeded: number; failed: number; total: number } };
    expect(data.perCard).toEqual({ succeeded: 8, failed: 1, total: 9 });
  });

  it('does not call generateImageOpenAI for cells the user already uploaded', async () => {
    generateImageOpenAIMock.mockImplementation(async () => ({
      base64: Buffer.from('ok').toString('base64'),
      mimeType: 'image/png' as const,
    }));

    // The route fetches user upload bytes from the safeUrl. Stub
    // fetch globally for the duration of the test so the upload loop
    // sees a small PNG response.
    const originalFetch = globalThis.fetch;
    const tinyPng = await (await import('sharp')).default({
      create: { width: 8, height: 8, channels: 4, background: '#ff0000' },
    }).png().toBuffer();
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array(tinyPng), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(tinyPng.byteLength) },
    })) as typeof fetch;

    try {
      const req = makeRequest(
        baseBody({
          generationMode: 'per-card',
          uploads: [
            { cardIndex: 1, imageUrl: 'https://example.test/u1.png' },
            { cardIndex: 5, imageUrl: 'https://example.test/u5.png' },
          ],
        }),
      );
      const res = await POST(req);
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 9 cards total, 2 uploaded → 7 AI calls.
    expect(generateImageOpenAIMock).toHaveBeenCalledTimes(7);

    const compositeInput = applyCellUploadsMock.mock.calls[0][0] as { uploads: Array<{ cardIndex: number }> };
    // Composite sees both the real uploads AND the seven AI fills.
    expect(compositeInput.uploads).toHaveLength(9);
  });
});

describe('POST /api/thumbnails/format/topic-card-grid/image — one-shot mode regression', () => {
  it('calls generateImageOpenAI exactly once when imageModelId routes through OpenAI', async () => {
    // The one-shot OpenAI path decodes `result.base64` back to bytes
    // and runs `sharp(...).metadata()` on it to read canvas dimensions.
    // Hand it a real PNG so the metadata probe succeeds instead of
    // throwing "Input buffer contains unsupported image format".
    const sharp = (await import('sharp')).default;
    const realPngBase64 = (await sharp({
      create: { width: 16, height: 16, channels: 4, background: '#000000' },
    }).png().toBuffer()).toString('base64');
    generateImageOpenAIMock.mockImplementation(async () => ({
      base64: realPngBase64,
      mimeType: 'image/png' as const,
    }));

    // The OpenAI i2i path fetches the reference image. Provide a tiny
    // PNG via stubbed fetch so the multipart upload step has bytes.
    const originalFetch = globalThis.fetch;
    const tinyPng = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#ffffff' },
    }).png().toBuffer();
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array(tinyPng), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(tinyPng.byteLength) },
    })) as typeof fetch;

    let res: Response;
    try {
      const req = makeRequest(
        baseBody({
          imageModelId: 'gpt-image-2-openai-i2i',
          // No generationMode field — exercises the default one-shot path.
        }),
      );
      res = await POST(req);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(res.status).toBe(200);
    expect(generateImageOpenAIMock).toHaveBeenCalledTimes(1);
    // One-shot mode requests true 16:9 (2048×1152), not the per-card
    // 1024×1024.
    expect(generateImageOpenAIMock.mock.calls[0][0]).toMatchObject({ size: '2048x1152', quality: 'medium' });

    const data = await res.json() as { generationMode: string; perCard: unknown };
    expect(data.generationMode).toBe('one-shot');
    expect(data.perCard).toBeNull();
  });
});
