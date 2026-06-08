import { describe, expect, it } from 'vitest';
import { reasonShortIsNotUploadable } from '@/lib/shorts-batch-uploader';
import type { ShortRow } from '@/lib/shorts-types';

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
    batch_id: 'b',
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

describe('reasonShortIsNotUploadable', () => {
  it('returns null for a ready-but-not-uploaded short', () => {
    expect(
      reasonShortIsNotUploadable(shortFixture({ rendered_video_url: 'https://r2/v.mp4' })),
    ).toBeNull();
  });

  it('blocks shorts without a rendered video', () => {
    expect(reasonShortIsNotUploadable(shortFixture())).toBe('awaiting render');
  });

  it('blocks shorts already uploaded (idempotency guard)', () => {
    const s = shortFixture({
      rendered_video_url: 'https://r2/v.mp4',
      youtube_video_id: 'VID_1',
      youtube_status: 'uploaded',
    });
    expect(reasonShortIsNotUploadable(s)).toBe('already uploaded');
  });

  it('blocks shorts mid-upload (prevents racing parallel clicks)', () => {
    const s = shortFixture({
      rendered_video_url: 'https://r2/v.mp4',
      youtube_status: 'uploading',
    });
    expect(reasonShortIsNotUploadable(s)).toBe('upload in flight');
  });

  it('allows retry after a failed upload (no video_id yet)', () => {
    const s = shortFixture({
      rendered_video_url: 'https://r2/v.mp4',
      youtube_status: 'failed',
      youtube_upload_error: 'previous attempt timed out',
    });
    expect(reasonShortIsNotUploadable(s)).toBeNull();
  });
});
