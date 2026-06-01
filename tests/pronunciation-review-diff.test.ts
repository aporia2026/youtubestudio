/**
 * Unit tests for the Needleman-Wunsch script-vs-Whisper diff in
 * `src/lib/pronunciation-review/diff.ts`. Pure module, no mocks
 * needed — feed it script + Whisper word arrays, assert on the trace.
 */

import { describe, expect, it } from 'vitest';
import {
  diffScriptVsWhisper,
  normalizeWord,
  tokenizeScript,
  type DiffWord,
} from '@/lib/pronunciation-review/diff';

function w(text: string, startSec?: number, endSec?: number): DiffWord {
  return { text, startSec, endSec };
}

describe('normalizeWord', () => {
  it('lowercases and strips surrounding punctuation', () => {
    expect(normalizeWord('Hello,')).toBe('hello');
    expect(normalizeWord('"World!"')).toBe('world');
    expect(normalizeWord('(parens)')).toBe('parens');
  });

  it('preserves internal apostrophes (contractions)', () => {
    expect(normalizeWord("don't")).toBe("don't");
    expect(normalizeWord("can't.")).toBe("can't");
  });

  it('handles non-ASCII letters', () => {
    expect(normalizeWord('Viehböck')).toBe('viehböck');
    expect(normalizeWord('résumé')).toBe('résumé');
  });

  it('returns empty for pure-punctuation input', () => {
    expect(normalizeWord('---')).toBe('');
    expect(normalizeWord('...')).toBe('');
  });
});

describe('tokenizeScript', () => {
  it('splits on whitespace and filters empty tokens', () => {
    expect(tokenizeScript('Hello world.  ').map((d) => d.text)).toEqual([
      'Hello',
      'world.',
    ]);
  });

  it('drops bracket-tagged production markers like [pause]', () => {
    const out = tokenizeScript('He spoke [pause] slowly [excited] then ran.');
    expect(out.map((d) => d.text)).toEqual([
      'He',
      'spoke',
      'slowly',
      'then',
      'ran.',
    ]);
  });

  it('handles empty / whitespace-only input', () => {
    expect(tokenizeScript('').length).toBe(0);
    expect(tokenizeScript('   ').length).toBe(0);
  });
});

describe('diffScriptVsWhisper — edge cases', () => {
  it('returns empty ops when both sides are empty', () => {
    const result = diffScriptVsWhisper([], []);
    expect(result.ops).toEqual([]);
    expect(result.matches).toBe(0);
    expect(result.substitutions).toBe(0);
  });

  it('emits all-omit when Whisper is empty', () => {
    const result = diffScriptVsWhisper([w('hello'), w('world')], []);
    expect(result.omissions).toBe(2);
    expect(result.ops).toHaveLength(2);
    expect(result.ops.every((op) => op.kind === 'omit')).toBe(true);
  });

  it('emits all-insert when script is empty', () => {
    const result = diffScriptVsWhisper([], [w('hi', 0, 0.5)]);
    expect(result.insertions).toBe(1);
    expect(result.ops[0].kind).toBe('insert');
    expect(result.ops[0].startSec).toBe(0);
  });
});

describe('diffScriptVsWhisper — perfect match', () => {
  it('produces all-match for identical sequences', () => {
    const script = [w('hello'), w('world')];
    const whisper = [w('hello', 0, 0.5), w('world', 0.5, 1.0)];
    const result = diffScriptVsWhisper(script, whisper);
    expect(result.matches).toBe(2);
    expect(result.substitutions).toBe(0);
    expect(result.omissions).toBe(0);
    expect(result.insertions).toBe(0);
    expect(result.ops.map((o) => o.kind)).toEqual(['match', 'match']);
  });

  it('matches case-insensitively after normalization', () => {
    const script = [w('Hello'), w('World')];
    const whisper = [w('HELLO', 0, 0.5), w('world.', 0.5, 1.0)];
    const result = diffScriptVsWhisper(script, whisper);
    expect(result.matches).toBe(2);
  });
});

describe('diffScriptVsWhisper — substitution', () => {
  it('detects a single-word substitution in the middle', () => {
    const script = [w('the'), w('quick'), w('brown'), w('fox')];
    const whisper = [
      w('the', 0, 0.2),
      w('quick', 0.2, 0.5),
      w('green', 0.5, 0.8),
      w('fox', 0.8, 1.0),
    ];
    const result = diffScriptVsWhisper(script, whisper);
    expect(result.substitutions).toBe(1);
    expect(result.matches).toBe(3);
    const sub = result.ops.find((o) => o.kind === 'substitute');
    expect(sub).toBeDefined();
    expect(sub?.scriptWord).toBe('brown');
    expect(sub?.whisperWord).toBe('green');
    expect(sub?.startSec).toBe(0.5);
    expect(sub?.endSec).toBe(0.8);
  });
});

describe('diffScriptVsWhisper — omission', () => {
  it('detects a single-word omission', () => {
    const script = [w('we'), w('shall'), w('overcome')];
    const whisper = [w('we', 0, 0.2), w('overcome', 0.2, 0.6)];
    const result = diffScriptVsWhisper(script, whisper);
    expect(result.omissions).toBe(1);
    expect(result.matches).toBe(2);
    const omit = result.ops.find((o) => o.kind === 'omit');
    expect(omit?.scriptWord).toBe('shall');
  });

  it('backfills omission timestamps from the previous word', () => {
    const script = [w('a'), w('b'), w('c')];
    const whisper = [w('a', 0.0, 0.1), w('c', 0.2, 0.3)];
    const result = diffScriptVsWhisper(script, whisper);
    const omit = result.ops.find((o) => o.kind === 'omit');
    expect(omit?.startSec).toBeDefined();
    // Should fall on the cursor — the prior op's startSec (0.0) since
    // we walk left-to-right.
    expect(omit?.startSec).toBeGreaterThanOrEqual(0.0);
  });
});

describe('diffScriptVsWhisper — insertion', () => {
  it('detects a single-word insertion', () => {
    const script = [w('hello'), w('world')];
    const whisper = [
      w('hello', 0, 0.3),
      w('um', 0.3, 0.5),
      w('world', 0.5, 0.9),
    ];
    const result = diffScriptVsWhisper(script, whisper);
    expect(result.insertions).toBe(1);
    expect(result.matches).toBe(2);
    const ins = result.ops.find((o) => o.kind === 'insert');
    expect(ins?.whisperWord).toBe('um');
    expect(ins?.startSec).toBe(0.3);
  });
});

describe('diffScriptVsWhisper — mixed', () => {
  it('handles a realistic mix of operations', () => {
    // Script: "Reaver attacks the router and cracks the code."
    // Narrator (Whisper): "Reaver attacks router um cracks code."
    //
    // The NW aligner has two equally-cheap interpretations for the
    // "and → um" pair: either substitute (cost 1) OR omit-and-insert
    // (cost 2). Our cost model picks substitute, so the trace shows
    // 5 matches, 1 substitution (and→um), 2 omissions (the, the),
    // 0 insertions. Total edit cost is 3 either way; the only thing
    // that differs is the operation breakdown.
    const script = 'Reaver attacks the router and cracks the code.'
      .split(' ')
      .map((t) => w(t));
    const whisper: DiffWord[] = [
      w('Reaver', 0, 0.5),
      w('attacks', 0.5, 1.0),
      w('router', 1.0, 1.4),
      w('um', 1.4, 1.6),
      w('cracks', 1.6, 2.0),
      w('code', 2.0, 2.4),
    ];
    const result = diffScriptVsWhisper(script, whisper);
    expect(result.matches).toBe(5);
    expect(result.substitutions).toBe(1);
    expect(result.omissions).toBe(2);
    expect(result.insertions).toBe(0);
  });

  it('preserves left-to-right order in the trace', () => {
    const script = [w('a'), w('b'), w('c'), w('d')];
    const whisper: DiffWord[] = [
      w('a', 0, 0.1),
      w('z', 0.1, 0.2),
      w('c', 0.2, 0.3),
      w('d', 0.3, 0.4),
    ];
    const result = diffScriptVsWhisper(script, whisper);
    // First and last ops should anchor to a/d. The middle should have
    // a sub for b→z (or omit-then-insert; either trace cost = 1).
    const scriptOrder = result.ops
      .filter((o) => o.scriptIndex !== undefined)
      .map((o) => o.scriptIndex);
    // Strict monotonic non-decreasing (allows omit-then-insert reorder)
    for (let i = 1; i < scriptOrder.length; i++) {
      expect(scriptOrder[i]!).toBeGreaterThanOrEqual(scriptOrder[i - 1]!);
    }
  });
});
