import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// collage-slicer.ts hosts two public entry points:
//   - sliceCollage         (legacy 4-tuple shape, used by `collage_mode`)
//   - sliceCollageGrid     (new variable N×M shape, used by the
//                           doodle_explainer_2 motion-collage shot kind)
// Both delegate to the same crop+upload loop. These tests cover:
//   - back-compat: sliceCollage still returns a 4-tuple of URLs for a
//     2×2 source, dimensions match the historic math.
//   - the new generic path slices N×M sources into the right number of
//     cells in row-major order.
//   - validation: invalid grids reject early without any IO.
//   - bounds: a too-small source for the requested grid throws
//     CollageSliceError rather than uploading garbage.
//
// Mocks the R2 helpers + global fetch — the test never touches the
// network or the real bucket. Source images are synthesized in-memory
// via sharp so dimensions are exact.

vi.mock('@/lib/r2', () => ({
  getImagesBucket: vi.fn(() => 'images-test-bucket'),
  uploadToBucket: vi.fn(async () => undefined),
  getDownloadUrlForBucket: vi.fn(async (_bucket: string, key: string) => `https://r2-test.example/${key}`),
}));

import {
  CollageSliceError,
  MAX_COLLAGE_CELLS,
  sliceCollage,
  sliceCollageGrid,
} from '@/lib/collage-slicer';
import { uploadToBucket } from '@/lib/r2';

const mockedUploadToBucket = vi.mocked(uploadToBucket);

/** Build a deterministic single-colour PNG of the requested dimensions —
 *  enough for sharp.metadata() to read width/height + the extract pipeline
 *  to produce real output bytes. The pixel values themselves don't matter
 *  for these tests; we assert dimensions and counts, not content. */
async function syntheticPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();
}

/** Stub global fetch to return the given bytes on any URL request. */
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

describe('sliceCollage (back-compat 2×2 wrapper)', () => {
  it('returns a 4-tuple of URLs from a 1920×1080 source', async () => {
    const src = await syntheticPng(1920, 1080);
    stubFetchReturnsBytes(src);

    const result = await sliceCollage('https://example.test/raw.png');

    expect(result.quadrantUrls).toHaveLength(4);
    for (const url of result.quadrantUrls) {
      expect(url).toMatch(/^https:\/\/r2-test\.example\/prodoc-images-collage\//);
    }
    expect(result.sourceWidth).toBe(1920);
    expect(result.sourceHeight).toBe(1080);
    // 1920/2 = 960; trim 1% (~19) off two edges per cell -> 960-19-19 = 922 typical.
    expect(result.quadrantWidth).toBeGreaterThan(900);
    expect(result.quadrantWidth).toBeLessThan(960);
    expect(result.quadrantHeight).toBeGreaterThan(500);
    expect(result.quadrantHeight).toBeLessThan(540);
  });

  it('uploads exactly 4 cells to R2', async () => {
    const src = await syntheticPng(1024, 1024);
    stubFetchReturnsBytes(src);

    await sliceCollage('https://example.test/raw.png');

    expect(mockedUploadToBucket).toHaveBeenCalledTimes(4);
  });

  it('honours the r2KeyPrefix option for tester runs', async () => {
    const src = await syntheticPng(1024, 1024);
    stubFetchReturnsBytes(src);

    await sliceCollage('https://example.test/raw.png', { r2KeyPrefix: 'collage-tester' });

    const keys = mockedUploadToBucket.mock.calls.map((call) => call[1] as string);
    for (const key of keys) {
      expect(key).toMatch(/^collage-tester\//);
    }
  });
});

describe('sliceCollageGrid — happy path across grid sizes', () => {
  it.each([
    { cols: 2, rows: 2, expected: 4 },
    { cols: 3, rows: 2, expected: 6 },
    { cols: 2, rows: 3, expected: 6 },
    { cols: 3, rows: 3, expected: 9 },
    { cols: 4, rows: 3, expected: 12 },
    { cols: 4, rows: 4, expected: 16 },
    { cols: 1, rows: 4, expected: 4 },
    { cols: 4, rows: 1, expected: 4 },
  ])('slices a 1920×1080 source into $expected cells for $cols×$rows', async ({ cols, rows, expected }) => {
    const src = await syntheticPng(1920, 1080);
    stubFetchReturnsBytes(src);

    const result = await sliceCollageGrid('https://example.test/raw.png', { cols, rows });

    expect(result.panelUrls).toHaveLength(expected);
    expect(result.cols).toBe(cols);
    expect(result.rows).toBe(rows);
    expect(result.sourceWidth).toBe(1920);
    expect(result.sourceHeight).toBe(1080);
    expect(mockedUploadToBucket).toHaveBeenCalledTimes(expected);
  });

  it('every cell index 0..N-1 is emitted exactly once (row-major key suffixes)', async () => {
    const src = await syntheticPng(1200, 800);
    stubFetchReturnsBytes(src);

    await sliceCollageGrid('https://example.test/raw.png', { cols: 3, rows: 2 });

    // The implementation appends `-<index>.jpg` after the timestamp slug
    // so the KEY space is row-major even when Promise.all completes
    // uploads in a different wall-clock order. Verify the SET of
    // suffixes, not the call ordering.
    const keys = mockedUploadToBucket.mock.calls.map((call) => call[1] as string);
    expect(keys).toHaveLength(6);
    const suffixes = keys
      .map((k) => {
        const match = k.match(/-(\d+)\.jpg$/);
        return match ? Number(match[1]) : -1;
      })
      .sort((a, b) => a - b);
    expect(suffixes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('honours the r2KeyPrefix option', async () => {
    const src = await syntheticPng(1024, 768);
    stubFetchReturnsBytes(src);

    await sliceCollageGrid(
      'https://example.test/raw.png',
      { cols: 2, rows: 2 },
      { r2KeyPrefix: 'prodoc-images-motion-collage' },
    );

    const keys = mockedUploadToBucket.mock.calls.map((call) => call[1] as string);
    for (const key of keys) {
      expect(key).toMatch(/^prodoc-images-motion-collage\//);
    }
  });

  it('produced cells decode at the reported dimensions', async () => {
    const src = await syntheticPng(2000, 1200);
    stubFetchReturnsBytes(src);

    const result = await sliceCollageGrid('https://example.test/raw.png', { cols: 4, rows: 3 });

    // Verify the bytes the helper uploaded actually have the dimensions
    // the result claims (defends against silent geometry drift).
    const firstCellBuf = mockedUploadToBucket.mock.calls[0][2] as Buffer;
    const meta = await sharp(firstCellBuf).metadata();
    expect(meta.width).toBe(result.panelWidth);
    expect(meta.height).toBe(result.panelHeight);
  });
});

describe('sliceCollageGrid — validation rejects bad grids before any IO', () => {
  it.each([
    { label: 'zero cols', grid: { cols: 0, rows: 2 } },
    { label: 'zero rows', grid: { cols: 2, rows: 0 } },
    { label: 'negative cols', grid: { cols: -1, rows: 2 } },
    { label: 'non-integer cols', grid: { cols: 1.5, rows: 2 } },
    { label: 'non-integer rows', grid: { cols: 2, rows: 2.5 } },
  ])('rejects $label without fetching', async ({ grid }) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(sliceCollageGrid('https://example.test/raw.png', grid)).rejects.toBeInstanceOf(
      CollageSliceError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedUploadToBucket).not.toHaveBeenCalled();
  });

  it('rejects grids whose total cells exceed MAX_COLLAGE_CELLS', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      sliceCollageGrid('https://example.test/raw.png', { cols: 5, rows: 4 }),
    ).rejects.toThrowError(/exceed hard cap/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exposes the cap as MAX_COLLAGE_CELLS = 16', () => {
    // Pin so a future plan that changes this is forced through this file.
    expect(MAX_COLLAGE_CELLS).toBe(16);
  });
});

describe('sliceCollageGrid — runtime failure modes', () => {
  it('throws CollageSliceError on HTTP non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );

    await expect(
      sliceCollageGrid('https://example.test/missing.png', { cols: 2, rows: 2 }),
    ).rejects.toThrowError(/fetch failed: HTTP 404/);
  });

  it('throws CollageSliceError when source is too small for the requested grid', async () => {
    // A 3×3 source against a 4×4 grid drives Math.floor(W/cols) = 0,
    // so every cell has width 0 — the bounds check trips before any
    // sharp .extract() call. The helper rejects rather than uploading
    // zero-byte JPEGs. (Larger sources don't trigger this — the trim
    // percentages round down to 0 at tiny dims, leaving cells with
    // positive width. The math-impossible case is the one that
    // matters here.)
    const src = await syntheticPng(3, 3);
    stubFetchReturnsBytes(src);

    await expect(
      sliceCollageGrid('https://example.test/tiny.png', { cols: 4, rows: 4 }),
    ).rejects.toThrowError(/out of bounds/);
    expect(mockedUploadToBucket).not.toHaveBeenCalled();
  });
});
