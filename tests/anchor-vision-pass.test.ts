import { describe, expect, it } from 'vitest';
import { buildAnchorPrompt, parseAnchors } from '@/lib/anchor-vision-pass';

// ─── buildAnchorPrompt ──────────────────────────────────────────────
//
// The prompt is load-bearing — it's the contract Kie/Gemini reads to
// know what coordinates to return. Silent edits could change the JSON
// schema the model emits and break the parser's expectations.

describe('buildAnchorPrompt', () => {
  const prompt = buildAnchorPrompt();

  it('asks for canvas-percentage coordinates (not pixel)', () => {
    expect(prompt).toMatch(/percentage|percent|x_pct|y_pct/i);
  });

  it('names every anchor field the parser expects', () => {
    // The three fields the parser reads. If the prompt drops one,
    // the model won't return it, and the parser will silently treat
    // the anchor as missing.
    expect(prompt).toMatch(/mouth_center/);
    expect(prompt).toMatch(/eyes_center/);
    expect(prompt).toMatch(/character_center/);
  });

  it('instructs the model to return null for absent features (not omit)', () => {
    // Important: omission and explicit null are different signals.
    // null = feature isn't visible, don't guess. Omission = parsing
    // bug. The prompt has to ask for null explicitly.
    expect(prompt).toMatch(/null/);
  });

  it('forbids markdown / code fences in the output', () => {
    expect(prompt).toMatch(/no.*(markdown|code fences|commentary)/i);
  });

  it('fits within a comfortable Kie token budget', () => {
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt.length).toBeLessThan(2000);
  });
});

// ─── parseAnchors ────────────────────────────────────────────────────
//
// Parses Kie/Gemini's content string into the renderer-facing shape.
// Tolerant of code-fence wrapping, prose-wrapped JSON, partial
// responses, and out-of-bounds hallucinations.

describe('parseAnchors — happy path', () => {
  it('parses a fully-populated response', () => {
    const content = JSON.stringify({
      mouth_center: { x_pct: 41.7, y_pct: 52.2 },
      eyes_center: { x_pct: 42.0, y_pct: 45.0 },
      character_center: { x_pct: 50.0, y_pct: 50.0 },
    });
    const result = parseAnchors(content);
    expect(result).not.toBeNull();
    expect(result!.mouthCenter).toEqual({ xPct: 41.7, yPct: 52.2 });
    expect(result!.eyesCenter).toEqual({ xPct: 42.0, yPct: 45.0 });
    expect(result!.characterCenter).toEqual({ xPct: 50.0, yPct: 50.0 });
  });

  it('accepts integer values (not just floats)', () => {
    const content = JSON.stringify({
      mouth_center: { x_pct: 50, y_pct: 50 },
      eyes_center: null,
      character_center: null,
    });
    const result = parseAnchors(content);
    expect(result?.mouthCenter).toEqual({ xPct: 50, yPct: 50 });
  });

  it('accepts a partial response (some anchors null)', () => {
    // Back-of-head pose: no mouth, no eyes visible, but character_center
    // is still derivable from the silhouette.
    const content = JSON.stringify({
      mouth_center: null,
      eyes_center: null,
      character_center: { x_pct: 40, y_pct: 60 },
    });
    const result = parseAnchors(content);
    expect(result?.mouthCenter).toBeNull();
    expect(result?.eyesCenter).toBeNull();
    expect(result?.characterCenter).toEqual({ xPct: 40, yPct: 60 });
  });
});

describe('parseAnchors — code fence stripping', () => {
  it('strips a leading ```json fence', () => {
    const content = '```json\n{"mouth_center":{"x_pct":50,"y_pct":50},"eyes_center":null,"character_center":null}\n```';
    expect(parseAnchors(content)?.mouthCenter).toEqual({ xPct: 50, yPct: 50 });
  });

  it('strips a plain ``` fence', () => {
    const content = '```\n{"mouth_center":{"x_pct":50,"y_pct":50},"eyes_center":null,"character_center":null}\n```';
    expect(parseAnchors(content)?.mouthCenter).toEqual({ xPct: 50, yPct: 50 });
  });

  it('extracts a JSON object embedded in prose', () => {
    const content = 'Here are the anchors I found: {"mouth_center":{"x_pct":42,"y_pct":55},"eyes_center":null,"character_center":null} — hope that helps.';
    expect(parseAnchors(content)?.mouthCenter).toEqual({ xPct: 42, yPct: 55 });
  });
});

describe('parseAnchors — defense in depth', () => {
  it('returns null for invalid JSON', () => {
    expect(parseAnchors('not json at all')).toBeNull();
    expect(parseAnchors('')).toBeNull();
  });

  it('returns null when every anchor is null/missing (no useful data)', () => {
    expect(parseAnchors(JSON.stringify({
      mouth_center: null,
      eyes_center: null,
      character_center: null,
    }))).toBeNull();
  });

  it('returns null when every anchor is malformed', () => {
    expect(parseAnchors(JSON.stringify({
      mouth_center: 'invalid',
      eyes_center: 42,
      character_center: [],
    }))).toBeNull();
  });

  // Each "reject" test below pairs the malformed anchor with a
  // VALID anchor so parseAnchors returns an object (not null —
  // null is reserved for "every anchor was malformed"). The
  // assertion checks that the bad anchor specifically is null
  // while the good one survives.

  it('rejects anchors with out-of-bounds coordinates', () => {
    // A hallucinated 200,200 must NOT be clamped to 100,100 — the
    // renderer would silently place the mouth at the bottom-right
    // corner. Reject hard so caller falls back to default.
    const content = JSON.stringify({
      mouth_center: { x_pct: 200, y_pct: 200 }, // bad
      eyes_center: { x_pct: 50, y_pct: 45 },    // good — keeps parseAnchors out of all-null bailout
      character_center: null,
    });
    const result = parseAnchors(content);
    expect(result?.mouthCenter).toBeNull();
    expect(result?.eyesCenter).toEqual({ xPct: 50, yPct: 45 });
  });

  it('rejects anchors with negative coordinates', () => {
    const content = JSON.stringify({
      mouth_center: { x_pct: -5, y_pct: 50 }, // bad
      eyes_center: { x_pct: 50, y_pct: 45 },  // good
      character_center: null,
    });
    const result = parseAnchors(content);
    expect(result?.mouthCenter).toBeNull();
    expect(result?.eyesCenter).toEqual({ xPct: 50, yPct: 45 });
  });

  it('rejects anchors with non-number coordinates', () => {
    const content = JSON.stringify({
      mouth_center: { x_pct: '50', y_pct: '50' }, // bad
      eyes_center: { x_pct: 50, y_pct: 45 },      // good
      character_center: null,
    });
    const result = parseAnchors(content);
    expect(result?.mouthCenter).toBeNull();
    expect(result?.eyesCenter).toEqual({ xPct: 50, yPct: 45 });
  });

  it('rejects anchors with NaN / Infinity coordinates', () => {
    // JSON.stringify drops these, so we craft the string by hand.
    // Whole-response bailout — only one anchor present and it's bad.
    const content = '{"mouth_center":{"x_pct":NaN,"y_pct":50},"eyes_center":null,"character_center":null}';
    expect(parseAnchors(content)).toBeNull();
  });

  it('rejects anchors missing one of x_pct / y_pct', () => {
    const content = JSON.stringify({
      mouth_center: { x_pct: 50 }, // y_pct missing → bad
      eyes_center: { x_pct: 50, y_pct: 45 }, // good
      character_center: null,
    });
    const result = parseAnchors(content);
    expect(result?.mouthCenter).toBeNull();
    expect(result?.eyesCenter).toEqual({ xPct: 50, yPct: 45 });
  });

  it('keeps the valid anchors when one is malformed (graceful partial)', () => {
    // Common LLM pattern: one anchor is reliably extractable, others
    // are hand-wavy. Parser keeps the good one and nulls the bad.
    const content = JSON.stringify({
      mouth_center: { x_pct: 42, y_pct: 55 },
      eyes_center: { x_pct: 200, y_pct: 200 }, // out-of-bounds
      character_center: 'unsure',
    });
    const result = parseAnchors(content);
    expect(result?.mouthCenter).toEqual({ xPct: 42, yPct: 55 });
    expect(result?.eyesCenter).toBeNull();
    expect(result?.characterCenter).toBeNull();
  });
});
