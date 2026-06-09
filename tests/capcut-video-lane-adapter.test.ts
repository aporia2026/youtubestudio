/**
 * Tests for the pure logic inside `CapCutVideoLane.tsx`. The component
 * itself is a thin event adapter on top of `@xzdarcy/react-timeline-editor`
 * (covered by manual QA on /edit/[projectId]); the unit-testable
 * pieces are:
 *   - `targetIndexFromShotsDropMs` — maps a drag-drop position to the
 *     post-removal insertion index used by the legacy editor's
 *     `REORDER_SHOTS` command.
 *   - `buildEditorDataSignature` — the content hash that gates the
 *     `editorData` cache. Critical for crash-loop avoidance: the
 *     signature MUST change when any timeline-visible field moves
 *     and MUST stay stable across image-transform field changes
 *     (which TransformOverlay dispatches ~60×/sec during a corner
 *     drag). See `_plans/2026-06-08-editor-crash-recovery.md`.
 *
 * Plan: `_plans/2026-06-06-capcut-video-lane-in-timelinev2.md`.
 */

import { describe, expect, it } from 'vitest';
import type { VideoShot } from '@/remotion/types';
import {
  buildEditorDataSignature,
  targetIndexFromShotsDropMs,
} from '@/components/editor/timeline-v2/CapCutVideoLane';

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

describe('buildEditorDataSignature', () => {
  // Baseline fixture — three shots with mixed kinds, full image / trim
  // / transition coverage. Tests below mutate one slice at a time so a
  // failure pinpoints which slice the signature is over- or under-
  // sensitive to.
  const baseShots: VideoShot[] = [
    {
      startMs: 0,
      durationMs: 4000,
      sceneType: 'icon-scene',
      shotKind: 'static',
      visualType: 'title-card',
    } as VideoShot,
    {
      startMs: 4000,
      durationMs: 5000,
      sceneType: 'b-roll',
      shotKind: 'motion',
      visualType: 'b-roll',
      videoUrl: 'https://example.com/clip.mp4',
    } as VideoShot,
    {
      startMs: 9000,
      durationMs: 3000,
      sceneType: 'b-roll',
      shotKind: 'static',
      visualType: 'animation',
    } as VideoShot,
  ];
  const baseImages = { 0: 'https://example.com/0.jpg', 1: 'https://example.com/1.jpg', 2: 'https://example.com/2.jpg' };
  const baseTransitions = { 0: 'cross-fade' as const, 1: null, 2: undefined };
  const baseTrims = { 1: { trimStartMs: 250, trimEndMs: 500 } };

  it('returns equal signatures when nothing structural changed', () => {
    // Re-construct the inputs from fresh references; the signature
    // must stay equal — that's the invariant the editorData cache
    // relies on to avoid the forceUpdate cascade.
    const a = buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims);
    const b = buildEditorDataSignature(
      [...baseShots],
      { ...baseImages },
      { ...baseTransitions },
      { ...baseTrims },
    );
    expect(a).toBe(b);
  });

  it('IGNORES image-transform fields on the shot (the whole point of the cache)', () => {
    // This is the load-bearing case. TransformOverlay's pointermove
    // dispatches transient PATCH_ROW with fresh imageXPct / imageYPct
    // / imageScalePct / imageRotationDeg every frame. If the signature
    // notices them, the editorData rebuilds 60×/sec and the React
    // error #185 loop returns. The signature MUST NOT change.
    const transformed: VideoShot[] = baseShots.map((s, i) => ({
      ...s,
      imageXPct: 10 + i,
      imageYPct: -5 + i,
      imageScalePct: 120 + i,
      imageRotationDeg: 3 + i,
    } as VideoShot));
    expect(
      buildEditorDataSignature(transformed, baseImages, baseTransitions, baseTrims),
    ).toBe(buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims));
  });

  it('changes when a shot is added', () => {
    const longer = [...baseShots, shot(12_000, 6000)];
    expect(buildEditorDataSignature(longer, baseImages, baseTransitions, baseTrims)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
  });

  it('changes when a shot is removed', () => {
    const shorter = baseShots.slice(0, 2);
    expect(buildEditorDataSignature(shorter, baseImages, baseTransitions, baseTrims)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
  });

  it('changes when a shot duration changes (timeline-resize)', () => {
    const resized: VideoShot[] = baseShots.map((s, i) => (i === 1 ? { ...s, durationMs: 6500 } as VideoShot : s));
    expect(buildEditorDataSignature(resized, baseImages, baseTransitions, baseTrims)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
  });

  it('changes when a shot startMs shifts (alignment retime)', () => {
    const shifted: VideoShot[] = baseShots.map((s, i) =>
      i === 2 ? ({ ...s, startMs: 9500 } as VideoShot) : s,
    );
    expect(buildEditorDataSignature(shifted, baseImages, baseTransitions, baseTrims)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
  });

  it('changes when a shot kind or visual type changes (badge update)', () => {
    const newKind: VideoShot[] = baseShots.map((s, i) =>
      i === 0 ? ({ ...s, shotKind: 'motion_collage' } as VideoShot) : s,
    );
    expect(buildEditorDataSignature(newKind, baseImages, baseTransitions, baseTrims)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
    const newVisual: VideoShot[] = baseShots.map((s, i) =>
      i === 0 ? ({ ...s, visualType: 'stats' } as VideoShot) : s,
    );
    expect(buildEditorDataSignature(newVisual, baseImages, baseTransitions, baseTrims)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
  });

  it('changes when a row image URL changes (thumbnail swap)', () => {
    const newImages = { ...baseImages, 1: 'https://example.com/1-new.jpg' };
    expect(buildEditorDataSignature(baseShots, newImages, baseTransitions, baseTrims)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
  });

  it('changes when a transition is added or cleared', () => {
    const flipped = { ...baseTransitions, 1: 'cross-fade' as const };
    expect(buildEditorDataSignature(baseShots, baseImages, flipped, baseTrims)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
  });

  it('changes when a trim value changes', () => {
    const shaved = { 1: { trimStartMs: 250, trimEndMs: 800 } };
    expect(buildEditorDataSignature(baseShots, baseImages, baseTransitions, shaved)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
  });

  it('changes when videoUrl flips on / off (hasBroll toggle)', () => {
    // hasBroll = Boolean(videoUrl) || sceneType === 'b-roll'. Toggle
    // videoUrl on a non-b-roll shot to flip hasBroll without changing
    // sceneType.
    const animated: VideoShot[] = baseShots.map((s, i) =>
      i === 0 ? ({ ...s, videoUrl: 'https://example.com/0-clip.mp4' } as VideoShot) : s,
    );
    expect(buildEditorDataSignature(animated, baseImages, baseTransitions, baseTrims)).not.toBe(
      buildEditorDataSignature(baseShots, baseImages, baseTransitions, baseTrims),
    );
  });

  it('treats undefined and empty-object trim/transition maps equivalently', () => {
    // Defensive: callers may pass undefined when there are no trims /
    // transitions yet on a fresh doc. The signature should match an
    // explicit empty object so a no-op patch doesn't tear down the
    // cache.
    expect(buildEditorDataSignature(baseShots, baseImages, undefined, undefined)).toBe(
      buildEditorDataSignature(baseShots, baseImages, {}, {}),
    );
  });

  it('treats a missing image entry as the empty string (sparse rowImages)', () => {
    // rowImages is keyed by row index and may be sparse for rows that
    // haven't generated their image yet. The signature MUST still be
    // stable across re-renders of the same sparse state.
    const sparse = { 0: 'https://example.com/0.jpg' };
    const a = buildEditorDataSignature(baseShots, sparse, baseTransitions, baseTrims);
    const b = buildEditorDataSignature(baseShots, { ...sparse }, baseTransitions, baseTrims);
    expect(a).toBe(b);
  });
});
