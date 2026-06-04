/**
 * Unit tests for the pure helpers behind the Shorts editor's split + tabs
 * layout. Locks the URL-hash whitelist, the Render-CTA gating rules, and
 * the status-chip + tab-badge mappings so a future change can't silently
 * break the "preview is always in view" contract.
 *
 * Plan: `_plans/2026-06-04-shorts-editor-redesign-split-tabs.md`.
 */
import { describe, expect, it } from 'vitest';
import {
  badgeFor,
  chipsFor,
  computeRenderCtaState,
  parseTabHash,
  TAB_KEYS,
} from '@/components/shorts/editor/editor-tabs';
import type { ShortRow } from '@/lib/shorts-types';

function baseRow(overrides: Partial<ShortRow> = {}): ShortRow {
  return {
    id: 'short-1',
    workspace_id: 'ws-1',
    project_id: null,
    source_script_id: null,
    kind: 'extracted',
    medium: 'short_native',
    title: 'Test',
    short_script: 'A test script with words.',
    hook: null,
    payoff: null,
    word_count: 5,
    estimated_duration_seconds: 3,
    source_title: null,
    source_description: null,
    seo_result: null,
    voiceover_audio_url: null,
    voiceover_blob_pathname: null,
    voiceover_voice_id: null,
    voiceover_duration_seconds: null,
    rendered_video_url: null,
    ai_model: null,
    notes: null,
    hook_score: null,
    dismissed_at: null,
    source_youtube_video_id: null,
    clip_start_ms: null,
    clip_end_ms: null,
    style_id: 'minimal_gradient_v1',
    style_assets: {},
    captions_config: {},
    generation_progress: {},
    assets_context: null,
    created_at: '2026-06-04T00:00:00Z',
    updated_at: '2026-06-04T00:00:00Z',
    ...overrides,
  };
}

describe('parseTabHash', () => {
  it('returns the tab key for a known hash', () => {
    expect(parseTabHash('#captions')).toBe('captions');
    expect(parseTabHash('#voice')).toBe('voice');
    expect(parseTabHash('#render')).toBe('render');
  });

  it('lowercases before matching so #Captions still works', () => {
    expect(parseTabHash('#Captions')).toBe('captions');
    expect(parseTabHash('#STYLE')).toBe('style');
  });

  it('falls back to script for the empty hash', () => {
    expect(parseTabHash('')).toBe('script');
    expect(parseTabHash('#')).toBe('script');
  });

  it('falls back to script for unknown values (no DOM injection surface)', () => {
    expect(parseTabHash('#foo')).toBe('script');
    expect(parseTabHash('#javascript:alert(1)')).toBe('script');
    expect(parseTabHash('#<script>')).toBe('script');
  });

  it('every TAB_KEYS entry round-trips through the parser', () => {
    for (const key of TAB_KEYS) {
      expect(parseTabHash(`#${key}`)).toBe(key);
    }
  });
});

describe('computeRenderCtaState', () => {
  it('disables the CTA when there is no voiceover', () => {
    const r = computeRenderCtaState(baseRow());
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/voiceover/i);
  });

  it('enables the CTA for minimal once the voiceover is generated', () => {
    const r = computeRenderCtaState(
      baseRow({ voiceover_audio_url: 'https://blob.test/vo.mp3' }),
    );
    expect(r.enabled).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('keeps the CTA disabled for Doodle until style assets are ready', () => {
    const r = computeRenderCtaState(
      baseRow({
        voiceover_audio_url: 'https://blob.test/vo.mp3',
        style_id: 'doodle_explainer_2_short',
        style_assets: {},
      }),
    );
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/assets/i);
  });

  it('keeps the CTA disabled for Paint until style assets are ready', () => {
    const r = computeRenderCtaState(
      baseRow({
        voiceover_audio_url: 'https://blob.test/vo.mp3',
        style_id: 'paint_explainer_v1_short',
        style_assets: {},
      }),
    );
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/assets/i);
  });

  it('enables the CTA for Doodle when both voiceover + assets are ready', () => {
    const r = computeRenderCtaState(
      baseRow({
        voiceover_audio_url: 'https://blob.test/vo.mp3',
        style_id: 'doodle_explainer_2_short',
        style_assets: {
          doodle: {
            base_url: 'https://r2.test/base.png',
            variants: [
              { url: 'https://r2.test/v0.png', caption_chunk_start_index: 0 },
            ],
          },
        },
      }),
    );
    expect(r.enabled).toBe(true);
    expect(r.reason).toBeNull();
  });
});

describe('badgeFor', () => {
  it('returns "none" for tabs with nothing to flag', () => {
    expect(badgeFor('script', baseRow())).toBe('none');
    expect(badgeFor('captions', baseRow())).toBe('none');
    expect(badgeFor('seo', baseRow())).toBe('none');
  });

  it('flags the Style tab yellow while an asset job is in flight', () => {
    expect(
      badgeFor('style', baseRow({ generation_progress: { phase: 'planning' } })),
    ).toBe('pending');
    expect(
      badgeFor('style', baseRow({ generation_progress: { phase: 'base' } })),
    ).toBe('pending');
    expect(
      badgeFor('style', baseRow({ generation_progress: { phase: 'variant' } })),
    ).toBe('pending');
    expect(
      badgeFor('style', baseRow({ generation_progress: { phase: 'queued' } })),
    ).toBe('pending');
  });

  it('flags the Style tab red on an error phase', () => {
    expect(
      badgeFor('style', baseRow({ generation_progress: { phase: 'error' } })),
    ).toBe('error');
  });

  it('flags the Style tab green once assets are ready', () => {
    expect(
      badgeFor(
        'style',
        baseRow({
          style_id: 'doodle_explainer_2_short',
          style_assets: {
            doodle: {
              base_url: 'https://r2.test/base.png',
              variants: [
                { url: 'https://r2.test/v0.png', caption_chunk_start_index: 0 },
              ],
            },
          },
        }),
      ),
    ).toBe('good');
  });

  it('flags the Voice tab green when a voiceover exists', () => {
    expect(
      badgeFor('voice', baseRow({ voiceover_audio_url: 'https://blob/vo.mp3' })),
    ).toBe('good');
    expect(badgeFor('voice', baseRow())).toBe('none');
  });

  it('flags the Render tab green when a rendered MP4 exists', () => {
    expect(
      badgeFor(
        'render',
        baseRow({ rendered_video_url: 'https://r2.test/short.mp4' }),
      ),
    ).toBe('good');
    expect(badgeFor('render', baseRow())).toBe('none');
  });
});

describe('chipsFor', () => {
  it('returns one chip per status row in a fixed order', () => {
    const chips = chipsFor(baseRow());
    expect(chips.map((c) => c.label)).toEqual([
      'Medium',
      'Words',
      'Length',
      'Voiceover',
      'Assets',
      'MP4',
    ]);
  });

  it('marks voiceover + MP4 as pending when missing', () => {
    const chips = chipsFor(baseRow());
    const vo = chips.find((c) => c.label === 'Voiceover')!;
    expect(vo.tone).toBe('pending');
    expect(vo.value).toBe('not yet');
    const mp4 = chips.find((c) => c.label === 'MP4')!;
    expect(mp4.tone).toBe('pending');
  });

  it('marks voiceover + MP4 as good when present', () => {
    const chips = chipsFor(
      baseRow({
        voiceover_audio_url: 'x',
        voiceover_duration_seconds: 30,
        rendered_video_url: 'y',
      }),
    );
    const vo = chips.find((c) => c.label === 'Voiceover')!;
    expect(vo.tone).toBe('good');
    expect(vo.value).toBe('30s');
    const mp4 = chips.find((c) => c.label === 'MP4')!;
    expect(mp4.tone).toBe('good');
  });

  it('renders the words + length cells with em-dashes when missing', () => {
    const chips = chipsFor(baseRow({ word_count: null, estimated_duration_seconds: null }));
    expect(chips.find((c) => c.label === 'Words')!.value).toBe('—');
    expect(chips.find((c) => c.label === 'Length')!.value).toBe('—');
  });
});
