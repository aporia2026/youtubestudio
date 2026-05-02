import { describe, expect, it } from 'vitest';
import {
  buildCannibalizationPrompt,
  findCrossChannelPairs,
  lexicalSimilarity,
  parseAlertOutput,
  riskLevelFromScore,
  tokenize,
  type CandidateUpload,
} from '@/lib/cannibalization';
import { CANNIBAL_LEXICAL_THRESHOLD } from '@/lib/cannibalization-types';

describe('tokenize', () => {
  it('lowercases, drops short tokens, drops punctuation, drops stop-words', () => {
    const t = tokenize('How to FIX your iPhone in 30 seconds!');
    expect(Array.from(t).sort()).toEqual(['fix', 'iphone', 'seconds'].sort());
  });

  it('returns an empty set for blank inputs', () => {
    expect(tokenize('').size).toBe(0);
    expect(tokenize('   ').size).toBe(0);
    expect(tokenize('the and a is').size).toBe(0); // all stop-words
  });

  it('drops "video"/"videos"/"youtube" — generic noise', () => {
    const t = tokenize('My YouTube video about fixing things');
    expect(t.has('youtube')).toBe(false);
    expect(t.has('video')).toBe(false);
  });
});

describe('lexicalSimilarity', () => {
  it('returns 1.0 for identical title token sets', () => {
    expect(lexicalSimilarity('How I fix my iPhone', 'iPhone fix how I')).toBe(1);
  });

  it('returns 0 for fully disjoint titles', () => {
    expect(lexicalSimilarity('iPhone tips', 'cooking pasta')).toBe(0);
  });

  it('returns 0 when either side is empty', () => {
    expect(lexicalSimilarity('', 'something')).toBe(0);
    expect(lexicalSimilarity('something', '')).toBe(0);
  });

  it('scales with overlap', () => {
    // {iphone, fix, screen} vs {iphone, replace, battery}
    // intersect = 1 (iphone), union = 5, similarity = 0.2
    const score = lexicalSimilarity('iPhone fix screen', 'iPhone replace battery');
    expect(score).toBeCloseTo(0.2, 2);
  });

  it('is symmetric', () => {
    const a = 'How to make sourdough bread at home';
    const b = 'Sourdough at home: a beginner guide';
    expect(lexicalSimilarity(a, b)).toBe(lexicalSimilarity(b, a));
  });
});

describe('riskLevelFromScore', () => {
  it('thresholds at 0.32 and 0.55', () => {
    expect(riskLevelFromScore(0.1)).toBe('low');
    expect(riskLevelFromScore(0.31)).toBe('low');
    expect(riskLevelFromScore(0.32)).toBe('medium');
    expect(riskLevelFromScore(0.5)).toBe('medium');
    expect(riskLevelFromScore(0.55)).toBe('high');
    expect(riskLevelFromScore(0.99)).toBe('high');
  });
});

describe('findCrossChannelPairs', () => {
  function up(
    id: string,
    channelId: string,
    publishAt: string | null,
    title = 'Title ' + id,
  ): CandidateUpload {
    return {
      kind: 'schedule_item',
      ref_id: id,
      channel_id: channelId,
      channel_name: `Ch-${channelId}`,
      title,
      publish_at: publishAt,
    };
  }

  it('pairs only across channels (same-channel pairs excluded)', () => {
    const uploads = [
      up('1', 'A', '2026-05-10T00:00:00Z'),
      up('2', 'A', '2026-05-12T00:00:00Z'),
      up('3', 'B', '2026-05-11T00:00:00Z'),
    ];
    const pairs = findCrossChannelPairs(uploads, 7);
    // Only A-B pairs should appear; never A-A.
    expect(pairs.length).toBe(2);
    for (const [a, b] of pairs) {
      expect(a.channel_id).not.toBe(b.channel_id);
    }
  });

  it('excludes pairs outside the window', () => {
    const uploads = [
      up('1', 'A', '2026-05-01T00:00:00Z'),
      up('2', 'B', '2026-05-15T00:00:00Z'), // 14 days later
    ];
    expect(findCrossChannelPairs(uploads, 7)).toHaveLength(0);
    expect(findCrossChannelPairs(uploads, 21)).toHaveLength(1);
  });

  it('drops uploads with null publish_at', () => {
    const uploads = [
      up('1', 'A', null),
      up('2', 'B', '2026-05-15T00:00:00Z'),
    ];
    expect(findCrossChannelPairs(uploads, 7)).toHaveLength(0);
  });

  it('handles a busy schedule and short-circuits via sort order', () => {
    const uploads: CandidateUpload[] = [];
    // 5 channels × 4 uploads each = 20 uploads spread over 30 days.
    for (let ch = 0; ch < 5; ch++) {
      for (let n = 0; n < 4; n++) {
        const day = ch * 2 + n * 7;
        uploads.push(up(`${ch}-${n}`, String.fromCharCode(65 + ch), `2026-05-${String(1 + day).padStart(2, '0')}T00:00:00Z`));
      }
    }
    const pairs = findCrossChannelPairs(uploads, 7);
    // Sanity: every pair must be (a) cross-channel and (b) within 7 days.
    for (const [a, b] of pairs) {
      expect(a.channel_id).not.toBe(b.channel_id);
      const dayMs = 1000 * 60 * 60 * 24;
      const dt = Math.abs(new Date(b.publish_at!).getTime() - new Date(a.publish_at!).getTime());
      expect(dt).toBeLessThanOrEqual(7 * dayMs);
    }
  });

  it('treats null channel_ids as different channels (so they pair)', () => {
    const uploads = [
      up('1', null as unknown as string, '2026-05-10T00:00:00Z'),
      up('2', null as unknown as string, '2026-05-11T00:00:00Z'),
    ];
    // Two null channel_ids — we don't have enough info to call them the
    // same channel, so we err on the side of flagging.
    expect(findCrossChannelPairs(uploads, 7).length).toBe(1);
  });
});

describe('buildCannibalizationPrompt', () => {
  const pair: [CandidateUpload, CandidateUpload] = [
    {
      kind: 'schedule_item',
      ref_id: 's1',
      channel_id: 'cA',
      channel_name: 'AI Tools Daily',
      title: 'How to use Claude Code in 2026',
      publish_at: '2026-05-10T12:00:00Z',
    },
    {
      kind: 'video',
      ref_id: 'yt2',
      channel_id: 'cB',
      channel_name: 'Code with Me',
      title: 'Claude Code 2026 — first impressions',
      publish_at: '2026-05-08T18:00:00Z',
    },
  ];

  it('embeds both titles, both channels, and the similarity score', () => {
    const { user } = buildCannibalizationPrompt({ pair, similarity: 0.4, windowDays: 7 });
    expect(user).toContain('AI Tools Daily');
    expect(user).toContain('Code with Me');
    expect(user).toContain('How to use Claude Code in 2026');
    expect(user).toContain('Claude Code 2026 — first impressions');
    expect(user).toContain('40%');
    expect(user).toContain('±7-day');
  });

  it('marks each side as scheduled vs published', () => {
    const { user } = buildCannibalizationPrompt({ pair, similarity: 0.4, windowDays: 7 });
    expect(user).toMatch(/Status:\s+scheduled/);
    expect(user).toMatch(/Status:\s+already published/);
  });

  it('demands the 3-field JSON shape in the system prompt', () => {
    const { system } = buildCannibalizationPrompt({ pair, similarity: 0.5, windowDays: 7 });
    expect(system).toContain('"why"');
    expect(system).toContain('"recommended_fix"');
    expect(system).toContain('"risk_level"');
    expect(system).toMatch(/STRICTLY this JSON/);
  });
});

describe('parseAlertOutput', () => {
  it('parses a clean JSON response', () => {
    const out = parseAlertOutput(
      JSON.stringify({
        why: 'Both videos target the same query for the same week.',
        recommended_fix: 'Delay the AI Tools Daily upload by 5 days.',
        risk_level: 'high',
      }),
      'medium',
    );
    expect(out.why).toMatch(/same query/);
    expect(out.recommended_fix).toMatch(/Delay/);
    expect(out.risk_level).toBe('high');
  });

  it('falls back to the lexical risk_level when the LLM omits it', () => {
    const out = parseAlertOutput(
      JSON.stringify({ why: 'overlap', recommended_fix: 'delay' }),
      'medium',
    );
    expect(out.risk_level).toBe('medium');
  });

  it('rejects invalid risk_level strings', () => {
    const out = parseAlertOutput(
      JSON.stringify({ why: 'x', recommended_fix: 'y', risk_level: 'catastrophic' }),
      'low',
    );
    expect(out.risk_level).toBe('low');
  });

  it('throws on unparseable JSON', () => {
    expect(() => parseAlertOutput('not json', 'medium')).toThrow(/Could not parse JSON/);
  });

  it('truncates oversized why / recommended_fix', () => {
    const huge = 'x'.repeat(2000);
    const out = parseAlertOutput(
      JSON.stringify({ why: huge, recommended_fix: huge, risk_level: 'high' }),
      'low',
    );
    expect(out.why.length).toBeLessThanOrEqual(800);
    expect(out.recommended_fix.length).toBeLessThanOrEqual(600);
  });
});

describe('CANNIBAL_LEXICAL_THRESHOLD', () => {
  it('is configured to filter out low-signal pairs', () => {
    expect(CANNIBAL_LEXICAL_THRESHOLD).toBeGreaterThan(0.05);
    expect(CANNIBAL_LEXICAL_THRESHOLD).toBeLessThan(0.5);
  });
});
