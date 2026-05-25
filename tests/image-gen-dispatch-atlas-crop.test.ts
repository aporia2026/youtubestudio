import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// The Atlas branch generates 3:2 (1536×1024 by default) but the rest of the
// pipeline assumes 16:9. cropTo16x9AndUpload bridges the gap by center-
// cropping the source down to a strict 16:9 before upscale. These tests
// verify the geometry across the four cases the helper can hit:
//   - tall-er than 16:9 (Atlas's 1536×1024 default)
//   - square 1024×1024
//   - wider than 16:9 (defensive — Atlas doesn't return this today but
//     the helper supports it)
//   - exactly 16:9 (no-op crop, dimensions preserved)
//
// R2 calls are mocked — the helper writes the cropped bytes to R2 and
// returns the resulting URL. We capture the bytes from the mock and run
// sharp.metadata() on them to assert the actual width/height the crop
// produced.

vi.mock('@/lib/r2', () => ({
  getImagesBucket: vi.fn(() => 'images-test-bucket'),
  uploadToBucket: vi.fn(async () => undefined),
  getDownloadUrlForBucket: vi.fn(async (_bucket: string, key: string) => `https://r2-test.example/${key}`),
}));

import { cropTo16x9AndUpload } from '@/lib/image-gen-dispatch';
import { uploadToBucket } from '@/lib/r2';

const mockedUploadToBucket = vi.mocked(uploadToBucket);

/** Build a deterministic single-colour PNG of the requested dimensions —
 *  enough for sharp.metadata() to read width/height + the extract pipeline
 *  to produce real output bytes. */
async function syntheticPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 100, b: 100 } },
  })
    .png()
    .toBuffer();
}

/** Stub global fetch to return the given bytes on any URL request. The
 *  cast-to-BodyInit bridges @types/node's `Buffer<ArrayBufferLike>` to
 *  DOM's BodyInit at the type level — Response accepts both shapes at
 *  runtime, but the type narrows differently across the two libs. */
function stubFetchReturnsBytes(bytes: Buffer, contentType = 'image/png'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(bytes as unknown as BodyInit, { headers: { 'content-type': contentType } })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cropTo16x9AndUpload — geometry', () => {
  it('crops Atlas\'s default 1536×1024 (3:2) down to 1536×864 (16:9), trimming 80px top + bottom', async () => {
    const src = await syntheticPng(1536, 1024);
    stubFetchReturnsBytes(src);

    const url = await cropTo16x9AndUpload('https://atlas-cdn.example/raw.png', 'test-prefix');
    expect(url).toMatch(/^https:\/\/r2-test\.example\/test-prefix\//);

    // Read back the bytes the helper uploaded and verify dimensions.
    const uploadedBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(uploadedBuf).metadata();
    expect(meta.width).toBe(1536);
    expect(meta.height).toBe(864);
    // (1024 - 864) / 2 = 80 px trim each on top and bottom — the math the
    // helper does. We don't have a direct read on the trim values, but the
    // resulting height proves it.
  });

  it('crops a square 1024×1024 down to 1024×576 (16:9)', async () => {
    const src = await syntheticPng(1024, 1024);
    stubFetchReturnsBytes(src);

    await cropTo16x9AndUpload('https://x', 'test-prefix');
    const uploadedBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(uploadedBuf).metadata();
    expect(meta.width).toBe(1024);
    // 1024 * 9 / 16 = 576.
    expect(meta.height).toBe(576);
  });

  it('side-trims an input wider than 16:9 (defensive — Atlas does not return this today)', async () => {
    // 2000×1000 = 2:1 aspect, wider than 16:9 (1.778). Should preserve
    // height (1000), shrink width to 1000 * 16/9 = 1778, trim 111 px each side.
    const src = await syntheticPng(2000, 1000);
    stubFetchReturnsBytes(src);

    await cropTo16x9AndUpload('https://x', 'test-prefix');
    const uploadedBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(uploadedBuf).metadata();
    expect(meta.width).toBe(1778);
    expect(meta.height).toBe(1000);
  });

  it('preserves an already-16:9 source (1920×1080) without changing dimensions', async () => {
    const src = await syntheticPng(1920, 1080);
    stubFetchReturnsBytes(src);

    await cropTo16x9AndUpload('https://x', 'test-prefix');
    const uploadedBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(uploadedBuf).metadata();
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
  });

  it('uploads as JPEG and registers the right content type', async () => {
    const src = await syntheticPng(1536, 1024);
    stubFetchReturnsBytes(src);

    await cropTo16x9AndUpload('https://x', 'test-prefix');
    const callArgs = mockedUploadToBucket.mock.calls[0];
    const r2Key = callArgs[1];
    const contentType = callArgs[3];
    expect(r2Key).toMatch(/\.jpg$/);
    expect(contentType).toBe('image/jpeg');
  });
});

describe('cropTo16x9AndUpload — error paths', () => {
  it('throws when the source fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    await expect(cropTo16x9AndUpload('https://missing', 'test-prefix')).rejects.toThrow(/fetch failed: HTTP 404/);
    expect(mockedUploadToBucket).not.toHaveBeenCalled();
  });
});
