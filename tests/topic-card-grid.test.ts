import { describe, expect, it } from 'vitest';
import {
  circleCellGeometry,
  computeCircleRegions,
  computeRegions,
  computeRegionsFor,
  DEFAULT_CANVAS,
  makeDefaultLayout,
  topicCardGridImagePrompt,
  topicCardGridLlmPrompt,
} from '@/lib/thumbnail-formats/topic-card-grid';

function mkSequentialId(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe('makeDefaultLayout', () => {
  it('defaults cardShape to square when omitted', () => {
    const layout = makeDefaultLayout(3, 3);
    expect(layout.cardShape).toBe('square');
    expect(layout.width).toBe(DEFAULT_CANVAS.width);
    expect(layout.height).toBe(DEFAULT_CANVAS.height);
  });
  it('threads cardShape when explicitly passed', () => {
    const layout = makeDefaultLayout(3, 3, 1280, 720, 'circle');
    expect(layout.cardShape).toBe('circle');
  });
});

describe('computeRegions (square)', () => {
  it('returns exactly rows*cols regions in reading order', () => {
    const layout = makeDefaultLayout(2, 3);
    const regions = computeRegions(layout, ['a', 'b', 'c', 'd', 'e', 'f'], mkSequentialId());
    expect(regions).toHaveLength(6);
    expect(regions.map((r) => r.label)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // First region top-left = outer margin
    expect(regions[0].x).toBe(layout.outerMargin);
    expect(regions[0].y).toBe(layout.outerMargin);
  });
});

describe('circleCellGeometry', () => {
  it('positions the disc in the top portion of the cell', () => {
    const geom = circleCellGeometry(0, 0, 400, 300);
    // Disc diameter capped by 70% of the smaller dimension (height here):
    // 300 * 0.7 = 210
    expect(geom.discD).toBeCloseTo(210, 1);
    // Disc centred horizontally
    expect(geom.discCx).toBe(200);
    // Label band sits below the disc, occupying the remainder of the cell
    expect(geom.labelY).toBeGreaterThan(geom.discCy);
    expect(Math.round(geom.labelY + geom.labelH)).toBe(300);
  });
  it('caps disc by width when the cell is wider than tall', () => {
    // Square cell — disc should be capped at min(W*0.9, H*0.7) = H*0.7 here
    const geom = circleCellGeometry(0, 0, 200, 200);
    expect(geom.discD).toBeCloseTo(140, 1); // 200 * 0.7
  });
  it('caps disc by width when the cell is much wider', () => {
    // Very wide cell — disc should hit the width cap (W*0.9 < H*0.7)
    const geom = circleCellGeometry(0, 0, 100, 300);
    expect(geom.discD).toBeCloseTo(90, 1); // 100 * 0.9
  });
});

describe('computeCircleRegions', () => {
  it('returns the disc bounding box per cell, not the full cell rect', () => {
    const layout = makeDefaultLayout(2, 2, 1280, 720, 'circle');
    const cardW = (layout.width - 2 * layout.outerMargin - layout.gutter) / 2;
    const regions = computeCircleRegions(layout, ['a', 'b', 'c', 'd'], mkSequentialId());
    expect(regions).toHaveLength(4);
    // Disc width should be less than the full cell width (because the disc
    // is capped at min(W*0.9, H*0.7) which is smaller than cardW).
    expect(regions[0].w).toBeLessThan(Math.round(cardW));
    expect(regions[0].h).toBe(regions[0].w); // disc is square
    // First disc x > outer margin (disc is centred within the cell)
    expect(regions[0].x).toBeGreaterThan(layout.outerMargin);
  });
});

describe('computeRegionsFor (dispatcher)', () => {
  it('uses square math by default', () => {
    const layout = makeDefaultLayout(2, 2);
    const sq = computeRegions(layout, ['a', 'b', 'c', 'd'], mkSequentialId());
    const via = computeRegionsFor(layout, ['a', 'b', 'c', 'd'], mkSequentialId());
    expect(via.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })))
      .toEqual(sq.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })));
  });
  it('uses circle math when layout.cardShape === circle', () => {
    const layout = makeDefaultLayout(2, 2, 1280, 720, 'circle');
    const sq = computeRegions(layout, ['a', 'b', 'c', 'd'], mkSequentialId());
    const via = computeRegionsFor(layout, ['a', 'b', 'c', 'd'], mkSequentialId());
    // Circle regions are smaller (disc bounding box) than the full cell rect.
    expect(via[0].w).toBeLessThan(sq[0].w);
  });
  it('explicit shape argument overrides layout.cardShape', () => {
    const layout = makeDefaultLayout(2, 2, 1280, 720, 'square');
    const via = computeRegionsFor(layout, ['a', 'b', 'c', 'd'], mkSequentialId(), 'circle');
    const sq = computeRegions(layout, ['a', 'b', 'c', 'd'], mkSequentialId());
    expect(via[0].w).toBeLessThan(sq[0].w);
  });
});

describe('topicCardGridLlmPrompt', () => {
  const baseInput = {
    title: 'Top 5 Coffee Brewers',
    niche: 'home-coffee',
    gridRows: 2,
    gridCols: 2,
  };
  it('omits the circle guidance for square mode', () => {
    const { user } = topicCardGridLlmPrompt({ ...baseInput, cardShape: 'square' });
    expect(user).not.toMatch(/Card shape.+circle/i);
    expect(user).not.toMatch(/CLIPPED by the circular mask/);
  });
  it('adds circle-specific guidance for circle mode', () => {
    const { user } = topicCardGridLlmPrompt({ ...baseInput, cardShape: 'circle' });
    expect(user).toMatch(/Card shape.+circle/);
    expect(user).toMatch(/CLIPPED by the circular mask/);
  });
  it('lists uploaded cells with the USER_UPLOADED_IMAGE sentinel guidance', () => {
    const { user } = topicCardGridLlmPrompt({ ...baseInput, uploadedCellIndexes: [2, 4] });
    expect(user).toMatch(/USER_UPLOADED_IMAGE/);
    expect(user).toMatch(/Card 2/);
    expect(user).toMatch(/Card 4/);
    expect(user).not.toMatch(/Card 3/);
  });
  it('dedups and clamps out-of-range uploaded cells', () => {
    const { user } = topicCardGridLlmPrompt({
      ...baseInput,
      uploadedCellIndexes: [1, 1, 2, 0, 99, -1, 3.5 as unknown as number],
    });
    expect(user).toMatch(/Card 1/);
    expect(user).toMatch(/Card 2/);
    // 0, 99, -1, 3.5 dropped (out of range / not integer)
    expect(user).not.toMatch(/Card 0/);
    expect(user).not.toMatch(/Card 99/);
    // Card 1 should appear once even though it's listed twice in input.
    const card1Matches = (user.match(/Card 1\b/g) ?? []).length;
    expect(card1Matches).toBe(1);
  });
  it('does not add the uploaded-cells block when the list is empty', () => {
    const { user } = topicCardGridLlmPrompt({ ...baseInput, uploadedCellIndexes: [] });
    expect(user).not.toMatch(/USER_UPLOADED_IMAGE/);
  });
});

describe('topicCardGridImagePrompt', () => {
  const baseCards = [
    { index: 1, label: 'Coffee', icon_concept: 'a coffee cup' },
    { index: 2, label: 'Pizza', icon_concept: 'a pizza slice' },
    { index: 3, label: 'Camera', icon_concept: 'a camera' },
    { index: 4, label: 'Guitar', icon_concept: 'an acoustic guitar' },
  ];
  const baseInput = {
    cards: baseCards,
    palette: { background: '#000', primary_accent: 'inherit', secondary_accent: 'inherit' },
    gridRows: 2,
    gridCols: 2,
  };

  it('square mode emits the rectangle-with-strip layout', () => {
    const prompt = topicCardGridImagePrompt({ ...baseInput, cardShape: 'square' });
    expect(prompt).toMatch(/2-3 px solid black border/);
    expect(prompt).toMatch(/white horizontal strip/);
    // No discs
    expect(prompt).not.toMatch(/grid of \d+ discs/);
  });

  it('circle mode emits the discs-on-canvas layout and label-below rules', () => {
    const prompt = topicCardGridImagePrompt({ ...baseInput, cardShape: 'circle' });
    expect(prompt).toMatch(/grid of 4 discs/);
    expect(prompt).toMatch(/NO rectangular borders around the cells/);
    expect(prompt).toMatch(/Each label sits in the white canvas BELOW its disc/);
  });

  it('renders uploaded cells as 100% blank — no label, no illustration, no concept', () => {
    const prompt = topicCardGridImagePrompt({
      ...baseInput,
      uploadedCellIndexes: [2],
    });
    // Cell 2 line should reference NEITHER the label ("Pizza") NOR the
    // icon_concept ("pizza slice") — both are deliberately dropped so
    // the AI has nothing to render in that cell. The composite paints
    // the user's image AND the label deterministically afterwards;
    // anything the AI draws here can only leak through the composite
    // edges as a doubled artefact.
    const cell2Line = prompt.split('\n').find((l) => l.startsWith('2.'));
    expect(cell2Line).toBeDefined();
    expect(cell2Line).toMatch(/PURE WHITE CELL/);
    expect(cell2Line).not.toMatch(/pizza/i);
    expect(cell2Line).not.toMatch(/Pizza/);
    // Cell 1 unchanged
    const cell1Line = prompt.split('\n').find((l) => l.startsWith('1.'));
    expect(cell1Line).toMatch(/a coffee cup/);
    expect(cell1Line).toMatch(/Coffee/);
  });

  it('lists uploaded cells in the ABSOLUTE REQUIREMENTS section', () => {
    const prompt = topicCardGridImagePrompt({
      ...baseInput,
      uploadedCellIndexes: [1, 3],
    });
    expect(prompt).toMatch(/USER-RESERVED.+1, 3/);
  });

  it('omits the USER-RESERVED block when no cells are uploaded', () => {
    const prompt = topicCardGridImagePrompt(baseInput);
    expect(prompt).not.toMatch(/USER-RESERVED/);
  });
});
