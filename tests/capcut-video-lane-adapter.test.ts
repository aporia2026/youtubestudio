/**
 * Tests for the pure logic inside `CapCutVideoLane.tsx`. The component
 * itself is a thin event adapter on top of `@xzdarcy/react-timeline-editor`
 * (covered by manual QA on /edit/[projectId]); the only unit-testable
 * piece is `targetIndexFromShotsDropMs`, which maps a drag-drop position
 * to the post-removal insertion index used by the legacy editor's
 * `REORDER_SHOTS` command.
 *
 * Plan: `_plans/2026-06-06-capcut-video-lane-in-timelinev2.md`.
 */

import { describe, expect, it } from 'vitest';
import type { VideoShot } from '@/remotion/types';
import { targetIndexFromShotsDropMs } from '@/components/editor/timeline-v2/CapCutVideoLane';

function shot(startMs: number, durationMs: number): VideoShot {
  return {
    startMs,
    durationMs,
    sceneType: 'b-roll',
  } as VideoShot;
}

describe('targetIndexFromShotsDropMs', () => {
  const shots = [
    shot(0, 4000),     // 0–4s
    shot(4000, 5000),  // 4–9s
    shot(9000, 3000),  // 9–12s
    shot(12000, 6000), // 12–18s
  ];

  it('returns 0 when dropped at the very start (before shot 0)', () => {
    expect(targetIndexFromShotsDropMs(shots, 2, 0)).toBe(0);
  });

  it('returns the last slot index when dropped past the last shot', () => {
    // Dragging shot[2] (the 9-12s one) to past the end. The
    // "without-dragged" total is 4 + 5 + 6 = 15s; the rightmost
    // seam is at 15s. Drop at 30s snaps to that seam.
    expect(targetIndexFromShotsDropMs(shots, 2, 30_000)).toBe(3);
  });

  it('snaps to the nearest seam between two existing shots', () => {
    // Drag shot[3] (the 12-18s tail) to land just after shot[0]:
    // without-dragged seams are [0, 4000, 9000, 12000]. Drop at 4100ms
    // is closest to seam index 1 (= insert after shot[0]).
    expect(targetIndexFromShotsDropMs(shots, 3, 4100)).toBe(1);
  });

  it('tie-breaks left when the drop lands exactly between two seams', () => {
    // Without dragging shot[1], seams are [0, 4000, 7000, 13000]
    // (shot[1]'s 5000ms is removed from the cumulative walk).
    // Drop at the midpoint between 4000 and 7000 = 5500. Distance is
    // equal to both; tie-break picks the LEFT (lower index = 1).
    expect(targetIndexFromShotsDropMs(shots, 1, 5500)).toBe(1);
  });

  it('returns fromIndex unchanged when fromIndex is out of range', () => {
    expect(targetIndexFromShotsDropMs(shots, -1, 5000)).toBe(-1);
    expect(targetIndexFromShotsDropMs(shots, 99, 5000)).toBe(99);
  });

  it('returns 0 when there is only one shot (no other seams exist)', () => {
    const single = [shot(0, 5000)];
    expect(targetIndexFromShotsDropMs(single, 0, 9999)).toBe(0);
  });

  it('reuses durations of remaining shots regardless of their absolute startMs', () => {
    // Same durations, but the shots' startMs are non-cumulative (e.g.
    // after alignment shifted them). The function should sum DURATIONS,
    // not read startMs. Build a fixture where startMs is wrong.
    const garbled = [
      shot(100, 4000),
      shot(99_000, 5000), // bogus startMs — irrelevant to the math
      shot(7, 3000),
    ];
    // Without dragged shot[1]: durations are [4000, 3000]; seams [0, 4000, 7000].
    expect(targetIndexFromShotsDropMs(garbled, 1, 3900)).toBe(1);
    expect(targetIndexFromShotsDropMs(garbled, 1, 6500)).toBe(2);
  });
});
