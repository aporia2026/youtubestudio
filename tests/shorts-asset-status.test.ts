import { describe, expect, it } from 'vitest';
import {
  anyRowGenerating,
  getStyleAssetStatus,
  isGenerationStale,
  SHORTS_ASSET_STALE_MS,
  styleAssetLabel,
} from '@/lib/shorts-asset-status';
import type { GenerationProgressState, ShortRow } from '@/lib/shorts-types';

function row(overrides: Partial<ShortRow>): Pick<ShortRow, 'medium' | 'style_id' | 'style_assets'> {
  return {
    medium: 'short_native',
    style_id: null,
    style_assets: {},
    ...overrides,
  };
}

describe('getStyleAssetStatus — none branches', () => {
  it('returns none for short_clip rows (no render path)', () => {
    expect(getStyleAssetStatus(row({ medium: 'short_clip' }))).toBe('none');
  });

  it('returns none for short_native with no style picked', () => {
    expect(getStyleAssetStatus(row({ style_id: null }))).toBe('none');
  });

  it('returns none for the minimal style (no assets needed)', () => {
    expect(getStyleAssetStatus(row({ style_id: 'minimal_gradient_v1' }))).toBe('none');
  });

  it('returns none for an unknown style id (defensive — no eternal spinner)', () => {
    expect(getStyleAssetStatus(row({ style_id: 'made_up_style' }))).toBe('none');
  });
});

describe('getStyleAssetStatus — Doodle branch', () => {
  it('returns generating when doodle assets are absent', () => {
    expect(
      getStyleAssetStatus(row({ style_id: 'doodle_explainer_2_short', style_assets: {} })),
    ).toBe('generating');
  });

  it('returns generating when style_assets has doodle but no base_url', () => {
    expect(
      getStyleAssetStatus(
        row({
          style_id: 'doodle_explainer_2_short',
          // @ts-expect-error — runtime defence for partial blobs
          style_assets: { doodle: { variants: [] } },
        }),
      ),
    ).toBe('generating');
  });

  it('returns ready when doodle.base_url is populated', () => {
    expect(
      getStyleAssetStatus(
        row({
          style_id: 'doodle_explainer_2_short',
          style_assets: {
            doodle: {
              base_url: 'https://example.com/base.png',
              variants: [],
            },
          },
        }),
      ),
    ).toBe('ready');
  });
});

describe('getStyleAssetStatus — Paint branch', () => {
  it('returns generating when paint assets are absent', () => {
    expect(
      getStyleAssetStatus(row({ style_id: 'paint_explainer_v1_short', style_assets: {} })),
    ).toBe('generating');
  });

  it('returns ready when paint.base_url is populated', () => {
    expect(
      getStyleAssetStatus(
        row({
          style_id: 'paint_explainer_v1_short',
          style_assets: {
            paint: {
              base_url: 'https://example.com/paint-base.png',
              variants: [],
            },
          },
        }),
      ),
    ).toBe('ready');
  });

  it('does NOT confuse a doodle blob with a paint style request', () => {
    expect(
      getStyleAssetStatus(
        row({
          style_id: 'paint_explainer_v1_short',
          style_assets: {
            doodle: {
              base_url: 'https://example.com/doodle-base.png',
              variants: [],
            },
          },
        }),
      ),
    ).toBe('generating');
  });
});

describe('styleAssetLabel', () => {
  it('returns Doodle / Paint / Minimal for the registered ids', () => {
    expect(styleAssetLabel('doodle_explainer_2_short')).toBe('Doodle');
    expect(styleAssetLabel('paint_explainer_v1_short')).toBe('Paint');
    expect(styleAssetLabel('minimal_gradient_v1')).toBe('Minimal');
  });

  it('falls back to Style for unknown / missing ids', () => {
    expect(styleAssetLabel(null)).toBe('Style');
    expect(styleAssetLabel(undefined)).toBe('Style');
    expect(styleAssetLabel('made_up')).toBe('Style');
  });
});

describe('isGenerationStale', () => {
  const NOW = 1_900_000_000_000; // fixed epoch so the helper stays pure
  const iso = (ms: number) => new Date(ms).toISOString();
  const prog = (o: Partial<GenerationProgressState>): GenerationProgressState => ({ ...o });

  it('returns false for empty / terminal progress', () => {
    expect(isGenerationStale(undefined, NOW)).toBe(false);
    expect(isGenerationStale(null, NOW)).toBe(false);
    expect(isGenerationStale(prog({}), NOW)).toBe(false);
    expect(isGenerationStale(prog({ phase: 'done', updated_at: iso(0) }), NOW)).toBe(false);
    expect(isGenerationStale(prog({ phase: 'error', updated_at: iso(0) }), NOW)).toBe(false);
  });

  it('returns false for a job heartbeated within the stale window (cron alive)', () => {
    const updatedAt = iso(NOW - (SHORTS_ASSET_STALE_MS - 5_000));
    // Even with an ancient start, a fresh updated_at means the cron is
    // actively advancing it — not stale.
    expect(
      isGenerationStale(prog({ phase: 'variant', started_at: iso(0), updated_at: updatedAt }), NOW),
    ).toBe(false);
  });

  it('returns true once no heartbeat has landed within the stale window', () => {
    const updatedAt = iso(NOW - (SHORTS_ASSET_STALE_MS + 5_000));
    expect(isGenerationStale(prog({ phase: 'variant', updated_at: updatedAt }), NOW)).toBe(true);
    expect(isGenerationStale(prog({ phase: 'queued', updated_at: updatedAt }), NOW)).toBe(true);
    expect(isGenerationStale(prog({ phase: 'base', updated_at: updatedAt }), NOW)).toBe(true);
  });

  it('falls back to started_at when updated_at is absent (legacy rows)', () => {
    expect(
      isGenerationStale(prog({ phase: 'variant', started_at: iso(NOW - (SHORTS_ASSET_STALE_MS + 5_000)) }), NOW),
    ).toBe(true);
    expect(
      isGenerationStale(prog({ phase: 'variant', started_at: iso(NOW - 1_000) }), NOW),
    ).toBe(false);
  });

  it('returns false when no timestamp is present or it is unparseable', () => {
    expect(isGenerationStale(prog({ phase: 'variant' }), NOW)).toBe(false);
    expect(isGenerationStale(prog({ phase: 'variant', updated_at: 'not-a-date' }), NOW)).toBe(false);
  });
});

describe('anyRowGenerating', () => {
  it('returns false for an empty list', () => {
    expect(anyRowGenerating([])).toBe(false);
  });

  it('returns false when every row is ready / none', () => {
    const rows = [
      row({ style_id: 'minimal_gradient_v1' }),
      row({
        style_id: 'doodle_explainer_2_short',
        style_assets: { doodle: { base_url: 'x', variants: [] } },
      }),
      row({ medium: 'short_clip' }),
    ];
    expect(anyRowGenerating(rows)).toBe(false);
  });

  it('returns true when any row is generating', () => {
    const rows = [
      row({ style_id: 'minimal_gradient_v1' }),
      row({ style_id: 'doodle_explainer_2_short', style_assets: {} }),
    ];
    expect(anyRowGenerating(rows)).toBe(true);
  });
});
