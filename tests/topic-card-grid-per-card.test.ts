import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  buildPerCardPrompt,
  buildPerCardStyleHeader,
  runPerCardGeneration,
} from '@/lib/thumbnail-formats/topic-card-grid-per-card';
import type { TopicCard } from '@/lib/thumbnail-formats/topic-card-grid';

const card = (index: number, label: string, subject: string, accent?: string): TopicCard => ({
  index,
  label,
  icon_concept: subject,
  accent_color: accent,
});

describe('buildPerCardPrompt', () => {
  it('places the shared style header at the top of the prompt', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'X', 'a red apple'),
      styleHeader: 'STYLE: doodle, hand-drawn, black ink',
      cardShape: 'circle',
    });
    expect(out.indexOf('STYLE: doodle')).toBeLessThan(out.indexOf('SINGLE-CARD'));
  });

  it('omits the style block when the header is empty / whitespace', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'X', 'a red apple'),
      styleHeader: '   ',
      cardShape: 'circle',
    });
    // No leading blank style block — prompt starts with the SINGLE-CARD section.
    expect(out.startsWith('SINGLE-CARD ILLUSTRATION:')).toBe(true);
  });

  it('embeds the card subject (icon_concept) verbatim', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'X', 'a vintage CIA document with redactions'),
      styleHeader: '',
      cardShape: 'circle',
    });
    expect(out).toContain('a vintage CIA document with redactions');
  });

  it('embeds the card label so the AI knows what NOT to write in the illustration', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'MKUltra', 'a document'),
      styleHeader: '',
      cardShape: 'circle',
    });
    expect(out).toContain('"MKUltra"');
    // And explicit forbidding of in-illustration text.
    expect(out).toContain('TEXT INSIDE THE ILLUSTRATION IS FORBIDDEN');
  });

  it('passes the per-card accent_color through as the background colour when provided', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'X', 'subject', '#7e22ce'),
      styleHeader: '',
      cardShape: 'circle',
    });
    expect(out).toContain('solid #7e22ce');
  });

  it('falls back to "AI picks the colour" wording when accent_color is omitted', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'X', 'subject'),
      styleHeader: '',
      cardShape: 'circle',
    });
    expect(out).toContain('SINGLE solid colour that complements');
  });

  it('warns about circular crop when cardShape === "circle"', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'X', 'subject'),
      styleHeader: '',
      cardShape: 'circle',
    });
    expect(out).toContain('CROPPED to a circle');
    expect(out).toContain('inscribed circle');
  });

  it('omits the circular-crop warning when cardShape === "square"', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'X', 'subject'),
      styleHeader: '',
      cardShape: 'square',
    });
    expect(out).not.toContain('CROPPED to a circle');
  });

  it('always specifies the 1024×1024 output dimension so the AI returns a square', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'X', 'subject'),
      styleHeader: 'STYLE',
      cardShape: 'circle',
    });
    expect(out).toContain('1024×1024');
  });

  it('square mode tells the AI to fill the cell edge-to-edge with no sticker halo', () => {
    // Regression pin for the 2026-06-04 sticker-halo bug: an earlier
    // version of the prompt always told the AI to "leave generous
    // solid-colour padding" around the subject. That instruction is
    // right for circle mode (corners get clipped) but in square mode
    // produced inconsistent sticker styling — half the cards came
    // back as full-bleed scenes, the other half as floating icons
    // with white halos on flat colour backdrops.
    const out = buildPerCardPrompt({
      card: card(1, 'Farm', 'a gas mask'),
      styleHeader: '',
      cardShape: 'square',
    });
    expect(out).toContain('FULL-BLEED');
    expect(out).toContain('NO white halo');
    expect(out).toContain('NO sticker outline');
    expect(out).toContain('touch all four edges');
    // The circle-mode "leave generous solid-colour padding" wording
    // must NOT leak into square mode — that's what caused the bug.
    expect(out).not.toContain('inscribed circle area');
  });

  it('circle mode keeps the "leave padding inside the inscribed circle" framing', () => {
    const out = buildPerCardPrompt({
      card: card(1, 'Farm', 'a gas mask'),
      styleHeader: '',
      cardShape: 'circle',
    });
    expect(out).toContain('inscribed circle area');
    expect(out).toContain('corners will be clipped');
    // The square-mode "full-bleed / no padding" wording must NOT
    // leak into circle mode — that would tell the AI to put subject
    // content in the corners that the disc clips off.
    expect(out).not.toContain('FULL-BLEED');
    expect(out).not.toContain('touch all four edges');
  });
});

describe('runPerCardGeneration', () => {
  it('runs every card through `generate` and returns a stable-order result array', async () => {
    const generate = async (_prompt: string, c: TopicCard) =>
      Buffer.from(`bytes-${c.index}`);
    const cards = [
      card(1, 'A', 'subject-a'),
      card(2, 'B', 'subject-b'),
      card(3, 'C', 'subject-c'),
    ];
    const results = await runPerCardGeneration({
      cards,
      styleHeader: '',
      cardShape: 'circle',
      generate,
    });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.cardIndex)).toEqual([1, 2, 3]);
    expect(results[0].bytes?.toString()).toBe('bytes-1');
    expect(results[2].bytes?.toString()).toBe('bytes-3');
    // Every result has a duration recorded.
    results.forEach((r) => expect(typeof r.durationMs).toBe('number'));
  });

  it('captures per-card errors WITHOUT aborting the rest of the batch', async () => {
    const generate = async (_prompt: string, c: TopicCard) => {
      if (c.index === 2) throw new Error('synthetic failure');
      return Buffer.from(`bytes-${c.index}`);
    };
    const cards = [card(1, 'A', 'sub-a'), card(2, 'B', 'sub-b'), card(3, 'C', 'sub-c')];
    const results = await runPerCardGeneration({
      cards,
      styleHeader: '',
      cardShape: 'circle',
      generate,
    });
    expect(results[0].bytes?.toString()).toBe('bytes-1');
    expect(results[1].error).toBe('synthetic failure');
    expect(results[1].bytes).toBeUndefined();
    expect(results[2].bytes?.toString()).toBe('bytes-3');
  });

  it('caps concurrent in-flight calls to `concurrency`', async () => {
    let inFlight = 0;
    let peak = 0;
    const generate = async (_prompt: string, _c: TopicCard) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return Buffer.from('ok');
    };
    const cards = Array.from({ length: 9 }, (_, i) =>
      card(i + 1, `L${i}`, `subject-${i}`),
    );
    await runPerCardGeneration({
      cards,
      styleHeader: '',
      cardShape: 'circle',
      generate,
      concurrency: 3,
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it('passes the shared style header into every per-card prompt', async () => {
    const seenPrompts: string[] = [];
    const generate = async (prompt: string, _c: TopicCard) => {
      seenPrompts.push(prompt);
      return Buffer.from('ok');
    };
    const cards = [card(1, 'A', 'sub-a'), card(2, 'B', 'sub-b')];
    await runPerCardGeneration({
      cards,
      styleHeader: 'CONSISTENT-STYLE-MARKER',
      cardShape: 'circle',
      generate,
    });
    expect(seenPrompts.every((p) => p.includes('CONSISTENT-STYLE-MARKER'))).toBe(true);
  });

  it('clamps concurrency to the card count so a 2-card batch never spins up 4 idle workers', async () => {
    let started = 0;
    const generate = async () => {
      started += 1;
      return Buffer.from('ok');
    };
    const cards = [card(1, 'A', 'x'), card(2, 'B', 'y')];
    await runPerCardGeneration({
      cards,
      styleHeader: '',
      cardShape: 'circle',
      generate,
      concurrency: 8, // requested concurrency exceeds card count
    });
    expect(started).toBe(2);
  });

  it('threads the per-card accent_color into the prompt body', async () => {
    const seen: string[] = [];
    const generate = async (prompt: string) => {
      seen.push(prompt);
      return Buffer.from('ok');
    };
    await runPerCardGeneration({
      cards: [card(1, 'A', 'x', '#ff0000')],
      styleHeader: '',
      cardShape: 'circle',
      generate,
    });
    expect(seen[0]).toContain('#ff0000');
  });
});

describe('buildPerCardStyleHeader', () => {
  it('opens with the SHARED STYLE banner so the AI reads it as the cross-card contract', () => {
    const out = buildPerCardStyleHeader({
      style: 'cartoon',
      brightness: 'bright',
      detail: 'clean',
    });
    expect(out.startsWith('SHARED STYLE')).toBe(true);
  });

  it('includes the style, brightness, and detail directives verbatim', () => {
    const out = buildPerCardStyleHeader({
      style: 'sketch',
      brightness: 'moody',
      detail: 'detailed',
    });
    expect(out).toContain('STYLE — SKETCH');
    expect(out).toContain('BRIGHTNESS — MOODY');
    expect(out).toContain('DETAIL — DETAILED');
  });

  it('honours the free-form style sentence when style === "free-form"', () => {
    const out = buildPerCardStyleHeader({
      style: 'free-form',
      styleFreeForm: 'risograph print, two-colour, halftone',
      brightness: 'bright',
      detail: 'clean',
    });
    expect(out).toContain('STYLE — CUSTOM');
    expect(out).toContain('risograph print, two-colour, halftone');
  });

  it('falls back to the cartoon style when free-form is selected with no sentence', () => {
    const out = buildPerCardStyleHeader({
      style: 'free-form',
      styleFreeForm: '   ',
      brightness: 'bright',
      detail: 'clean',
    });
    expect(out).toContain('STYLE — CARTOON / STICKER');
  });

  it('plugs into the per-card prompt builder as the styleHeader', () => {
    const header = buildPerCardStyleHeader({
      style: 'photoreal',
      brightness: 'bright',
      detail: 'clean',
    });
    const prompt = buildPerCardPrompt({
      card: card(1, 'X', 'a vintage radio'),
      styleHeader: header,
      cardShape: 'circle',
    });
    expect(prompt.indexOf('STYLE — PHOTOREAL')).toBeLessThan(prompt.indexOf('SINGLE-CARD'));
  });
});
