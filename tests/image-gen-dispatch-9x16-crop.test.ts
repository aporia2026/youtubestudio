import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

/**
 * Geometry tests for the generalized `cropToAspectAndUpload` helper —
 * specifically the 9:16 path the Shorts pipeline added on 2026-06-04.
 * The 16:9 path is covered by `image-gen-dispatch-atlas-crop.test.ts`
 * (which now exercises the same code through the back-compat alias).
 *
 * Plan: `_plans/2026-06-04-shorts-images-must-be-9-16.md`.
 */

vi.mock('@/lib/r2', () => ({
  getImagesBucket: vi.fn(() => 'images-test-bucket'),
  uploadToBucket: vi.fn(async () => undefined),
  getDownloadUrlForBucket: vi.fn(
    async (_bucket: string, key: string) => `https://r2-test.example/${key}`,
  ),
}));

import { cropToAspectAndUpload } from '@/lib/image-gen-dispatch';
import { uploadToBucket } from '@/lib/r2';

const mockedUploadToBucket = vi.mocked(uploadToBucket);

async function syntheticPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 80, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

function stubFetchReturnsBytes(bytes: Buffer, contentType = 'image/png'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(bytes as unknown as BodyInit, {
          headers: { 'content-type': contentType },
        }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cropToAspectAndUpload — 9:16 portrait (Shorts pipeline)', () => {
  it("crops Atlas T2I's 1024×1536 (2:3) down to 864×1536 (9:16), trimming 80px from each side", async () => {
    // 2:3 source — taller than 9:16 (target aspect 0.5625 > source 0.667?
    // wait — 2:3 = 0.667, 9:16 = 0.5625; the source is WIDER than target,
    // so the helper trims width. 1536 * 9/16 = 864. (1024 - 864) / 2 = 80.
    const src = await syntheticPng(1024, 1536);
    stubFetchReturnsBytes(src);

    const url = await cropToAspectAndUpload(
      'https://atlas-cdn.example/raw.png',
      'shorts-base-atlas-crop',
      9,
      16,
    );
    expect(url).toMatch(/^https:\/\/r2-test\.example\/shorts-base-atlas-crop\//);

    const uploadedBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(uploadedBuf).metadata();
    expect(meta.width).toBe(864);
    expect(meta.height).toBe(1536);
  });

  it("crops Atlas Edit's 1024×1536 (when asked for portrait) to 864×1536 — same math, different caller", async () => {
    const src = await syntheticPng(1024, 1536);
    stubFetchReturnsBytes(src);

    await cropToAspectAndUpload('https://x', 'prodoc-images-atlas-crop', 9, 16);
    const uploadedBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(uploadedBuf).metadata();
    expect(meta.width).toBe(864);
    expect(meta.height).toBe(1536);
  });

  it('crops a square 1024×1024 down to 576×1024 (9:16)', async () => {
    const src = await syntheticPng(1024, 1024);
    stubFetchReturnsBytes(src);

    await cropToAspectAndUpload('https://x', 'test-prefix', 9, 16);
    const uploadedBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(uploadedBuf).metadata();
    // 1024 * 9 / 16 = 576.
    expect(meta.width).toBe(576);
    expect(meta.height).toBe(1024);
  });

  it('side-trims an Atlas Edit landscape source (1536×1024) down to 9:16 (576×1024)', async () => {
    // This is what we'd get if we accidentally let the long-form 1536×1024
    // size flow into the Shorts path. The helper still does the right
    // thing — proves it.
    const src = await syntheticPng(1536, 1024);
    stubFetchReturnsBytes(src);

    await cropToAspectAndUpload('https://x', 'test-prefix', 9, 16);
    const uploadedBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(uploadedBuf).metadata();
    expect(meta.width).toBe(576);
    expect(meta.height).toBe(1024);
  });

  it('preserves an already-9:16 source (1080×1920) without changing dimensions', async () => {
    const src = await syntheticPng(1080, 1920);
    stubFetchReturnsBytes(src);

    await cropToAspectAndUpload('https://x', 'test-prefix', 9, 16);
    const uploadedBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(uploadedBuf).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
  });
});

describe('cropToAspectAndUpload — input validation', () => {
  it('rejects zero / negative / non-finite aspect values', async () => {
    await expect(
      cropToAspectAndUpload('https://x', 'test-prefix', 0, 16),
    ).rejects.toThrow(/positive finite/);
    await expect(
      cropToAspectAndUpload('https://x', 'test-prefix', 9, -1),
    ).rejects.toThrow(/positive finite/);
    await expect(
      cropToAspectAndUpload('https://x', 'test-prefix', Infinity, 16),
    ).rejects.toThrow(/positive finite/);
    await expect(
      cropToAspectAndUpload('https://x', 'test-prefix', 9, NaN),
    ).rejects.toThrow(/positive finite/);
  });
});
