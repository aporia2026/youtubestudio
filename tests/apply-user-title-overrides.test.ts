import { describe, expect, it } from 'vitest';
import {
  applyUserTitleOverrides,
  extractScriptTitles,
  type UserTitleSpec,
} from '@/lib/script-titles';

// Verifies the override layer the pre-flight TitleReviewPanel relies on.
// See `_plans/2026-05-31-preflight-title-review.md`.
describe('applyUserTitleOverrides', () => {
  const SCRIPT = [
    'Intro line.',
    '##First Section',
    'Body of section 1.',
    '##Second Section',
    'Body of section 2.',
    '##Third Section',
    'Body of section 3.',
  ].join('\n');

  it('keeps detected titles unchanged when user list matches exactly', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = extracted.titles.map((t) => ({
      text: t.text,
      sourceSentinel: t.sentinel,
    }));
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles).toHaveLength(3);
    expect(result.titles.map((t) => t.text)).toEqual([
      'First Section', 'Second Section', 'Third Section',
    ]);
    expect(result.stripped).toBe(extracted.stripped);
    expect(result.counts).toEqual({ edited: 0, deleted: 0, added: 0 });
    expect(result.warnings).toEqual([]);
  });

  it('edits a detected title text and reports it as edited', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      { text: 'Renamed First', sourceSentinel: extracted.titles[0].sentinel },
      { text: extracted.titles[1].text, sourceSentinel: extracted.titles[1].sentinel },
      { text: extracted.titles[2].text, sourceSentinel: extracted.titles[2].sentinel },
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles.map((t) => t.text)).toEqual([
      'Renamed First', 'Second Section', 'Third Section',
    ]);
    expect(result.counts.edited).toBe(1);
  });

  it('restores the original line for a deleted detected title', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      { text: extracted.titles[0].text, sourceSentinel: extracted.titles[0].sentinel },
      { text: extracted.titles[1].text, sourceSentinel: extracted.titles[1].sentinel, deleted: true },
      { text: extracted.titles[2].text, sourceSentinel: extracted.titles[2].sentinel },
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles.map((t) => t.text)).toEqual([
      'First Section', 'Third Section',
    ]);
    expect(result.stripped).toContain('##Second Section');
    expect(result.stripped).not.toContain(extracted.titles[1].sentinel);
    expect(result.counts.deleted).toBe(1);
  });

  it('treats silent omission of a detected sentinel as a delete', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      { text: extracted.titles[0].text, sourceSentinel: extracted.titles[0].sentinel },
      // sentinel #1 silently omitted
      { text: extracted.titles[2].text, sourceSentinel: extracted.titles[2].sentinel },
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles.map((t) => t.text)).toEqual([
      'First Section', 'Third Section',
    ]);
    expect(result.stripped).toContain('##Second Section');
    expect(result.counts.deleted).toBe(1);
  });

  it('inserts an added title after the indicated sentinel', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      { text: extracted.titles[0].text, sourceSentinel: extracted.titles[0].sentinel },
      { text: 'Inserted After First', insertAfterSentinel: extracted.titles[0].sentinel },
      { text: extracted.titles[1].text, sourceSentinel: extracted.titles[1].sentinel },
      { text: extracted.titles[2].text, sourceSentinel: extracted.titles[2].sentinel },
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles.map((t) => t.text)).toEqual([
      'First Section', 'Inserted After First', 'Second Section', 'Third Section',
    ]);
    expect(result.counts.added).toBe(1);
    // The added sentinel must appear immediately AFTER the kept first
    // sentinel in the stripped output.
    const lines = result.stripped.split('\n');
    const firstIdx = lines.indexOf(extracted.titles[0].sentinel);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(lines[firstIdx + 1]).toBe('<<TITLE_USER_0>>');
  });

  it('inserts an added title at the start when insertAfterSentinel is null', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      { text: 'Opening Hook', insertAfterSentinel: null },
      ...extracted.titles.map((t) => ({ text: t.text, sourceSentinel: t.sentinel })),
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles[0].text).toBe('Opening Hook');
    expect(result.titles[0].sentinel).toBe('<<TITLE_USER_0>>');
    expect(result.stripped.split('\n')[0]).toBe('<<TITLE_USER_0>>');
    expect(result.counts.added).toBe(1);
  });

  it('handles mixed edit + delete + add in one pass', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      { text: 'Renamed First', sourceSentinel: extracted.titles[0].sentinel },
      { text: 'New Between', insertAfterSentinel: extracted.titles[0].sentinel },
      { text: extracted.titles[1].text, sourceSentinel: extracted.titles[1].sentinel, deleted: true },
      { text: extracted.titles[2].text, sourceSentinel: extracted.titles[2].sentinel },
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles.map((t) => t.text)).toEqual([
      'Renamed First', 'New Between', 'Third Section',
    ]);
    expect(result.counts).toEqual({ edited: 1, deleted: 1, added: 1 });
    expect(result.stripped).toContain('##Second Section');
  });

  it('drops added titles with empty text and warns', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      ...extracted.titles.map((t) => ({ text: t.text, sourceSentinel: t.sentinel })),
      { text: '   ', insertAfterSentinel: extracted.titles[0].sentinel },
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles).toHaveLength(3);
    expect(result.counts.added).toBe(0);
    expect(result.warnings.some((w) => w.toLowerCase().includes('empty'))).toBe(true);
  });

  it('warns and skips when sourceSentinel is unknown', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      { text: 'Phantom', sourceSentinel: '<<TITLE_99>>' },
      ...extracted.titles.map((t) => ({ text: t.text, sourceSentinel: t.sentinel })),
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles.map((t) => t.text)).toEqual([
      'First Section', 'Second Section', 'Third Section',
    ]);
    expect(result.warnings.some((w) => w.toLowerCase().includes('no longer'))).toBe(true);
  });

  it('falls back to "end" when insertAfterSentinel is unknown', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      ...extracted.titles.map((t) => ({ text: t.text, sourceSentinel: t.sentinel })),
      { text: 'Trailing Add', insertAfterSentinel: '<<TITLE_99>>' },
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    expect(result.titles.map((t) => t.text)).toEqual([
      'First Section', 'Second Section', 'Third Section', 'Trailing Add',
    ]);
    expect(result.counts.added).toBe(1);
    expect(result.warnings.some((w) => w.toLowerCase().includes('no longer exists'))).toBe(true);
  });

  it('appends multiple adds sharing the same insertAfterSentinel in user-list order', () => {
    const extracted = extractScriptTitles(SCRIPT);
    const userTitles: UserTitleSpec[] = [
      { text: extracted.titles[0].text, sourceSentinel: extracted.titles[0].sentinel },
      { text: 'A', insertAfterSentinel: extracted.titles[0].sentinel },
      { text: 'B', insertAfterSentinel: extracted.titles[0].sentinel },
      { text: extracted.titles[1].text, sourceSentinel: extracted.titles[1].sentinel },
      { text: extracted.titles[2].text, sourceSentinel: extracted.titles[2].sentinel },
    ];
    const result = applyUserTitleOverrides(extracted, userTitles);
    const texts = result.titles.map((t) => t.text);
    const aIdx = texts.indexOf('A');
    const bIdx = texts.indexOf('B');
    expect(aIdx).toBeLessThan(bIdx);
    expect(aIdx).toBeGreaterThan(texts.indexOf('First Section'));
    expect(bIdx).toBeLessThan(texts.indexOf('Second Section'));
  });
});
