import { describe, expect, it } from 'vitest';
import {
  assertValidTransition,
  BatchStateTransitionError,
  computeBatchTotals,
  expandDescriptionTemplate,
  seedYoutubeMetadataFromBatch,
} from '@/lib/shorts-batches';
import type { ShortRow } from '@/lib/shorts-types';
import type { ShortsBatchDefaults } from '@/lib/shorts-batches-types';

function shortFixture(overrides: Partial<ShortRow> = {}): ShortRow {
  return {
    id: 's',
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
    batch_id: 'batch-1',
    youtube_video_id: null,
    youtube_status: null,
    youtube_publish_at: null,
    youtube_metadata: {},
    youtube_uploaded_at: null,
    youtube_upload_error: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
    ...overrides,
  };
}

describe('assertValidTransition', () => {
  it('allows the happy-path sequence', () => {
    expect(() => assertValidTransition('setup', 'generating')).not.toThrow();
    expect(() => assertValidTransition('generating', 'review')).not.toThrow();
    expect(() => assertValidTransition('review', 'uploading')).not.toThrow();
    expect(() => assertValidTransition('uploading', 'done')).not.toThrow();
  });

  it("allows 'failed' from any non-terminal state", () => {
    for (const from of ['setup', 'generating', 'review', 'uploading'] as const) {
      expect(() => assertValidTransition(from, 'failed')).not.toThrow();
    }
  });

  it('allows recovery: uploading → review (retry path)', () => {
    expect(() => assertValidTransition('uploading', 'review')).not.toThrow();
  });

  it('allows operator reset: failed → setup', () => {
    expect(() => assertValidTransition('failed', 'setup')).not.toThrow();
  });

  it('blocks anything out of done', () => {
    for (const to of ['setup', 'generating', 'review', 'uploading', 'failed'] as const) {
      expect(() => assertValidTransition('done', to)).toThrow(BatchStateTransitionError);
    }
  });

  it("blocks 'setup' → 'done' (skipping middle states)", () => {
    expect(() => assertValidTransition('setup', 'done')).toThrow(BatchStateTransitionError);
  });

  it('blocks any backwards motion not in the matrix', () => {
    expect(() => assertValidTransition('review', 'setup')).toThrow();
    expect(() => assertValidTransition('generating', 'setup')).toThrow();
  });

  it('reports from/to in the error message', () => {
    try {
      assertValidTransition('done', 'setup');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BatchStateTransitionError);
      expect((err as BatchStateTransitionError).from).toBe('done');
      expect((err as BatchStateTransitionError).to).toBe('setup');
    }
  });
});

describe('computeBatchTotals', () => {
  it('counts an empty cohort as zeroes', () => {
    expect(computeBatchTotals([])).toEqual({
      planned: 0, generated: 0, failed: 0, uploaded: 0, scheduled: 0,
    });
  });

  it('counts generated when rendered_video_url is set', () => {
    const shorts = [
      shortFixture({ rendered_video_url: 'https://r2.test/v1.mp4' }),
      shortFixture({ rendered_video_url: null }),
    ];
    expect(computeBatchTotals(shorts).generated).toBe(1);
  });

  it('counts failed when youtube_upload_error is non-null', () => {
    const shorts = [
      shortFixture({ youtube_upload_error: 'Quota exceeded' }),
      shortFixture(),
    ];
    expect(computeBatchTotals(shorts).failed).toBe(1);
  });

  it("counts uploaded for both 'uploaded' and 'published'", () => {
    const shorts = [
      shortFixture({ youtube_status: 'uploaded' }),
      shortFixture({ youtube_status: 'published' }),
      shortFixture({ youtube_status: 'pending' }),
    ];
    expect(computeBatchTotals(shorts).uploaded).toBe(2);
  });

  it("counts scheduled in BOTH scheduled and uploaded buckets (a scheduled video is already on YouTube)", () => {
    const shorts = [
      shortFixture({ youtube_status: 'scheduled' }),
      shortFixture({ youtube_status: 'scheduled' }),
    ];
    const totals = computeBatchTotals(shorts);
    expect(totals.scheduled).toBe(2);
    expect(totals.uploaded).toBe(2);
  });

  it('treats planned as the total cohort size (not just generated)', () => {
    const shorts = [shortFixture(), shortFixture(), shortFixture()];
    expect(computeBatchTotals(shorts).planned).toBe(3);
  });
});

describe('expandDescriptionTemplate', () => {
  it('replaces every placeholder', () => {
    const out = expandDescriptionTemplate('{{title}} — {{hook}} ({{payoff}})', {
      title: 'A title',
      hook: 'The hook',
      payoff: 'The payoff',
    });
    expect(out).toBe('A title — The hook (The payoff)');
  });

  it('replaces multiple occurrences of the same placeholder', () => {
    const out = expandDescriptionTemplate('{{title}}/{{title}}/{{title}}', {
      title: 'X',
      hook: '',
      payoff: '',
    });
    expect(out).toBe('X/X/X');
  });

  it('passes through text with no placeholders', () => {
    expect(expandDescriptionTemplate('Static body', { title: '', hook: '', payoff: '' }))
      .toBe('Static body');
  });

  it('substitutes empty string for missing fields without leaving the placeholder behind', () => {
    expect(expandDescriptionTemplate('a {{hook}} b', { title: '', hook: '', payoff: '' }))
      .toBe('a  b');
  });
});

describe('seedYoutubeMetadataFromBatch', () => {
  const defaults: ShortsBatchDefaults = {
    voiceId: 'voice-1',
    language: 'en',
    categoryId: '27',
    playlistIds: ['PL_A'],
    descriptionTemplate: '{{title}} — see more: example.com',
    tagsPool: ['howto', 'explainer'],
    defaultPrivacy: 'public',
    madeForKids: false,
    ageRestricted: false,
    paidPromotion: false,
    aiContentDisclosure: true,
  };

  it('seeds title + tags + category from defaults + top SEO', () => {
    const short = shortFixture({
      title: 'Original title',
      seo_result: {
        primary_keyword: 'kw',
        titles: [{ text: 'SEO Winner Title', score: 95, rationale: 'top' }],
        descriptions: [{ text: 'SEO desc', score: 90, rationale: 'top' }],
        hashtag_sets: [{ tags: ['seo', 'tag'], score: 90, rationale: 'top' }],
        notes: '',
      },
    });
    const meta = seedYoutubeMetadataFromBatch({ short, defaults });
    expect(meta.title).toBe('SEO Winner Title');
    expect(meta.categoryId).toBe('27');
    expect(meta.defaultLanguage).toBe('en');
    expect(meta.tags).toEqual(['howto', 'explainer', 'seo', 'tag']);
    expect(meta.playlistIds).toEqual(['PL_A']);
  });

  it('expands the description template with the SEO-winner title + idea hook/payoff', () => {
    const short = shortFixture({
      hook: 'A hook',
      payoff: 'A payoff',
      seo_result: {
        primary_keyword: 'kw',
        titles: [{ text: 'Top title', score: 95, rationale: '' }],
        descriptions: [{ text: 'unused', score: 1, rationale: '' }],
        hashtag_sets: [],
        notes: '',
      },
    });
    const meta = seedYoutubeMetadataFromBatch({ short, defaults });
    expect(meta.description).toBe('Top title — see more: example.com');
  });

  it('falls back to top SEO description when no template is set', () => {
    const short = shortFixture({
      seo_result: {
        primary_keyword: 'kw',
        titles: [{ text: 't', score: 1, rationale: '' }],
        descriptions: [{ text: 'fallback desc', score: 95, rationale: '' }],
        hashtag_sets: [],
        notes: '',
      },
    });
    const meta = seedYoutubeMetadataFromBatch({
      short,
      defaults: { ...defaults, descriptionTemplate: undefined },
    });
    expect(meta.description).toBe('fallback desc');
  });

  it('deduplicates tags (batch pool wins position when both have it)', () => {
    const short = shortFixture({
      seo_result: {
        primary_keyword: 'kw',
        titles: [{ text: 't', score: 1, rationale: '' }],
        descriptions: [],
        hashtag_sets: [{ tags: ['howto', 'newtag'], score: 1, rationale: '' }],
        notes: '',
      },
    });
    const meta = seedYoutubeMetadataFromBatch({ short, defaults });
    expect(meta.tags).toEqual(['howto', 'explainer', 'newtag']);
  });

  it('defaults aiContentDisclosure to true even when the batch did not set it (pipeline generates with AI)', () => {
    const short = shortFixture({
      seo_result: {
        primary_keyword: 'kw',
        titles: [{ text: 't', score: 1, rationale: '' }],
        descriptions: [],
        hashtag_sets: [],
        notes: '',
      },
    });
    const { aiContentDisclosure, ...rest } = defaults;
    void aiContentDisclosure;
    const meta = seedYoutubeMetadataFromBatch({ short, defaults: rest });
    expect(meta.aiContentDisclosure).toBe(true);
  });

  it('defaults ageRestricted and paidPromotion to false when unset on the batch', () => {
    const short = shortFixture({
      seo_result: {
        primary_keyword: 'kw',
        titles: [{ text: 't', score: 1, rationale: '' }],
        descriptions: [],
        hashtag_sets: [],
        notes: '',
      },
    });
    const { ageRestricted, paidPromotion, ...rest } = defaults;
    void ageRestricted; void paidPromotion;
    const meta = seedYoutubeMetadataFromBatch({ short, defaults: rest });
    expect(meta.ageRestricted).toBe(false);
    expect(meta.paidPromotion).toBe(false);
  });
});
