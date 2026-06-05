import { describe, expect, it } from 'vitest';
import { parseTopicsResponse } from '@/lib/channel-clone/topics-runner';
import { parseHooksResponse } from '@/lib/channel-clone/hooks-runner';
import {
  parseAuditResponse,
  parseScriptResponse,
} from '@/lib/channel-clone/script-runner';

// Pin the JSON contract for the topics / hooks / script / audit
// stages. Each parser is the canary that flags model drift before
// the runner tries to write garbage into the job's state_jsonb.

const VALID_TOPICS_PAYLOAD = {
  topics: Array.from({ length: 10 }, (_, i) => ({
    title: `Topic ${i + 1}: Why we...?`,
    angle: `Angle for topic ${i + 1}`,
    hook: `Right now, you are the only creature ${i + 1}.`,
    difficulty: ((i % 10) + 1),
  })),
};

describe('parseTopicsResponse', () => {
  it('accepts a 10-topic payload', () => {
    const out = parseTopicsResponse(JSON.stringify(VALID_TOPICS_PAYLOAD), 10);
    expect(out).toHaveLength(10);
    expect(out[0].title).toContain('Topic 1');
    expect(out[0].difficulty).toBe(1);
  });

  it('strips a json code fence', () => {
    const wrapped = '```json\n' + JSON.stringify(VALID_TOPICS_PAYLOAD) + '\n```';
    expect(parseTopicsResponse(wrapped, 10)).toHaveLength(10);
  });

  it('rejects a topic with difficulty outside 1-10', () => {
    const bad = JSON.parse(JSON.stringify(VALID_TOPICS_PAYLOAD));
    bad.topics[3].difficulty = 11;
    expect(() => parseTopicsResponse(JSON.stringify(bad), 10)).toThrow(/difficulty/);
  });

  it('rejects when topic count does not match the request', () => {
    const bad = JSON.parse(JSON.stringify(VALID_TOPICS_PAYLOAD));
    bad.topics.pop();
    expect(() => parseTopicsResponse(JSON.stringify(bad), 10)).toThrow(/expected 10/);
  });

  it('rejects an empty title', () => {
    const bad = JSON.parse(JSON.stringify(VALID_TOPICS_PAYLOAD));
    bad.topics[0].title = '';
    expect(() => parseTopicsResponse(JSON.stringify(bad), 10)).toThrow(/title/);
  });
});

const VALID_HOOKS_PAYLOAD = {
  hooks: [
    { archetype: 'Contrarian', text: 'Most people think...', wordCount: 30, estimatedDurationSec: 15 },
    { archetype: 'Story', text: 'When I was nine...', wordCount: 45, estimatedDurationSec: 22 },
    { archetype: 'Stat', text: '87% of mammals cannot...', wordCount: 40, estimatedDurationSec: 20 },
    { archetype: 'Challenge', text: 'You will never...', wordCount: 35, estimatedDurationSec: 17 },
    { archetype: 'Mystery', text: 'There is one thing...', wordCount: 38, estimatedDurationSec: 19 },
  ],
};

describe('parseHooksResponse', () => {
  it('accepts a valid 5-hook payload', () => {
    const out = parseHooksResponse(JSON.stringify(VALID_HOOKS_PAYLOAD));
    expect(out).toHaveLength(5);
    expect(out.map((h) => h.archetype)).toEqual(['Contrarian', 'Story', 'Stat', 'Challenge', 'Mystery']);
  });

  it('rejects unknown archetype', () => {
    const bad = JSON.parse(JSON.stringify(VALID_HOOKS_PAYLOAD));
    bad.hooks[2].archetype = 'Joke';
    expect(() => parseHooksResponse(JSON.stringify(bad))).toThrow(/archetype/);
  });

  it('rejects when count is not 5', () => {
    const bad = JSON.parse(JSON.stringify(VALID_HOOKS_PAYLOAD));
    bad.hooks.pop();
    expect(() => parseHooksResponse(JSON.stringify(bad))).toThrow(/expected 5 hooks/);
  });

  it('rejects negative duration', () => {
    const bad = JSON.parse(JSON.stringify(VALID_HOOKS_PAYLOAD));
    bad.hooks[0].estimatedDurationSec = -1;
    expect(() => parseHooksResponse(JSON.stringify(bad))).toThrow(/estimatedDurationSec/);
  });
});

const VALID_SCRIPT_PAYLOAD = {
  script: 'Right now, you are the only creature on this entire planet that can do something strange. ' + 'You can leak salt water from your eyes when your heart breaks. '.repeat(40),
  wordCount: 350,
};

describe('parseScriptResponse', () => {
  it('accepts a valid script payload', () => {
    const out = parseScriptResponse(JSON.stringify(VALID_SCRIPT_PAYLOAD));
    expect(out.wordCount).toBe(350);
    expect(out.script.length).toBeGreaterThan(100);
  });

  it('rejects a trivially short script', () => {
    const bad = { script: 'hi', wordCount: 50 };
    expect(() => parseScriptResponse(JSON.stringify(bad))).toThrow(/non-trivial/);
  });

  it('rejects a non-positive wordCount', () => {
    const bad = { script: VALID_SCRIPT_PAYLOAD.script, wordCount: 0 };
    expect(() => parseScriptResponse(JSON.stringify(bad))).toThrow(/wordCount/);
  });
});

const VALID_AUDIT_PAYLOAD = {
  overall: 9.2,
  breakdown: {
    styleDnaMatch: 9,
    hookStrength: 9.5,
    pacingAccuracy: 9,
    emotionalFlowMatch: 9,
    retentionTechniques: 9.5,
    wordCountAccuracyPct: 95,
    originality: 9,
    audiencePsychologyAlignment: 9.5,
    ctaMatch: 9,
    productionReadiness: 9,
  },
  verdict: 'Strong DNA match. Word count slightly under target. Hook lands well.',
};

describe('parseAuditResponse', () => {
  it('accepts a valid audit payload', () => {
    const out = parseAuditResponse(JSON.stringify(VALID_AUDIT_PAYLOAD));
    expect(out.overall).toBe(9.2);
    expect(out.breakdown.styleDnaMatch).toBe(9);
    expect(out.breakdown.wordCountAccuracyPct).toBe(95);
  });

  it('rejects overall outside 0-10', () => {
    const bad = { ...VALID_AUDIT_PAYLOAD, overall: 11 };
    expect(() => parseAuditResponse(JSON.stringify(bad))).toThrow(/overall/);
  });

  it('rejects wordCountAccuracyPct outside 0-100', () => {
    const bad = JSON.parse(JSON.stringify(VALID_AUDIT_PAYLOAD));
    bad.breakdown.wordCountAccuracyPct = 150;
    expect(() => parseAuditResponse(JSON.stringify(bad))).toThrow(/wordCountAccuracyPct/);
  });

  it('rejects missing breakdown', () => {
    const bad = { overall: 9, verdict: 'x' };
    expect(() => parseAuditResponse(JSON.stringify(bad))).toThrow(/breakdown/);
  });

  it('rejects a breakdown score outside 0-10', () => {
    const bad = JSON.parse(JSON.stringify(VALID_AUDIT_PAYLOAD));
    bad.breakdown.hookStrength = 12;
    expect(() => parseAuditResponse(JSON.stringify(bad))).toThrow(/hookStrength/);
  });

  it('strips a markdown fence', () => {
    const wrapped = '```\n' + JSON.stringify(VALID_AUDIT_PAYLOAD) + '\n```';
    const out = parseAuditResponse(wrapped);
    expect(out.overall).toBe(9.2);
  });
});
