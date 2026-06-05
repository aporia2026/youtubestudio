import { describe, expect, it } from 'vitest';
import { parsePublishPackResponse } from '@/lib/channel-clone/publish-pack-runner';

// Pin the publish-pack JSON contract. STATEs 18 + 19 + 21 produce
// one payload — if the model drifts on any sub-section, the whole
// pack fails, so the parser tests below double as the contract for
// what we'll accept.

const TITLES = Array.from({ length: 5 }, (_, i) => ({
  text: `Title candidate ${i + 1} that asks a question?`,
  ctrReasoning: `Why title ${i + 1} earns the click.`,
}));

const TAGS = Array.from({ length: 30 }, (_, i) => `tag${i + 1}`);

const PINNED = ['Pin A: ask a follow-up question?', 'Pin B: tease the sequel.', 'Pin C: thank early viewers.'];

const THUMBNAILS = Array.from({ length: 5 }, (_, i) => ({
  visualConcept: `Concept ${i + 1}: a stick figure looks shocked.`,
  textOverlay: `WHY WE CRY?`,
  emotionTrigger: 'Curiosity',
  colorContrastStrategy: 'Yellow on black background',
  fullImagePrompt: `Hand-drawn doodle thumbnail concept ${i + 1} — full standalone prompt.`,
  ctrReasoning: 'Strong contrast + curiosity-gap copy.',
}));

const CALENDAR = Array.from({ length: 30 }, (_, i) => ({
  day: i + 1,
  title: `Day ${i + 1} title.`,
  angle: `Day ${i + 1} angle.`,
  difficulty: ((i % 10) + 1),
  bestUploadTime: 'Tuesday 4pm ET',
  contentPillar: i % 2 === 0 ? 'evergreen explainer' : 'audience pain point',
}));

const VALID_PUBLISH_PACK = {
  titles: TITLES,
  description:
    'A long enough description to clear the 100-char minimum. This is the hook. This is the tease. This is the call-to-action.',
  tags: TAGS,
  pinnedCommentOptions: PINNED,
  categoryRecommendation: 'Education',
  optimalUploadTime: 'Tuesday 4pm ET',
  thumbnailConcepts: THUMBNAILS,
  contentCalendar: CALENDAR,
};

describe('parsePublishPackResponse — accepts a valid payload', () => {
  it('parses every section', () => {
    const out = parsePublishPackResponse(JSON.stringify(VALID_PUBLISH_PACK), 'claude-opus-4-8');
    expect(out.titles).toHaveLength(5);
    expect(out.tags).toHaveLength(30);
    expect(out.pinnedCommentOptions).toHaveLength(3);
    expect(out.thumbnailConcepts).toHaveLength(5);
    expect(out.contentCalendar).toHaveLength(30);
    expect(out.modelUsed).toBe('claude-opus-4-8');
  });

  it('strips a ```json fence', () => {
    const wrapped = '```json\n' + JSON.stringify(VALID_PUBLISH_PACK) + '\n```';
    expect(parsePublishPackResponse(wrapped, 'claude-opus-4-8').titles).toHaveLength(5);
  });
});

describe('parsePublishPackResponse — section-level rejections', () => {
  it('rejects when titles is not exactly 5 entries', () => {
    const bad = { ...VALID_PUBLISH_PACK, titles: TITLES.slice(0, 3) };
    expect(() => parsePublishPackResponse(JSON.stringify(bad), 'm')).toThrow(/titles must contain exactly 5/);
  });

  it('rejects a title with empty text', () => {
    const bad = JSON.parse(JSON.stringify(VALID_PUBLISH_PACK));
    bad.titles[2].text = '';
    expect(() => parsePublishPackResponse(JSON.stringify(bad), 'm')).toThrow(/titles\[2\].text/);
  });

  it('rejects a description shorter than 100 chars', () => {
    const bad = { ...VALID_PUBLISH_PACK, description: 'too short' };
    expect(() => parsePublishPackResponse(JSON.stringify(bad), 'm')).toThrow(/description must be at least 100/);
  });

  it('rejects tags array outside the 20-40 range', () => {
    const tooFew = { ...VALID_PUBLISH_PACK, tags: TAGS.slice(0, 10) };
    expect(() => parsePublishPackResponse(JSON.stringify(tooFew), 'm')).toThrow(/tags must contain 20-40/);
    const tooMany = { ...VALID_PUBLISH_PACK, tags: Array.from({ length: 50 }, (_, i) => `t${i}`) };
    expect(() => parsePublishPackResponse(JSON.stringify(tooMany), 'm')).toThrow(/tags must contain 20-40/);
  });

  it('rejects pinnedCommentOptions count not equal to 3', () => {
    const bad = { ...VALID_PUBLISH_PACK, pinnedCommentOptions: PINNED.slice(0, 2) };
    expect(() => parsePublishPackResponse(JSON.stringify(bad), 'm')).toThrow(/pinnedCommentOptions/);
  });

  it('rejects thumbnailConcepts count not equal to 5', () => {
    const bad = { ...VALID_PUBLISH_PACK, thumbnailConcepts: THUMBNAILS.slice(0, 4) };
    expect(() => parsePublishPackResponse(JSON.stringify(bad), 'm')).toThrow(/thumbnailConcepts must contain exactly 5/);
  });

  it('rejects calendar day outside 1-30', () => {
    const bad = JSON.parse(JSON.stringify(VALID_PUBLISH_PACK));
    bad.contentCalendar[10].day = 99;
    expect(() => parsePublishPackResponse(JSON.stringify(bad), 'm')).toThrow(/contentCalendar/);
  });

  it('rejects calendar day difficulty outside 1-10', () => {
    const bad = JSON.parse(JSON.stringify(VALID_PUBLISH_PACK));
    bad.contentCalendar[5].difficulty = 12;
    expect(() => parsePublishPackResponse(JSON.stringify(bad), 'm')).toThrow(/difficulty/);
  });

  it('rejects calendar with non-monotonic days', () => {
    const bad = JSON.parse(JSON.stringify(VALID_PUBLISH_PACK));
    [bad.contentCalendar[0], bad.contentCalendar[1]] = [bad.contentCalendar[1], bad.contentCalendar[0]];
    expect(() => parsePublishPackResponse(JSON.stringify(bad), 'm')).toThrow(/days 1\.\.30 in order/);
  });

  it('rejects calendar with the wrong total count', () => {
    const bad = { ...VALID_PUBLISH_PACK, contentCalendar: CALENDAR.slice(0, 28) };
    expect(() => parsePublishPackResponse(JSON.stringify(bad), 'm')).toThrow(/contentCalendar must contain exactly 30/);
  });
});
