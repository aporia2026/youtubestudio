import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CANVAS_REVEAL_FADE_IN_MS,
  isRevealLayerRenderable,
  resolveRevealWindow,
  revealLayerOpacityAt,
  type CanvasRevealLayerInput,
} from '@/remotion/canvas-reveal-math';
import {
  buildCanvasRevealEditPrompt,
  planCanvasRevealWork,
} from '@/lib/auto-pipeline/stages/generate-zenn-v1-images';

// ─── resolveRevealWindow ────────────────────────────────────────────
//
// The window resolver is the bridge between the LLM's ms-based
// timing and Remotion's frame-based Sequence positioning. A bug here
// either drops a layer (durationFrames === 0), holds it forever
// (durationFrames overflows the shot), or ramps it to never-visible
// (fadeFrames longer than durationFrames). Pinning every branch.

describe('resolveRevealWindow — basic mapping', () => {
  it('maps reveal_at_ms to the right frame at 24 fps', () => {
    const { fromFrame } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 1000 },
      10_000,
      24,
    );
    expect(fromFrame).toBe(24);
  });

  it('maps duration_ms to the right frame count at 24 fps', () => {
    const { durationFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 0, duration_ms: 2000 },
      10_000,
      24,
    );
    expect(durationFrames).toBe(48);
  });

  it('rounds to the nearest whole frame', () => {
    // 333 ms at 24 fps = 7.992 frames → rounds to 8.
    const { fromFrame } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 333 },
      10_000,
      24,
    );
    expect(fromFrame).toBe(8);
  });

  it('extends duration to end-of-shot when duration_ms is absent', () => {
    // Shot is 6000 ms; layer reveals at 2000 ms; absent duration_ms
    // should be treated as "visible until end of shot" = 4000 ms.
    const { durationFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 2000 },
      6000,
      24,
    );
    expect(durationFrames).toBe(96); // 4000 ms × 24 / 1000
  });

  it('defaults fade_in_ms to DEFAULT_CANVAS_REVEAL_FADE_IN_MS when absent', () => {
    expect(DEFAULT_CANVAS_REVEAL_FADE_IN_MS).toBe(250);
    const { fadeFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 0, duration_ms: 2000 },
      10_000,
      24,
    );
    expect(fadeFrames).toBe(6); // 250 ms × 24 / 1000
  });
});

describe('resolveRevealWindow — clamping + defense in depth', () => {
  it('clamps reveal_at_ms to the shot duration', () => {
    const { fromFrame, durationFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 99_999 },
      6000,
      24,
    );
    expect(fromFrame).toBe(24 * 6); // clamped to shot end
    expect(durationFrames).toBe(0); // no room left to display
  });

  it('clamps duration_ms to the remaining shot duration', () => {
    // 6000 ms shot, layer reveals at 4000 ms, asks for 5000 ms.
    // Only 2000 ms remain → duration clamped to 2000 ms = 48 frames.
    const { durationFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 4000, duration_ms: 5000 },
      6000,
      24,
    );
    expect(durationFrames).toBe(48);
  });

  it('clamps fade_in_ms to durationFrames when fade exceeds the layer life', () => {
    // 100 ms layer wants a 500 ms fade. 100 ms = 2 frames at 24 fps;
    // 500 ms = 12 frames. Without the cap the layer would render at
    // < 20 % opacity for its entire 2-frame existence.
    const { durationFrames, fadeFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 0, duration_ms: 100, fade_in_ms: 500 },
      10_000,
      24,
    );
    expect(durationFrames).toBe(2);
    expect(fadeFrames).toBe(2);
  });

  it('treats negative reveal_at_ms as 0', () => {
    const { fromFrame } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: -1000 },
      6000,
      24,
    );
    expect(fromFrame).toBe(0);
  });

  it('treats NaN duration_ms as absent (extends to end of shot)', () => {
    const { durationFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 0, duration_ms: Number.NaN },
      6000,
      24,
    );
    expect(durationFrames).toBe(144); // 6000 ms × 24 / 1000
  });

  it('treats NaN fade_in_ms as default (250 ms)', () => {
    const { fadeFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 0, duration_ms: 2000, fade_in_ms: Number.NaN },
      10_000,
      24,
    );
    expect(fadeFrames).toBe(6);
  });

  it('handles fps = 30 (alt project fps) correctly', () => {
    const { fromFrame, durationFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 1000, duration_ms: 2000 },
      6000,
      30,
    );
    expect(fromFrame).toBe(30);
    expect(durationFrames).toBe(60);
  });
});

describe('resolveRevealWindow — canvas_layer_add semantics', () => {
  it('fade_in_ms = 0 yields fadeFrames = 0 (instant appear)', () => {
    const { fadeFrames } = resolveRevealWindow(
      { image_url: 'x', reveal_at_ms: 0, duration_ms: 2000, fade_in_ms: 0 },
      10_000,
      24,
    );
    expect(fadeFrames).toBe(0);
  });
});

// ─── revealLayerOpacityAt ───────────────────────────────────────────

describe('revealLayerOpacityAt', () => {
  it('ramps linearly from 0 to 1 over fadeFrames', () => {
    expect(revealLayerOpacityAt(0, 10)).toBe(0);
    expect(revealLayerOpacityAt(5, 10)).toBe(0.5);
    expect(revealLayerOpacityAt(10, 10)).toBe(1);
  });

  it('holds at 1 after fadeFrames', () => {
    expect(revealLayerOpacityAt(50, 10)).toBe(1);
    expect(revealLayerOpacityAt(9999, 10)).toBe(1);
  });

  it('returns 1 immediately when fadeFrames is 0 (canvas_layer_add)', () => {
    expect(revealLayerOpacityAt(0, 0)).toBe(1);
    expect(revealLayerOpacityAt(5, 0)).toBe(1);
  });

  it('returns 1 immediately when fadeFrames is negative (defense)', () => {
    expect(revealLayerOpacityAt(0, -1)).toBe(1);
  });

  it('returns 0 when localFrame is negative (sequence not yet active)', () => {
    expect(revealLayerOpacityAt(-1, 10)).toBe(0);
  });

  it('handles NaN inputs without producing NaN output', () => {
    expect(revealLayerOpacityAt(Number.NaN, 10)).toBe(0);
    expect(revealLayerOpacityAt(5, Number.NaN)).toBe(1);
  });
});

// ─── isRevealLayerRenderable ────────────────────────────────────────

describe('isRevealLayerRenderable', () => {
  it('returns true when image_url is set', () => {
    expect(
      isRevealLayerRenderable({
        image_url: 'https://r2.example/layer.jpg',
        reveal_at_ms: 0,
      }),
    ).toBe(true);
  });

  it('returns false when image_url is missing', () => {
    expect(isRevealLayerRenderable({ reveal_at_ms: 0 })).toBe(false);
  });

  it('returns false when image_url is empty / whitespace', () => {
    expect(isRevealLayerRenderable({ image_url: '', reveal_at_ms: 0 })).toBe(false);
    expect(isRevealLayerRenderable({ image_url: '   ', reveal_at_ms: 0 })).toBe(false);
  });

  it('returns false for null / undefined input', () => {
    expect(isRevealLayerRenderable(undefined)).toBe(false);
    expect(isRevealLayerRenderable(null)).toBe(false);
  });

  it('returns false for a layer with only a prompt_hint (pending generation)', () => {
    expect(
      isRevealLayerRenderable({
        prompt_hint: 'draw the mouse #5 entering',
        reveal_at_ms: 0,
      }),
    ).toBe(false);
  });
});

// ─── buildCanvasRevealEditPrompt ────────────────────────────────────

describe('buildCanvasRevealEditPrompt', () => {
  it('embeds the hint verbatim', () => {
    const prompt = buildCanvasRevealEditPrompt('add a small mouse on the right side');
    expect(prompt).toContain('add a small mouse on the right side');
  });

  it('instructs the model to PRESERVE existing elements (the load-bearing semantics)', () => {
    // The whole point of canvas_reveal is "add WITHOUT changing the
    // existing scene". If the prompt loses this instruction, the
    // model paints from scratch and the beat is broken.
    const prompt = buildCanvasRevealEditPrompt('add a label');
    expect(prompt.toLowerCase()).toContain('exactly identical');
    expect(prompt.toLowerCase()).toContain('do not move');
  });

  it('trims leading and trailing whitespace from the hint', () => {
    const prompt = buildCanvasRevealEditPrompt('   add a mouse   ');
    expect(prompt).toContain('add a mouse');
    expect(prompt).not.toContain('   add a mouse   ');
  });
});

// ─── planCanvasRevealWork ───────────────────────────────────────────
//
// The planner picks which layer entries need work this tick. Bugs
// here either re-generate already-done layers (cost burn) or skip
// layers that need work (incomplete render). Pinning every branch.

interface PlanTestRow {
  image_url?: string;
  zenn_canvas_reveal_layers?: CanvasRevealLayerInput[];
}

const docWithRows = (rows: PlanTestRow[]) => ({ rows });

describe('planCanvasRevealWork', () => {
  it('returns an empty plan for an empty doc', () => {
    expect(planCanvasRevealWork(docWithRows([]) as never)).toEqual([]);
  });

  it('returns one work item per unfilled layer with a prompt hint', () => {
    const plan = planCanvasRevealWork(
      docWithRows([
        {
          image_url: 'https://r2.example/row0.jpg',
          zenn_canvas_reveal_layers: [
            { prompt_hint: 'add mouse', reveal_at_ms: 1000 },
            { prompt_hint: 'add second mouse', reveal_at_ms: 2000 },
          ],
        },
      ]) as never,
    );
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({
      rowIndex: 0,
      layerIndex: 0,
      promptHint: 'add mouse',
      baseImageUrl: 'https://r2.example/row0.jpg',
    });
    expect(plan[1].layerIndex).toBe(1);
  });

  it('skips layers that already have an image_url (idempotent)', () => {
    const plan = planCanvasRevealWork(
      docWithRows([
        {
          image_url: 'https://r2.example/row0.jpg',
          zenn_canvas_reveal_layers: [
            {
              prompt_hint: 'add mouse',
              image_url: 'https://r2.example/layer-cached.jpg',
              reveal_at_ms: 1000,
            },
            { prompt_hint: 'add second mouse', reveal_at_ms: 2000 },
          ],
        },
      ]) as never,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].layerIndex).toBe(1);
  });

  it("skips rows whose image_url isn't set yet (base must exist first)", () => {
    // Defense in depth: canvas_reveal edits a base image. If the
    // base hasn't been generated by the prior stage, skipping the
    // canvas_reveal work and waiting for the next tick is the right
    // call. Without this, the dispatcher would throw on empty
    // sourceImageUrl and the layer would be marked failed instead
    // of pending.
    const plan = planCanvasRevealWork(
      docWithRows([
        {
          image_url: '',
          zenn_canvas_reveal_layers: [
            { prompt_hint: 'add mouse', reveal_at_ms: 1000 },
          ],
        },
        {
          image_url: 'https://r2.example/row1.jpg',
          zenn_canvas_reveal_layers: [
            { prompt_hint: 'add label', reveal_at_ms: 1000 },
          ],
        },
      ]) as never,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].rowIndex).toBe(1);
  });

  it('skips layers with empty / missing prompt_hint', () => {
    const plan = planCanvasRevealWork(
      docWithRows([
        {
          image_url: 'https://r2.example/row0.jpg',
          zenn_canvas_reveal_layers: [
            { reveal_at_ms: 1000 } as never,
            { prompt_hint: '', reveal_at_ms: 1500 },
            { prompt_hint: '   ', reveal_at_ms: 2000 },
            { prompt_hint: 'real hint', reveal_at_ms: 2500 },
          ],
        },
      ]) as never,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].promptHint).toBe('real hint');
  });

  it('walks rows row-major (row 0 layers, then row 1 layers, ...)', () => {
    // Determinism on re-tick: the deterministic prefix is what
    // makes the per-tick cap useful. If the order shuffled, the
    // same N layers wouldn't be generated each tick.
    const plan = planCanvasRevealWork(
      docWithRows([
        {
          image_url: 'https://r2.example/row0.jpg',
          zenn_canvas_reveal_layers: [
            { prompt_hint: 'r0-layer-0', reveal_at_ms: 0 },
            { prompt_hint: 'r0-layer-1', reveal_at_ms: 1000 },
          ],
        },
        {
          image_url: 'https://r2.example/row1.jpg',
          zenn_canvas_reveal_layers: [
            { prompt_hint: 'r1-layer-0', reveal_at_ms: 0 },
          ],
        },
      ]) as never,
    );
    expect(plan.map((w) => w.promptHint)).toEqual([
      'r0-layer-0',
      'r0-layer-1',
      'r1-layer-0',
    ]);
  });

  it('handles rows with no zenn_canvas_reveal_layers field', () => {
    const plan = planCanvasRevealWork(
      docWithRows([
        { image_url: 'https://r2.example/row0.jpg' },
        {
          image_url: 'https://r2.example/row1.jpg',
          zenn_canvas_reveal_layers: [{ prompt_hint: 'add', reveal_at_ms: 0 }],
        },
      ]) as never,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].rowIndex).toBe(1);
  });
});
