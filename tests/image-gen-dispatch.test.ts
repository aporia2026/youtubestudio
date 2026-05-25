import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// The dispatcher's job is provider routing + sequencing. These tests mock
// the underlying modules (atlas-cloud-images, kie-poll, upscale, r2) and
// verify each provider branch calls the right helpers in the right order.
// The crop geometry itself is covered by image-gen-dispatch-atlas-crop.test.ts.
//
// Mocks live at the top of the file (vi.mock is hoisted by Vitest) so the
// dispatcher import below resolves to the mocked versions.

vi.mock('@/lib/atlas-cloud-images', () => ({
  generateAtlasT2I: vi.fn(),
}));
vi.mock('@/lib/kie-poll', () => ({
  createKieTask: vi.fn(),
  pollKieResultThenUpscale: vi.fn(),
}));
vi.mock('@/lib/upscale', () => ({
  upscaleViaRecraft: vi.fn(),
}));
vi.mock('@/lib/r2', () => ({
  getImagesBucket: vi.fn(() => 'images-test-bucket'),
  uploadToBucket: vi.fn(async () => undefined),
  getDownloadUrlForBucket: vi.fn(async (_bucket: string, key: string) => `https://r2-test.example/${key}`),
}));

import { generateImageWithUpscale } from '@/lib/image-gen-dispatch';
import { generateAtlasT2I } from '@/lib/atlas-cloud-images';
import { createKieTask, pollKieResultThenUpscale } from '@/lib/kie-poll';
import { upscaleViaRecraft } from '@/lib/upscale';
import { uploadToBucket } from '@/lib/r2';
import type { ImageModelSpec } from '@/lib/image-models';

const mockedGenerateAtlasT2I = vi.mocked(generateAtlasT2I);
const mockedCreateKieTask = vi.mocked(createKieTask);
const mockedPollKieResultThenUpscale = vi.mocked(pollKieResultThenUpscale);
const mockedUpscaleViaRecraft = vi.mocked(upscaleViaRecraft);
const mockedUploadToBucket = vi.mocked(uploadToBucket);

/** Build a tiny but valid PNG of the requested dimensions. sharp needs a
 *  decodable input — passing a Uint8Array of zeros would error inside
 *  cropTo16x9AndUpload. The cheap solid-colour create() pipeline produces
 *  the minimal bytes we need. */
async function syntheticPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 80, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

/** Pass-through cast for fetch Response bodies. At runtime Buffer + Uint8Array
 *  are accepted by Response; at type-level, @types/node's
 *  `Buffer<ArrayBufferLike>` (and the `Uint8Array<ArrayBufferLike>` returned
 *  by `new Uint8Array(buf)`) don't narrow to DOM's BodyInit, which expects
 *  `ArrayBuffer` rather than `ArrayBufferLike`. Centralizing the cast here
 *  keeps the call sites readable. */
function bytesBody(buf: Buffer): BodyInit {
  return buf as unknown as BodyInit;
}

beforeEach(() => {
  process.env.KIE_API_KEY = 'test-kie-key';
  process.env.ATLAS_CLOUD_API_KEY = 'test-atlas-key';
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.KIE_API_KEY;
  delete process.env.ATLAS_CLOUD_API_KEY;
  vi.unstubAllGlobals();
});

describe('generateImageWithUpscale — Atlas branch', () => {
  it('routes an Atlas spec through atlas helper, crop, upscale, then R2 mirror in that order', async () => {
    const atlasBytes = await syntheticPng(1536, 1024);
    const upscaledBytes = await syntheticPng(640, 360);

    // generateAtlasT2I returns a vendor URL the crop step will then fetch.
    mockedGenerateAtlasT2I.mockResolvedValue({
      url: 'https://atlas-cdn.example/raw.png',
      predictionId: 'pred_xyz',
      predictTimeMs: 8300,
    });
    // upscaleViaRecraft returns the upscaled URL.
    mockedUpscaleViaRecraft.mockResolvedValue({
      url: 'https://recraft-cdn.example/upscaled.png',
      reason: 'upscaled',
      totalMs: 1200,
      attempts: 1,
    });

    // Two fetches happen in the dispatcher: one inside cropTo16x9AndUpload
    // (reading Atlas's raw image), one in the final R2 mirror (reading the
    // upscaled image). Script them in order.
    const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://atlas-cdn.example/raw.png') {
        return new Response(bytesBody(atlasBytes), { headers: { 'content-type': 'image/png' } });
      }
      if (u === 'https://recraft-cdn.example/upscaled.png') {
        return new Response(bytesBody(upscaledBytes), { headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`unexpected fetch URL in test: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const spec: ImageModelSpec = {
      value: 'gpt-image-2-atlas-t2i',
      label: 'GPT Image 2 (Atlas)',
      provider: 'atlas',
      atlasModel: 'openai/gpt-image-2/text-to-image',
      atlasSize: '1536x1024',
      atlasQuality: 'medium',
    };
    const result = await generateImageWithUpscale(spec, 'a sunny field');

    expect(result.providerUsed).toBe('atlas');
    expect(result.url).toMatch(/^https:\/\/r2-test\.example\/prodoc-images\//);
    expect(result.bytes).toBeInstanceOf(Buffer);

    // Atlas helper called with the spec's size + quality + prompt.
    expect(mockedGenerateAtlasT2I).toHaveBeenCalledExactlyOnceWith({
      prompt: 'a sunny field',
      size: '1536x1024',
      quality: 'medium',
    });
    // Upscale called with the CROPPED URL (an R2 URL produced by the crop step),
    // not the raw Atlas URL.
    expect(mockedUpscaleViaRecraft).toHaveBeenCalledOnce();
    const upscaleArg = mockedUpscaleViaRecraft.mock.calls[0][0];
    expect(upscaleArg).toMatch(/^https:\/\/r2-test\.example\/prodoc-images-atlas-crop\//);

    // Kie path should never have been touched.
    expect(mockedCreateKieTask).not.toHaveBeenCalled();
    expect(mockedPollKieResultThenUpscale).not.toHaveBeenCalled();

    // R2 uploads: the cropped intermediate AND the final mirror.
    expect(mockedUploadToBucket).toHaveBeenCalledTimes(2);
    const uploadedKeys = mockedUploadToBucket.mock.calls.map((c) => c[1]);
    expect(uploadedKeys.some((k) => k.startsWith('prodoc-images-atlas-crop/'))).toBe(true);
    expect(uploadedKeys.some((k) => k.startsWith('prodoc-images/'))).toBe(true);
  });

  it('honours a custom r2KeyPrefix on the final mirror but keeps the crop prefix fixed', async () => {
    const atlasBytes = await syntheticPng(1536, 1024);
    mockedGenerateAtlasT2I.mockResolvedValue({
      url: 'https://atlas-cdn.example/raw.png',
      predictionId: 'p',
    });
    mockedUpscaleViaRecraft.mockResolvedValue({
      url: 'https://recraft-cdn.example/up.png',
      reason: 'upscaled',
      totalMs: 1,
      attempts: 1,
    });
    const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u === 'https://atlas-cdn.example/raw.png') {
        return new Response(bytesBody(atlasBytes), { headers: { 'content-type': 'image/png' } });
      }
      return new Response(bytesBody(await syntheticPng(100, 100)), { headers: { 'content-type': 'image/png' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const spec: ImageModelSpec = {
      value: 'gpt-image-2-atlas-t2i',
      label: 'GPT Image 2 (Atlas)',
      provider: 'atlas',
      atlasSize: '1536x1024',
    };
    await generateImageWithUpscale(spec, 'p', { r2KeyPrefix: 'thumbnails-test' });

    const uploadedKeys = mockedUploadToBucket.mock.calls.map((c) => c[1]);
    expect(uploadedKeys.some((k) => k.startsWith('thumbnails-test/'))).toBe(true);
    // Crop prefix is fixed regardless of caller opts — the intermediate
    // lives in its own namespace so R2 metrics can attribute Atlas usage.
    expect(uploadedKeys.some((k) => k.startsWith('prodoc-images-atlas-crop/'))).toBe(true);
  });
});

describe('generateImageWithUpscale — Kie branch', () => {
  it('routes a Kie spec through createKieTask + pollKieResultThenUpscale + R2 mirror', async () => {
    mockedCreateKieTask.mockResolvedValue('task_abc');
    mockedPollKieResultThenUpscale.mockResolvedValue('https://kie-cdn.example/result.png');

    const upscaledBytes = await syntheticPng(640, 360);
    const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      if (String(url) === 'https://kie-cdn.example/result.png') {
        return new Response(bytesBody(upscaledBytes), { headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const spec: ImageModelSpec = {
      value: 'gpt-image-2-t2i',
      label: 'GPT Image 2 (Kie)',
      provider: 'kie',
      kieModel: 'gpt-image-2-text-to-image',
    };
    const result = await generateImageWithUpscale(spec, 'kie-prompt');

    expect(result.providerUsed).toBe('kie');
    expect(mockedCreateKieTask).toHaveBeenCalledExactlyOnceWith(
      'test-kie-key',
      'gpt-image-2-text-to-image',
      expect.objectContaining({ prompt: 'kie-prompt', aspect_ratio: '16:9', resolution: '1K' }),
    );
    expect(mockedPollKieResultThenUpscale).toHaveBeenCalledExactlyOnceWith('task_abc', 'test-kie-key');
    expect(mockedGenerateAtlasT2I).not.toHaveBeenCalled();
    // Single R2 mirror upload (no intermediate crop for Kie).
    expect(mockedUploadToBucket).toHaveBeenCalledOnce();
  });

  it('falls back to provider="kie" when the spec omits the provider field (back-compat)', async () => {
    mockedCreateKieTask.mockResolvedValue('task_def');
    mockedPollKieResultThenUpscale.mockResolvedValue('https://kie-cdn.example/legacy.png');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytesBody(await syntheticPng(100, 100)), { headers: { 'content-type': 'image/png' } })),
    );

    const spec: ImageModelSpec = {
      value: 'grok-imagine-t2i',
      label: 'Grok Imagine',
      // provider intentionally omitted to exercise the undefined branch
      kieModel: 'grok-imagine/text-to-image',
    };
    const result = await generateImageWithUpscale(spec, 'legacy-prompt');
    expect(result.providerUsed).toBe('kie');
    expect(mockedCreateKieTask).toHaveBeenCalled();
  });

  it('throws when KIE_API_KEY is unset on a Kie spec', async () => {
    delete process.env.KIE_API_KEY;
    const spec: ImageModelSpec = {
      value: 'grok-imagine-t2i',
      label: 'Grok Imagine',
      provider: 'kie',
      kieModel: 'grok-imagine/text-to-image',
    };
    await expect(generateImageWithUpscale(spec, 'x')).rejects.toThrow(/KIE_API_KEY is not configured/);
    expect(mockedCreateKieTask).not.toHaveBeenCalled();
  });
});

describe('generateImageWithUpscale — unsupported provider', () => {
  it('throws for comfyui-local with an actionable message', async () => {
    const spec: ImageModelSpec = {
      value: 'flux-schnell-local',
      label: 'Local Flux',
      provider: 'comfyui-local',
      localWorkflowId: 'flux-schnell-t2i',
    };
    await expect(generateImageWithUpscale(spec, 'x')).rejects.toThrow(
      /unsupported provider 'comfyui-local'.*local generation has its own per-route LOCAL_STUDIO path/,
    );
    expect(mockedGenerateAtlasT2I).not.toHaveBeenCalled();
    expect(mockedCreateKieTask).not.toHaveBeenCalled();
  });
});

describe('generateImageWithUpscale — final mirror failure is non-fatal', () => {
  it('returns the upstream URL with bytes=undefined when the R2 mirror fetch errors', async () => {
    mockedCreateKieTask.mockResolvedValue('task_mirror_fail');
    mockedPollKieResultThenUpscale.mockResolvedValue('https://kie-cdn.example/x.png');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    // Use a real registry value — buildKieImageInput re-looks-up by
    // spec.value, so a synthetic spec.value not in IMAGE_MODELS throws
    // before the mirror step we're trying to exercise. The point of the
    // test is the mirror error path, not the registry coupling.
    const spec: ImageModelSpec = {
      value: 'grok-imagine-t2i',
      label: 'Grok Imagine',
      provider: 'kie',
      kieModel: 'grok-imagine/text-to-image',
    };
    const result = await generateImageWithUpscale(spec, 'x');
    expect(result.url).toBe('https://kie-cdn.example/x.png'); // fallback to upstream
    expect(result.bytes).toBeUndefined();
    expect(mockedUploadToBucket).not.toHaveBeenCalled();
  });
});
