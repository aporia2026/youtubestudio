/**
 * Tests for the pure parsing helpers in clusters.ts.
 *
 * The AI call itself isn't unit-tested (it's covered by the
 * smoke test in commit 5 against a real seed); these guard the
 * defensive layer that catches malformed AI output and the
 * fallback heuristic clustering.
 */
import { describe, expect, it } from 'vitest';
import { parseClusterMapOutput, heuristicClusters } from '@/lib/niche-finder/clusters';

describe('parseClusterMapOutput', () => {
  const allowed = [
    'world war 2 documentary',
    'ww2 tank battles',
    'battle of stalingrad',
    'ancient rome',
    'fall of the roman empire',
    'roman legions',
    'samurai history',
    'medieval japan',
    'tokugawa shogunate',
  ];

  it('parses a well-formed response with 3 clusters', () => {
    const raw = JSON.stringify({
      clusters: [
        { centroidTerm: 'world war 2 documentary', relatedTerms: ['ww2 tank battles', 'battle of stalingrad'] },
        { centroidTerm: 'ancient rome', relatedTerms: ['fall of the roman empire', 'roman legions'] },
        { centroidTerm: 'samurai history', relatedTerms: ['medieval japan', 'tokugawa shogunate'] },
      ],
    });
    const parsed = parseClusterMapOutput(raw, allowed);
    expect(parsed).not.toBeNull();
    expect(parsed!).toHaveLength(3);
    expect(parsed![0].centroidTerm).toBe('world war 2 documentary');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify({
      clusters: [{ centroidTerm: 'ancient rome', relatedTerms: ['roman legions'] }],
    }) + '\n```';
    expect(parseClusterMapOutput(raw, allowed)).not.toBeNull();
  });

  it('rejects clusters whose centroid was not in the harvested list', () => {
    const raw = JSON.stringify({
      clusters: [
        { centroidTerm: 'completely made up niche', relatedTerms: ['roman legions'] },
        { centroidTerm: 'ancient rome', relatedTerms: ['roman legions'] },
      ],
    });
    const parsed = parseClusterMapOutput(raw, allowed);
    expect(parsed).not.toBeNull();
    expect(parsed!).toHaveLength(1);
    expect(parsed![0].centroidTerm).toBe('ancient rome');
  });

  it('drops related terms not in the allowed list', () => {
    const raw = JSON.stringify({
      clusters: [
        { centroidTerm: 'ancient rome', relatedTerms: ['roman legions', 'made up term', 'fall of the roman empire'] },
      ],
    });
    const parsed = parseClusterMapOutput(raw, allowed);
    expect(parsed).not.toBeNull();
    expect(parsed![0].relatedTerms).toEqual(['roman legions', 'fall of the roman empire']);
  });

  it('returns null for non-JSON', () => {
    expect(parseClusterMapOutput('not json at all', allowed)).toBeNull();
  });

  it('returns null when clusters key is missing or wrong type', () => {
    expect(parseClusterMapOutput('{}', allowed)).toBeNull();
    expect(parseClusterMapOutput('{"clusters":"x"}', allowed)).toBeNull();
  });

  it('returns null when no cluster passes validation', () => {
    const raw = JSON.stringify({
      clusters: [{ centroidTerm: 'totally invented', relatedTerms: ['also invented'] }],
    });
    expect(parseClusterMapOutput(raw, allowed)).toBeNull();
  });

  it('de-duplicates terms across clusters', () => {
    const raw = JSON.stringify({
      clusters: [
        { centroidTerm: 'world war 2 documentary', relatedTerms: ['roman legions'] },
        { centroidTerm: 'ancient rome', relatedTerms: ['roman legions', 'fall of the roman empire'] },
      ],
    });
    const parsed = parseClusterMapOutput(raw, allowed);
    expect(parsed).not.toBeNull();
    // 'roman legions' should appear only in the first cluster.
    const flatTerms = parsed!.flatMap((c) => c.relatedTerms);
    const count = flatTerms.filter((t) => t === 'roman legions').length;
    expect(count).toBe(1);
  });

  it('caps at 5 clusters', () => {
    const raw = JSON.stringify({
      clusters: allowed.map((term) => ({ centroidTerm: term, relatedTerms: [] })),
    });
    const parsed = parseClusterMapOutput(raw, allowed);
    expect(parsed!.length).toBeLessThanOrEqual(5);
  });
});

describe('heuristicClusters', () => {
  it('returns three buckets from a healthy term list', () => {
    const out = heuristicClusters([
      'history channel',
      'history of rome',
      'history of japan',
      'world war 2',
      'roman empire',
      'samurai history',
      'history of china',
      'history documentary',
    ]);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('returns empty when too few multi-word terms exist', () => {
    expect(heuristicClusters(['hi'])).toEqual([]);
    expect(heuristicClusters(['hi', 'yo'])).toEqual([]);
  });

  it('distributes remainder terms round-robin', () => {
    const out = heuristicClusters([
      'word one',
      'word two',
      'word three',
      'extra alpha',
      'extra beta',
      'extra gamma',
      'extra delta',
    ]);
    expect(out).toHaveLength(3);
    const flat = out.flatMap((c) => c.relatedTerms);
    expect(flat).toContain('extra alpha');
    expect(flat).toContain('extra delta');
  });
});
