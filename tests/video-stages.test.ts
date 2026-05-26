import { describe, expect, it } from 'vitest';
import {
  STAGE_CHAIN,
  getStageDef,
  getStageIndex,
  getStageNeighbors,
  isVideoStageId,
  PIPELINE_STAGE_TO_VIDEO_STAGE,
  SCHEDULE_STATUS_TO_VIDEO_STAGE,
} from '@/lib/video-stages';

describe('STAGE_CHAIN integrity', () => {
  it('has exactly 10 stages in the canonical order', () => {
    expect(STAGE_CHAIN.map(s => s.id)).toEqual([
      'idea',
      'script',
      'qa',
      'voiceover',
      'production_doc',
      'thumbnail',
      'edit',
      'seo',
      'scheduled',
      'published',
    ]);
  });

  it('every stage has a non-empty label and a tool path', () => {
    for (const s of STAGE_CHAIN) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.toolPath.startsWith('/')).toBe(true);
    }
  });

  it('isVideoStageId accepts every canonical id and rejects garbage', () => {
    for (const s of STAGE_CHAIN) {
      expect(isVideoStageId(s.id)).toBe(true);
    }
    expect(isVideoStageId('queued')).toBe(false); // pipeline-internal, not a VideoStageId
    expect(isVideoStageId('')).toBe(false);
    expect(isVideoStageId(null)).toBe(false);
    expect(isVideoStageId(undefined)).toBe(false);
    expect(isVideoStageId('SCRIPT')).toBe(false); // case-sensitive
  });
});

describe('getStageIndex + getStageDef', () => {
  it('idea is index 0, published is index 9', () => {
    expect(getStageIndex('idea')).toBe(0);
    expect(getStageIndex('published')).toBe(9);
  });

  it('getStageDef round-trips the canonical id', () => {
    expect(getStageDef('qa').id).toBe('qa');
    expect(getStageDef('voiceover').label).toBe('Voiceover');
  });
});

describe('getStageNeighbors', () => {
  it('idea has no prev, has next=script', () => {
    const n = getStageNeighbors('idea');
    expect(n.prev).toBeNull();
    expect(n.next?.id).toBe('script');
  });

  it('published has prev=scheduled, no next', () => {
    const n = getStageNeighbors('published');
    expect(n.prev?.id).toBe('scheduled');
    expect(n.next).toBeNull();
  });

  it('middle stage has both neighbors', () => {
    const n = getStageNeighbors('qa');
    expect(n.prev?.id).toBe('script');
    expect(n.next?.id).toBe('voiceover');
  });
});

describe('PIPELINE_STAGE_TO_VIDEO_STAGE coverage', () => {
  it('maps every active auto-pipeline stage to a real VideoStageId', () => {
    for (const [pipeline, video] of Object.entries(PIPELINE_STAGE_TO_VIDEO_STAGE)) {
      expect(isVideoStageId(video), `pipeline '${pipeline}' maps to '${video}'`).toBe(true);
    }
  });

  it('queued + generating_idea both map to idea', () => {
    expect(PIPELINE_STAGE_TO_VIDEO_STAGE.queued).toBe('idea');
    expect(PIPELINE_STAGE_TO_VIDEO_STAGE.generating_idea).toBe('idea');
  });

  it('done maps to published', () => {
    expect(PIPELINE_STAGE_TO_VIDEO_STAGE.done).toBe('published');
  });

  it('running_qa + qa_retry both map to qa', () => {
    expect(PIPELINE_STAGE_TO_VIDEO_STAGE.running_qa).toBe('qa');
    expect(PIPELINE_STAGE_TO_VIDEO_STAGE.qa_retry).toBe('qa');
  });
});

describe('SCHEDULE_STATUS_TO_VIDEO_STAGE coverage', () => {
  it('maps every schedule status to a real VideoStageId', () => {
    for (const [status, video] of Object.entries(SCHEDULE_STATUS_TO_VIDEO_STAGE)) {
      expect(isVideoStageId(video), `schedule '${status}' maps to '${video}'`).toBe(true);
    }
  });

  it('upload_queue + scheduled both map to scheduled', () => {
    expect(SCHEDULE_STATUS_TO_VIDEO_STAGE.upload_queue).toBe('scheduled');
    expect(SCHEDULE_STATUS_TO_VIDEO_STAGE.scheduled).toBe('scheduled');
  });
});
