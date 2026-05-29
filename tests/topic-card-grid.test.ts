import { describe, expect, it } from 'vitest';
import {
  circleCellGeometry,
  computeCircleRegions,
  computeRegions,
  computeRegionsFor,
  countWords,
  DEFAULT_CANVAS,
  ICON_CONCEPT_BANLIST,
  makeDefaultLayout,
  MAX_ICON_CONCEPT_CHARS,
  MAX_LABEL_CHARS,
  MAX_LABEL_WORDS,
  readsAsSafeColor,
  topicCardGridImagePrompt,
  topicCardGridLlmPrompt,
  validateCardList,
  type TopicCard,
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

// ─── Validation helpers ─────────────────────────────────────────────────────

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('Fake Virus Warnings')).toBe(3);
    expect(countWords('Phishing')).toBe(1);
    expect(countWords('  leading and  trailing  ')).toBe(3);
  });
  it('treats hyphenated tokens as one word (visual line cost)', () => {
    expect(countWords('Anti-Virus Tips')).toBe(2);
    expect(countWords('Real-Time Scanning')).toBe(2);
  });
  it('returns 0 for empty / whitespace-only input', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
});

describe('readsAsSafeColor', () => {
  it('flags pure greens and Material-palette greens', () => {
    expect(readsAsSafeColor('#00ff00')).toBe(true);
    expect(readsAsSafeColor('#4CAF50')).toBe(true);
    expect(readsAsSafeColor('#388e3c')).toBe(true);
  });
  it('flags pure / Material blues', () => {
    expect(readsAsSafeColor('#2196f3')).toBe(true);
    expect(readsAsSafeColor('#1976d2')).toBe(true);
  });
  it('does NOT flag warning colors (reds / oranges / yellows)', () => {
    expect(readsAsSafeColor('#ff0000')).toBe(false);
    expect(readsAsSafeColor('#ff6600')).toBe(false);
    expect(readsAsSafeColor('#ffd700')).toBe(false);
  });
  it('does NOT flag black, white, gray, magenta, purple', () => {
    expect(readsAsSafeColor('#000000')).toBe(false);
    expect(readsAsSafeColor('#ffffff')).toBe(false);
    expect(readsAsSafeColor('#808080')).toBe(false);
    expect(readsAsSafeColor('#ff00ff')).toBe(false);
    expect(readsAsSafeColor('#9c27b0')).toBe(false);
  });
  it('returns false for non-hex or missing input', () => {
    expect(readsAsSafeColor(undefined)).toBe(false);
    expect(readsAsSafeColor('')).toBe(false);
    expect(readsAsSafeColor('rgb(0,255,0)')).toBe(false);
    expect(readsAsSafeColor('green')).toBe(false);
  });
});

describe('validateCardList — caps & banlist (r2)', () => {
  const okCard = (i: number, label: string, icon: string, accent?: string): TopicCard => ({
    index: i,
    label,
    icon_concept: icon,
    accent_color: accent,
  });

  it('accepts a clean list within all caps', () => {
    const cards: TopicCard[] = [
      okCard(1, 'Fake Warnings', 'a giant red exclamation shield', '#ff0000'),
      okCard(2, 'Phishing', 'a fishing hook through an envelope', '#ff6600'),
    ];
    expect(validateCardList(cards, 2)).toEqual({ ok: true });
  });

  it('rejects a label that exceeds MAX_LABEL_CHARS', () => {
    const longLabel = 'A'.repeat(MAX_LABEL_CHARS + 1);
    const cards: TopicCard[] = [
      okCard(1, longLabel, 'a shield'),
      okCard(2, 'Ok', 'a shield'),
    ];
    const r = validateCardList(cards, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/too long/);
      expect(r.offending_card_index).toBe(0);
    }
  });

  it('rejects a label with more than MAX_LABEL_WORDS words', () => {
    // 4 short words (under char cap, over word cap)
    const cards: TopicCard[] = [
      okCard(1, 'a b c d', 'a shield'),
    ];
    const r = validateCardList(cards, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too many words/);
  });

  it('rejects the real failing label "400 Million Dollars Every Year"', () => {
    const cards: TopicCard[] = [
      okCard(1, '400 Million Dollars Every Year', 'a dollar sign with a red cross'),
    ];
    const r = validateCardList(cards, 1);
    expect(r.ok).toBe(false);
  });

  it('rejects an icon_concept exceeding MAX_ICON_CONCEPT_CHARS', () => {
    const longIcon = 'a '.repeat(MAX_ICON_CONCEPT_CHARS).slice(0, MAX_ICON_CONCEPT_CHARS + 5);
    const cards: TopicCard[] = [
      okCard(1, 'Ok', longIcon),
    ];
    const r = validateCardList(cards, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/icon_concept is too long/);
  });

  // Each banlist pattern gets a regression test — one for the exact GPT-4o
  // output that triggered the r2 work, one synthetic per pattern so a
  // future regex tweak can't silently disable a category.
  it('rejects the real failing browser-window mockup', () => {
    const cards: TopicCard[] = [
      okCard(1, 'Fake Virus', 'a browser window with a red warning overlay'),
    ];
    const r = validateCardList(cards, 1);
    expect(r.ok).toBe(false);
  });

  it('rejects the real failing email-inbox mockup', () => {
    const cards: TopicCard[] = [
      okCard(1, 'Phishing', 'an email inbox with a message from Microsoft'),
    ];
    const r = validateCardList(cards, 1);
    expect(r.ok).toBe(false);
  });

  it('rejects the real failing installer-wizard mockup', () => {
    const cards: TopicCard[] = [
      okCard(1, 'Bundled', 'an installer wizard with a checkbox'),
    ];
    const r = validateCardList(cards, 1);
    expect(r.ok).toBe(false);
  });

  it('rejects scanner-results / scanner-ui / scanner-table phrasings', () => {
    for (const phrase of ['scanner results', 'scanner UI', 'scanner table']) {
      const cards: TopicCard[] = [okCard(1, 'Scanner', `a ${phrase} showing detections`)];
      const r = validateCardList(cards, 1);
      expect(r.ok, `phrase "${phrase}" should be banned`).toBe(false);
    }
  });

  it('rejects embedded-text descriptions (showing/displaying/containing "...")', () => {
    for (const verb of ['showing', 'displaying', 'containing']) {
      const cards: TopicCard[] = [okCard(1, 'Alert', `a sign ${verb} 'VIRUS!'`)];
      const r = validateCardList(cards, 1);
      expect(r.ok, `verb "${verb}" should be banned`).toBe(false);
    }
  });

  it('rejects multi-control UI mockups (with multiple buttons / checkboxes / etc)', () => {
    const cards: TopicCard[] = [
      okCard(1, 'Settings', 'a panel with multiple buttons and checkboxes'),
    ];
    const r = validateCardList(cards, 1);
    expect(r.ok).toBe(false);
  });

  it('rejects green accent on a negative concept', () => {
    const cards: TopicCard[] = [
      okCard(1, 'Fake Scan', 'a shield icon', '#4CAF50'),
    ];
    const r = validateCardList(cards, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/reads as safe|safe.*trusted/i);
  });

  it('rejects pure-blue accent on a negative concept', () => {
    const cards: TopicCard[] = [
      okCard(1, 'Phishing', 'a hook icon', '#2196F3'),
    ];
    const r = validateCardList(cards, 1);
    expect(r.ok).toBe(false);
  });

  it('accepts a negative concept with a red accent', () => {
    const cards: TopicCard[] = [
      okCard(1, 'Phishing', 'a hook icon', '#ff0000'),
    ];
    expect(validateCardList(cards, 1)).toEqual({ ok: true });
  });

  it('accepts a neutral / positive concept with a green accent (rule does NOT false-positive)', () => {
    // "Real-Time Scanning" is a legitimate antivirus feature — green is fine here.
    const cards: TopicCard[] = [
      okCard(1, 'Scanning', 'a magnifying glass icon', '#4CAF50'),
    ];
    expect(validateCardList(cards, 1)).toEqual({ ok: true });
  });

  it('accepts legit specific-named-entity cards (no false positives on real subjects)', () => {
    // Cards like the prompt's curated examples — these should pass.
    const cards: TopicCard[] = [
      okCard(1, 'WannaCry', 'the WannaCry ransom screen'),
      okCard(2, 'Sony Hack', 'the Sony Pictures logo'),
      okCard(3, 'ILOVEYOU', 'the ILOVEYOU email icon'),
    ];
    expect(validateCardList(cards, 3)).toEqual({ ok: true });
  });

  it('does NOT crash if ICON_CONCEPT_BANLIST is read-only (sanity)', () => {
    // Guards against a future maintenance change accidentally mutating the
    // exported readonly array.
    expect(Array.isArray(ICON_CONCEPT_BANLIST)).toBe(true);
    expect(ICON_CONCEPT_BANLIST.length).toBeGreaterThan(0);
  });
});
