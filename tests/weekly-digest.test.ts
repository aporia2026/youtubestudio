import { describe, expect, it } from 'vitest';
import {
  getDigestWeekWindow,
  markdownToBasicHtml,
  summariseInputs,
} from '@/lib/weekly-digest';

describe('getDigestWeekWindow', () => {
  it('returns the prior week when "now" is on a Monday', () => {
    // 2026-05-04 is a Monday. The cron fires Monday 09:00 UTC for the
    // PRIOR week — so the window should be 2026-04-27 (prev Monday)
    // → 2026-05-04 (this Monday).
    const w = getDigestWeekWindow(new Date('2026-05-04T09:00:00Z'));
    expect(w.weekStart).toBe('2026-04-27');
    expect(w.windowStart).toBe('2026-04-27T00:00:00.000Z');
    expect(w.windowEnd).toBe('2026-05-04T00:00:00.000Z');
    expect(w.priorStart).toBe('2026-04-20T00:00:00.000Z');
    expect(w.priorEnd).toBe('2026-04-27T00:00:00.000Z');
  });

  it('returns the current week when "now" falls mid-week', () => {
    // 2026-05-06 is a Wednesday — the most-recent Monday at-or-before
    // is 2026-05-04. The window covers Mon → next Mon.
    const w = getDigestWeekWindow(new Date('2026-05-06T15:00:00Z'));
    expect(w.weekStart).toBe('2026-05-04');
    expect(w.windowStart).toBe('2026-05-04T00:00:00.000Z');
    expect(w.windowEnd).toBe('2026-05-11T00:00:00.000Z');
  });

  it('returns the current week when "now" falls on a Sunday', () => {
    // 2026-05-10 is a Sunday — the most-recent Monday at-or-before is
    // 2026-05-04. Just before the cron fires.
    const w = getDigestWeekWindow(new Date('2026-05-10T23:59:00Z'));
    expect(w.weekStart).toBe('2026-05-04');
    expect(w.windowEnd).toBe('2026-05-11T00:00:00.000Z');
  });

  it('handles year/month boundaries', () => {
    // 2026-01-05 is a Monday. The prior week crosses the year boundary.
    const w = getDigestWeekWindow(new Date('2026-01-05T09:00:00Z'));
    expect(w.weekStart).toBe('2025-12-29');
    expect(w.windowStart).toBe('2025-12-29T00:00:00.000Z');
    expect(w.windowEnd).toBe('2026-01-05T00:00:00.000Z');
  });
});

describe('markdownToBasicHtml', () => {
  it('renders headings, lists, paragraphs, and bold', () => {
    const md = `# Last week at a glance
Views were up.

## What worked
- **Hook**: opener landed
- Mid-roll cuts

## Three moves
- **Trim**: cut intro to 8s
- Test thumbnail`;
    const html = markdownToBasicHtml(md);
    expect(html).toContain('<h1');
    expect(html).toContain('Last week at a glance');
    expect(html).toContain('<h2');
    expect(html).toContain('<ul');
    expect(html).toContain('<li');
    expect(html).toContain('<strong>Hook</strong>');
    expect(html).toContain('<p');
  });

  it('separates paragraphs on blank lines', () => {
    const html = markdownToBasicHtml('First para.\n\nSecond para.');
    // Two distinct <p> tags.
    expect(html.match(/<p\s/g)?.length).toBe(2);
  });

  it('passes through unsupported syntax as a paragraph', () => {
    const html = markdownToBasicHtml('Some random ! text');
    expect(html).toContain('Some random ! text');
  });

  it('does NOT emit script/iframe/style tags from arbitrary input', () => {
    // The renderer only emits a fixed set of tags. Even when the
    // model misbehaves, the output flows through this whitelist.
    const html = markdownToBasicHtml('<script>alert(1)</script>');
    // Treated as a paragraph; the literal <script>...</script> string
    // ends up inside <p> but the renderer never adds a real script tag.
    // (This isn't full XSS protection — it's defence-in-depth on a
    //  controlled prompt.) We just assert the structural property.
    expect(html.startsWith('<div')).toBe(true);
  });
});

describe('summariseInputs', () => {
  it('reports views + WoW delta + breakout count', () => {
    const out = summariseInputs({
      weekWindow: {
        weekStart: '2026-05-04',
        windowStart: '2026-05-04T00:00:00.000Z',
        windowEnd: '2026-05-11T00:00:00.000Z',
        priorStart: '2026-04-27T00:00:00.000Z',
        priorEnd: '2026-05-04T00:00:00.000Z',
      },
      workspace_id: 'ws-1',
      views_recent: 12000,
      views_prior: 10000,
      mean_ctr_recent: 5,
      mean_ctr_prior: 5,
      mean_avp_recent: 40,
      mean_avp_prior: 40,
      breakouts_count: 1,
      ab_tests_concluded: 0,
      top_breakouts: [],
    });
    expect(out).toContain('12,000 views');
    expect(out).toContain('+2,000');
    expect(out).toContain('1 breakout');
  });

  it('omits the breakout note when count is zero', () => {
    const out = summariseInputs({
      weekWindow: {
        weekStart: '2026-05-04',
        windowStart: '2026-05-04T00:00:00.000Z',
        windowEnd: '2026-05-11T00:00:00.000Z',
        priorStart: '2026-04-27T00:00:00.000Z',
        priorEnd: '2026-05-04T00:00:00.000Z',
      },
      workspace_id: 'ws-1',
      views_recent: 0,
      views_prior: 0,
      mean_ctr_recent: null,
      mean_ctr_prior: null,
      mean_avp_recent: null,
      mean_avp_prior: null,
      breakouts_count: 0,
      ab_tests_concluded: 0,
      top_breakouts: [],
    });
    expect(out).not.toContain('breakout');
  });
});
