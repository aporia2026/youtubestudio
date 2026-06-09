import { describe, expect, it } from 'vitest';
import {
  isShortTerminal,
  nextStageFor,
  pickShortsToAdvance,
  allShortsAtTerminal,
  MAX_PER_TICK,
} from '@/lib/shorts-batch-orchestrator';
import type { ShortRow } from '@/lib/shorts-types';

function shortAt(stage: 'extract' | 'voiceover' | 'seo' | 'render' | 'done' | 'failed'): ShortRow {
  const base: ShortRow = {
    id: stage,
    workspace_id: 'ws',
    project_id: null,
    source_script_id: null,
    kind: 'extracted',
    medium: 'short_native',
    title: null,
    short_script: null,
    hook: null,
    payoff: null,
    word_count: null,
    estimated_duration_seconds: null,
    source_title: null,
    source_description: null,
    seo_result: null,
    voiceover_audio_url: null,
    voiceover_blob_pathname: null,
    voiceover_voice_id: null,
    voiceover_duration_seconds: null,
    rendered_video_url: null,
    ai_model: null,
    generation_params: {},
    notes: null,
    hook_score: null,
    dismissed_at: null,
    source_youtube_video_id: null,
    clip_start_ms: null,
    clip_end_ms: null,
    style_id: null,
    style_assets: {},
    captions_config: {},
    generation_progress: {},
    assets_context: null,
    qa_result: null,
    qa_score: null,
    qa_run_at: null,
    batch_id: 'batch',
    youtube_video_id: null,
    youtube_status: null,
    youtube_publish_at: null,
    youtube_metadata: {},
    youtube_uploaded_at: null,
    youtube_upload_error: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
  };

  switch (stage) {
    case 'extract':
      // Placeholder short — nothing filled in yet.
      return base;
    case 'voiceover':
      return { ...base, short_script: 'Some script.' };
    case 'seo':
      return { ...base, short_script: 'x', voiceover_audio_url: 'https://r2/v.mp3' };
    case 'render':
      // Has SEO + voiceover but not yet rendered — waiting on the asset pipeline.
      return {
        ...base,
        short_script: 'x',
        voiceover_audio_url: 'https://r2/v.mp3',
        seo_result: {
          primary_keyword: 'k',
          titles: [], descriptions: [], hashtag_sets: [], notes: '',
        },
      };
    case 'done':
      return {
        ...base,
        short_script: 'x',
        voiceover_audio_url: 'https://r2/v.mp3',
        seo_result: {
          primary_keyword: 'k',
          titles: [], descriptions: [], hashtag_sets: [], notes: '',
        },
        rendered_video_url: 'https://r2/render.mp4',
      };
    case 'failed':
      return {
        ...base,
        generation_progress: { phase: 'error', error_message: 'extract LLM blew up' },
      };
  }
}

describe('isShortTerminal', () => {
  it('returns true when rendered_video_url is set', () => {
    expect(isShortTerminal(shortAt('done'))).toBe(true);
  });
  it('returns true when generation_progress.phase=error', () => {
    expect(isShortTerminal(shortAt('failed'))).toBe(true);
  });
  it('returns false for in-flight stages', () => {
    expect(isShortTerminal(shortAt('extract'))).toBe(false);
    expect(isShortTerminal(shortAt('voiceover'))).toBe(false);
    expect(isShortTerminal(shortAt('seo'))).toBe(false);
    expect(isShortTerminal(shortAt('render'))).toBe(false);
  });
});

describe('nextStageFor', () => {
  it('returns extract when short_script is empty', () => {
    expect(nextStageFor(shortAt('extract'))).toBe('extract');
  });
  it('returns voiceover after extract', () => {
    expect(nextStageFor(shortAt('voiceover'))).toBe('voiceover');
  });
  it('returns seo after voiceover', () => {
    expect(nextStageFor(shortAt('seo'))).toBe('seo');
  });
  it('returns awaiting_render after seo (orchestrator does not own render)', () => {
    expect(nextStageFor(shortAt('render'))).toBe('awaiting_render');
  });
  it('returns terminal for rendered shorts', () => {
    expect(nextStageFor(shortAt('done'))).toBe('terminal');
  });
  it('returns terminal for failed shorts (orchestrator does not retry)', () => {
    expect(nextStageFor(shortAt('failed'))).toBe('terminal');
  });

  // Bug A regression suite (2026-06-10): the asset cron writes the base
  // frame URL onto style_assets.doodle.base_url DURING the 'base' phase,
  // before any variants exist. The old check fired render the moment
  // the doodle block appeared, sending half-baked inputs to Lambda that
  // hung or crashed. The new gate requires either:
  //   (a) cron has cleared its progress (finalizeDone runs `= '{}'`),
  //       AND at least one variant landed; OR
  //   (b) bypass via the legacy `phase === 'done'` marker (dead in
  //       practice today — cron never writes it — but kept for forward-
  //       compat with a future explicit-done finalize).
  // Anything in-flight (queued/planning/base/variant/error) stays
  // 'awaiting_render' so the cron can finish.
  describe('asset-cron handoff gating (Bug A regression)', () => {
    const seoReady = {
      ...shortAt('render'), // has script + voiceover + seo, no render
    };

    it("stays awaiting_render while cron is 'queued'", () => {
      expect(nextStageFor({
        ...seoReady,
        generation_progress: { phase: 'queued' },
      })).toBe('awaiting_render');
    });

    it("stays awaiting_render while cron is 'planning'", () => {
      expect(nextStageFor({
        ...seoReady,
        generation_progress: { phase: 'planning' },
      })).toBe('awaiting_render');
    });

    it("stays awaiting_render during 'base' phase even when base_url lands", () => {
      // This is the canary for the bug: base URL exists but no variants
      // yet. Pre-fix this returned 'trigger_render' and we shipped a
      // doomed render to Lambda.
      expect(nextStageFor({
        ...seoReady,
        generation_progress: { phase: 'base' },
        style_assets: { doodle: { base_url: 'https://r2/base.png', variants: [] } },
      })).toBe('awaiting_render');
    });

    it("stays awaiting_render during 'variant' phase with partial variants", () => {
      expect(nextStageFor({
        ...seoReady,
        generation_progress: { phase: 'variant', current: 2, total: 8 },
        style_assets: {
          doodle: {
            base_url: 'https://r2/base.png',
            variants: [
              { url: 'https://r2/v1.png', caption_chunk_start_index: 0 },
              { url: 'https://r2/v2.png', caption_chunk_start_index: 1 },
            ],
          },
        },
      })).toBe('awaiting_render');
    });

    it("does NOT trigger render when only base_url exists with no variants (post-finalize edge)", () => {
      // After finalizeDone the cron sets generation_progress = '{}', but
      // if for any reason a row landed in that state without variants
      // (e.g. legacy data, partial finalize), we still must NOT trigger.
      expect(nextStageFor({
        ...seoReady,
        generation_progress: {},
        style_assets: { doodle: { base_url: 'https://r2/base.png', variants: [] } },
      })).toBe('awaiting_render');
    });

    it("triggers render when cron has finalized (progress cleared) AND variants exist", () => {
      expect(nextStageFor({
        ...seoReady,
        generation_progress: {}, // cron's finalizeDone clears to {}
        style_assets: {
          doodle: {
            base_url: 'https://r2/base.png',
            variants: [{ url: 'https://r2/v1.png', caption_chunk_start_index: 0 }],
          },
        },
      })).toBe('trigger_render');
    });

    it("triggers render for the paint style block too", () => {
      expect(nextStageFor({
        ...seoReady,
        generation_progress: {},
        style_assets: {
          paint: {
            base_url: 'https://r2/p-base.png',
            variants: [{ url: 'https://r2/p-v1.png', caption_chunk_start_index: 0 }],
          },
        },
      })).toBe('trigger_render');
    });

    it("returns awaiting_render once render kickoff has set phase='rendering'", () => {
      expect(nextStageFor({
        ...seoReady,
        generation_progress: { phase: 'rendering' },
        style_assets: {
          doodle: {
            base_url: 'https://r2/base.png',
            variants: [{ url: 'https://r2/v1.png', caption_chunk_start_index: 0 }],
          },
        },
      })).toBe('awaiting_render');
    });
  });
});

describe('pickShortsToAdvance', () => {
  it('skips terminal shorts (rendered + failed)', () => {
    const shorts = [shortAt('done'), shortAt('failed'), shortAt('extract')];
    const picked = pickShortsToAdvance(shorts);
    expect(picked).toHaveLength(1);
    expect(picked[0].id).toBe('extract');
  });

  it('skips awaiting_render shorts (asset pipeline owns those)', () => {
    const shorts = [shortAt('render'), shortAt('extract')];
    expect(pickShortsToAdvance(shorts).map((s) => s.id)).toEqual(['extract']);
  });

  it('caps at MAX_PER_TICK', () => {
    const overflowing = Array.from({ length: MAX_PER_TICK + 2 }, () => shortAt('extract'));
    expect(pickShortsToAdvance(overflowing)).toHaveLength(MAX_PER_TICK);
  });

  it('preserves input order so retries are deterministic', () => {
    const shorts = [
      { ...shortAt('voiceover'), id: 'first' },
      { ...shortAt('extract'),   id: 'second' },
      { ...shortAt('seo'),       id: 'third' },
    ];
    expect(pickShortsToAdvance(shorts).map((s) => s.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('allShortsAtTerminal', () => {
  it('is true when every short is rendered OR failed', () => {
    expect(allShortsAtTerminal([shortAt('done'), shortAt('failed'), shortAt('done')])).toBe(true);
  });

  it('is false when even one short is still in flight', () => {
    expect(allShortsAtTerminal([shortAt('done'), shortAt('voiceover')])).toBe(false);
  });

  it('is false when shorts are awaiting render (orchestrator views render as not-yet-terminal so batch stays in generating)', () => {
    // Important: the batch should NOT advance to 'review' if a short
    // is awaiting render — the user can't review a not-yet-rendered
    // short. This test pins that decision.
    expect(allShortsAtTerminal([shortAt('done'), shortAt('render')])).toBe(false);
  });

  it('is true for an empty cohort (vacuous)', () => {
    expect(allShortsAtTerminal([])).toBe(true);
  });
});
