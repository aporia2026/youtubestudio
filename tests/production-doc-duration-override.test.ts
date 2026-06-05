/**
 * Regression tests for `productionDocToVideoConfig` honoring
 * `duration_override_ms` set by the timeline editor.
 *
 * Bug: the timeline editor's drag-trim writes `duration_override_ms`
 * with a 1-frame floor (~33ms at 30fps), but the renderer's override
 * branch used to require `>= minSceneMs` (default 2000ms) — so any
 * user trim below 2 seconds was silently dropped and the preview
 * stayed on the original natural duration. The fix is to honor every
 * positive override; the auto-pipeline floor only applies to natural
 * timecode-derived durations.
 *
 * See conversation 2026-06-06 (timeline-editor preview not reflecting
 * drag-trim edits).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_SCENE_MS,
  productionDocToVideoConfig,
  type ProductionDoc,
  type ProductionRow,
} from '@/remotion/utils';

function row(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '0:00',
    script_text: 'hello',
    visual_type: 'ai_image',
    visual_description: 'desc',
    stock_search_terms: '',
    ai_image_prompt: 'prompt',
    on_screen_text: '',
    notes: '',
    ...overrides,
  } as ProductionRow;
}

function makeDoc(rows: ProductionRow[]): ProductionDoc {
  return {
    title: 'Trim test',
    niche: 'test',
    total_duration: '0:30',
    total_words: 60,
    speaking_pace_wpm: 120,
    rows,
  } as ProductionDoc;
}

describe('productionDocToVideoConfig — duration_override_ms respect', () => {
  it('honors duration_override_ms below DEFAULT_MIN_SCENE_MS (timeline trim below 2s)', () => {
    const tinyOverride = 500;
    expect(tinyOverride).toBeLessThan(DEFAULT_MIN_SCENE_MS);
    const doc = makeDoc([
      row({ timecode: '0:00', duration_override_ms: tinyOverride }),
      row({ timecode: '0:05' }),
    ]);
    const config = productionDocToVideoConfig(doc, [null, null]);
    expect(config.shots[0].durationMs).toBe(tinyOverride);
  });

  it('cascades subsequent shots when an early override is below the floor', () => {
    const doc = makeDoc([
      row({ timecode: '0:00', duration_override_ms: 1000 }),
      row({ timecode: '0:05' }),
    ]);
    const config = productionDocToVideoConfig(doc, [null, null]);
    expect(config.shots[0].startMs).toBe(0);
    expect(config.shots[0].durationMs).toBe(1000);
    // Row 1 must butt up against row 0's new end, not its original 5s slot.
    expect(config.shots[1].startMs).toBe(1000);
  });

  it('still falls back to natural cascade duration when no override is set', () => {
    const doc = makeDoc([
      row({ timecode: '0:00' }),
      row({ timecode: '0:05' }),
    ]);
    const config = productionDocToVideoConfig(doc, [null, null]);
    // Row 0 spans 0:00 → 0:05 = 5000ms (next timecode minus this one).
    expect(config.shots[0].durationMs).toBe(5000);
  });

  it('honors an override larger than minSceneMs (already worked, regression guard)', () => {
    const doc = makeDoc([
      row({ timecode: '0:00', duration_override_ms: 7500 }),
      row({ timecode: '0:05' }),
    ]);
    const config = productionDocToVideoConfig(doc, [null, null]);
    expect(config.shots[0].durationMs).toBe(7500);
    expect(config.shots[1].startMs).toBe(7500);
  });

  it('clamps a zero or negative override to natural duration (defensive against bad legacy saves)', () => {
    const docZero = makeDoc([
      row({ timecode: '0:00', duration_override_ms: 0 }),
      row({ timecode: '0:05' }),
    ]);
    expect(productionDocToVideoConfig(docZero, [null, null]).shots[0].durationMs).toBe(5000);
    const docNeg = makeDoc([
      row({ timecode: '0:00', duration_override_ms: -100 }),
      row({ timecode: '0:05' }),
    ]);
    expect(productionDocToVideoConfig(docNeg, [null, null]).shots[0].durationMs).toBe(5000);
  });

  it('clamps a sub-1-frame override to at least one frame (Remotion 0-frame Sequence is invalid)', () => {
    const doc = makeDoc([
      row({ timecode: '0:00', duration_override_ms: 5 }), // 5ms; 30fps = ~33ms per frame
      row({ timecode: '0:05' }),
    ]);
    const oneFrameMs = 1000 / 30;
    expect(productionDocToVideoConfig(doc, [null, null]).shots[0].durationMs).toBeGreaterThanOrEqual(oneFrameMs);
  });
});
