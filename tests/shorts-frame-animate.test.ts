import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the b-roll wire primitives. The orchestrator only cares about
// the shape, not the wire details — those are exercised by broll's
// own tests.
vi.mock('@/lib/broll', async () => {
  const actual = await vi.importActual<typeof import('@/lib/broll')>('@/lib/broll');
  return {
    ...actual,
    kieCreateVideoTask: vi.fn(),
    kieFetchVideoStatus: vi.fn(),
  };
});

import {
  animateFrame,
  clearFrameAnimation,
  listShortsI2vModels,
} from '@/lib/shorts-frame-animate';
import { kieCreateVideoTask, kieFetchVideoStatus } from '@/lib/broll';
import type { ShortRow } from '@/lib/shorts-types';

const mockedCreate = vi.mocked(kieCreateVideoTask);
const mockedStatus = vi.mocked(kieFetchVideoStatus);

beforeEach(() => {
  mockedCreate.mockReset();
  mockedStatus.mockReset();
  process.env.KIE_API_KEY = 'test-kie-key';
});

function doodleRow(overrides: Partial<ShortRow> = {}): ShortRow {
  return {
    id: 'short-1',
    workspace_id: 'ws-1',
    project_id: null,
    source_script_id: null,
    kind: 'extracted',
    medium: 'short_native',
    title: 'Test',
    short_script: 'A test script with plenty of words to keep it well past the 30-char minimum used by the i2v prompt validator.',
    hook: null,
    payoff: null,
    word_count: 4,
    estimated_duration_seconds: 2,
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
    style_id: 'doodle_explainer_2_short',
    style_assets: {
      doodle: {
        base_url: 'https://r2.test/base.png',
        base_prompt:
          'A character on a white canvas with thick black ink outlines holding a question-mark sign above their head',
        variants: [
          {
            url: 'https://r2.test/v0.png',
            caption_chunk_start_index: 0,
            edit_prompt:
              'The character now waves their hand vigorously while the question mark wobbles in the air above',
          },
          {
            url: 'https://r2.test/v1.png',
            caption_chunk_start_index: 3,
            edit_prompt:
              'The character now jumps with both arms raised in celebration as the question mark transforms into an exclamation mark',
          },
        ],
      },
    },
    captions_config: {},
    generation_progress: {},
    assets_context: null,
    qa_result: null,
    qa_score: null,
    qa_run_at: null,
    batch_id: null,
    youtube_video_id: null,
    youtube_status: null,
    youtube_publish_at: null,
    youtube_metadata: {},
    youtube_uploaded_at: null,
    youtube_upload_error: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('listShortsI2vModels', () => {
  it('returns only i2v models that support 9:16 portrait', () => {
    const models = listShortsI2vModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.kind).toBe('image-to-video');
      expect(m.supportedAspects).toContain('9:16');
    }
  });
});

describe('animateFrame — base', () => {
  it('creates a task, polls to success, and persists animation on base', async () => {
    mockedCreate.mockResolvedValue({ taskId: 'task-1' });
    mockedStatus.mockResolvedValue({
      state: 'success',
      videoUrl: 'https://kie.test/anim.mp4',
      thumbnailUrl: 'https://kie.test/thumb.jpg',
    });
    const row = doodleRow();
    const result = await animateFrame(
      row,
      { kind: 'base' },
      { modelId: 'runway-i2v-5s-720p', durationSeconds: 5 },
    );
    expect(mockedCreate).toHaveBeenCalledOnce();
    expect(mockedCreate.mock.calls[0][0]).toMatchObject({
      apiKey: 'test-kie-key',
      aspectRatio: '9:16',
      durationSeconds: 5,
      stillImageUrl: 'https://r2.test/base.png',
    });
    expect(result.animation).toMatchObject({
      video_url: 'https://kie.test/anim.mp4',
      thumbnail_url: 'https://kie.test/thumb.jpg',
      model_id: 'runway-i2v-5s-720p',
      duration_s: 5,
      provider_request_id: 'task-1',
    });
    expect(result.style_assets.doodle?.base_animation?.video_url).toBe(
      'https://kie.test/anim.mp4',
    );
    // Variants are untouched.
    expect(result.style_assets.doodle?.variants).toHaveLength(2);
    expect(result.style_assets.doodle?.variants[0].animation).toBeUndefined();
  });
});

describe('animateFrame — variants', () => {
  it('persists animation on the targeted variant only', async () => {
    mockedCreate.mockResolvedValue({ taskId: 'task-v' });
    mockedStatus.mockResolvedValue({
      state: 'success',
      videoUrl: 'https://kie.test/v0.mp4',
    });
    const row = doodleRow();
    const result = await animateFrame(
      row,
      { kind: 'variant', index: 0 },
      { modelId: 'runway-i2v-5s-720p' },
    );
    // Source still URL for variant 0 must be its own url, NOT the base.
    expect(mockedCreate.mock.calls[0][0].stillImageUrl).toBe('https://r2.test/v0.png');
    const variants = result.style_assets.doodle?.variants ?? [];
    expect(variants[0].animation?.video_url).toBe('https://kie.test/v0.mp4');
    expect(variants[1].animation).toBeUndefined();
    expect(result.style_assets.doodle?.base_animation).toBeUndefined();
  });

  it('throws on out-of-range variant index', async () => {
    const row = doodleRow();
    await expect(
      animateFrame(row, { kind: 'variant', index: 99 }, { modelId: 'runway-i2v-5s-720p' }),
    ).rejects.toThrow(/out of range/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe('animateFrame — failure paths', () => {
  it('throws when KIE_API_KEY is missing', async () => {
    delete process.env.KIE_API_KEY;
    const row = doodleRow();
    await expect(
      animateFrame(row, { kind: 'base' }, { modelId: 'runway-i2v-5s-720p' }),
    ).rejects.toThrow(/KIE_API_KEY is not set/);
  });

  it('throws when the model id is unknown', async () => {
    const row = doodleRow();
    await expect(
      animateFrame(row, { kind: 'base' }, { modelId: 'not-a-real-model' }),
    ).rejects.toThrow(/Unknown i2v model/);
  });

  it('throws when the Kie task fails terminally', async () => {
    mockedCreate.mockResolvedValue({ taskId: 'task-fail' });
    mockedStatus.mockResolvedValue({
      state: 'fail',
      failMsg: 'Model rejected the input frame',
    });
    const row = doodleRow();
    await expect(
      animateFrame(row, { kind: 'base' }, { modelId: 'runway-i2v-5s-720p' }),
    ).rejects.toThrow(/Model rejected/);
  });

  it('throws when the row is on a non-frame-bearing style', async () => {
    const row = doodleRow({ style_id: 'minimal_gradient_v1', style_assets: {} });
    await expect(
      animateFrame(row, { kind: 'base' }, { modelId: 'runway-i2v-5s-720p' }),
    ).rejects.toThrow(/Doodle or Paint/);
  });
});

describe('clearFrameAnimation', () => {
  it('removes the base animation field', () => {
    const row = doodleRow({
      style_assets: {
        doodle: {
          base_url: 'https://r2.test/base.png',
          base_animation: {
            video_url: 'x',
            model_id: 'runway-i2v-5s-720p',
            cost_usd: 0.06,
            duration_s: 5,
            generated_at: '2026-06-03T00:00:00Z',
            provider_request_id: 't',
          },
          variants: [
            { url: 'https://r2.test/v0.png', caption_chunk_start_index: 0 },
          ],
        },
      },
    });
    const result = clearFrameAnimation(row, { kind: 'base' });
    expect(result.style_assets.doodle?.base_animation).toBeUndefined();
    // Variants untouched.
    expect(result.style_assets.doodle?.variants[0].url).toBe('https://r2.test/v0.png');
  });

  it('removes one variant animation without touching the others', () => {
    const baseAnim = {
      video_url: 'b',
      model_id: 'runway-i2v-5s-720p',
      cost_usd: 0.06,
      duration_s: 5,
      generated_at: '2026-06-03T00:00:00Z',
      provider_request_id: 't0',
    };
    const v0Anim = { ...baseAnim, video_url: 'v0' };
    const v1Anim = { ...baseAnim, video_url: 'v1' };
    const row = doodleRow({
      style_assets: {
        doodle: {
          base_url: 'https://r2.test/base.png',
          variants: [
            { url: 'https://r2.test/v0.png', caption_chunk_start_index: 0, animation: v0Anim },
            { url: 'https://r2.test/v1.png', caption_chunk_start_index: 3, animation: v1Anim },
          ],
        },
      },
    });
    const result = clearFrameAnimation(row, { kind: 'variant', index: 0 });
    expect(result.style_assets.doodle?.variants[0].animation).toBeUndefined();
    expect(result.style_assets.doodle?.variants[1].animation?.video_url).toBe('v1');
  });

  it('is a no-op when the targeted animation does not exist', () => {
    const row = doodleRow();
    const result = clearFrameAnimation(row, { kind: 'base' });
    expect(result.style_assets.doodle?.base_animation).toBeUndefined();
  });
});
