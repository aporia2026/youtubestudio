/**
 * Tolerance tests for the rowify parser.
 *
 * The user has hit rows[N].visual_type validation failures REPEATEDLY
 * because models routinely return values like "Animation", "AI Image",
 * "stock footage", etc. instead of the canonical 4 enum values. These
 * tests pin down the normalizer's behavior so a future "tighten this
 * back up" refactor can't silently re-break the operator experience.
 *
 * Also covers timecode normalization, per-row salvage, and the
 * partial-failure "drop bad rows but keep going" mode.
 *
 * See src/lib/channel-clone/rowify-runner.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeTimecode,
  normalizeVisualType,
  parseRowifyResponse,
} from '@/lib/channel-clone/rowify-runner';

describe('normalizeVisualType: canonical pass-through', () => {
  it('returns the exact canonical values unchanged', () => {
    expect(normalizeVisualType('ai_image')).toBe('ai_image');
    expect(normalizeVisualType('stock')).toBe('stock');
    expect(normalizeVisualType('overlay')).toBe('overlay');
    expect(normalizeVisualType('Title Card')).toBe('Title Card');
  });
});

describe('normalizeVisualType: maps common LLM variants', () => {
  it('handles "Animation" (the main pipeline\'s value)', () => {
    expect(normalizeVisualType('Animation')).toBe('ai_image');
    expect(normalizeVisualType('animation')).toBe('ai_image');
  });

  it('handles "image" and synonyms → ai_image', () => {
    expect(normalizeVisualType('image')).toBe('ai_image');
    expect(normalizeVisualType('Image')).toBe('ai_image');
    expect(normalizeVisualType('illustration')).toBe('ai_image');
    expect(normalizeVisualType('photo')).toBe('ai_image');
    expect(normalizeVisualType('graphic')).toBe('ai_image');
    expect(normalizeVisualType('still')).toBe('ai_image');
    expect(normalizeVisualType('shot')).toBe('ai_image');
    expect(normalizeVisualType('scene')).toBe('ai_image');
  });

  it('handles spacing / punctuation variants', () => {
    expect(normalizeVisualType('AI Image')).toBe('ai_image');
    expect(normalizeVisualType('ai-image')).toBe('ai_image');
    expect(normalizeVisualType('AiImage')).toBe('ai_image');
    expect(normalizeVisualType('AI_IMAGE')).toBe('ai_image');
  });

  it('handles stock synonyms', () => {
    expect(normalizeVisualType('Stock')).toBe('stock');
    expect(normalizeVisualType('stock footage')).toBe('stock');
    expect(normalizeVisualType('stock_footage')).toBe('stock');
    expect(normalizeVisualType('Stock Image')).toBe('stock');
    expect(normalizeVisualType('Footage')).toBe('stock');
  });

  it('handles overlay synonyms', () => {
    expect(normalizeVisualType('Overlay')).toBe('overlay');
    expect(normalizeVisualType('text overlay')).toBe('overlay');
    expect(normalizeVisualType('text_overlay')).toBe('overlay');
    expect(normalizeVisualType('callout')).toBe('overlay');
    expect(normalizeVisualType('caption')).toBe('overlay');
  });

  it('handles Title Card synonyms', () => {
    expect(normalizeVisualType('title_card')).toBe('Title Card');
    expect(normalizeVisualType('title-card')).toBe('Title Card');
    expect(normalizeVisualType('TitleCard')).toBe('Title Card');
    expect(normalizeVisualType('title card')).toBe('Title Card');
    expect(normalizeVisualType('Heading')).toBe('Title Card');
    expect(normalizeVisualType('Section Title')).toBe('Title Card');
    expect(normalizeVisualType('section divider')).toBe('Title Card');
  });

  it('handles noisy / parenthesized values via substring fallback', () => {
    expect(normalizeVisualType('Animation (still)')).toBe('ai_image');
    expect(normalizeVisualType('Stock — landscape')).toBe('stock');
    expect(normalizeVisualType('Title Card / heading')).toBe('Title Card');
  });

  it('defaults to ai_image when nothing matches (safest fallback)', () => {
    expect(normalizeVisualType('mystery-genre')).toBe('ai_image');
    expect(normalizeVisualType('')).toBe('ai_image');
    expect(normalizeVisualType(null)).toBe('ai_image');
    expect(normalizeVisualType(undefined)).toBe('ai_image');
    expect(normalizeVisualType(42)).toBe('ai_image');
  });
});

describe('normalizeTimecode', () => {
  it('passes canonical "M:SS-M:SS" through unchanged', () => {
    expect(normalizeTimecode('0:00-0:03')).toBe('0:00-0:03');
    expect(normalizeTimecode('1:23-1:30')).toBe('1:23-1:30');
    expect(normalizeTimecode('12:45-13:00')).toBe('12:45-13:00');
  });

  it('zero-pads seconds when the LLM forgot', () => {
    expect(normalizeTimecode('0:0-0:3')).toBe('0:00-0:03');
    expect(normalizeTimecode('1:5-1:8')).toBe('1:05-1:08');
  });

  it('strips leading zeros from minutes ("00:00-00:03" → "0:00-0:03")', () => {
    expect(normalizeTimecode('00:00-00:03')).toBe('0:00-0:03');
    expect(normalizeTimecode('01:23-01:30')).toBe('1:23-1:30');
  });

  it('handles surrounding whitespace + en-dash + " to "', () => {
    expect(normalizeTimecode(' 0:00 - 0:03 ')).toBe('0:00-0:03');
    expect(normalizeTimecode('0:00 to 0:03')).toBe('0:00-0:03');
    expect(normalizeTimecode('0:00–0:03')).toBe('0:00-0:03'); // en-dash
    expect(normalizeTimecode('0:00—0:03')).toBe('0:00-0:03'); // em-dash
  });

  it('returns null on truly unparseable input', () => {
    expect(normalizeTimecode('')).toBeNull();
    expect(normalizeTimecode('garbage')).toBeNull();
    expect(normalizeTimecode('0:99-0:99')).toBeNull(); // seconds >= 60
    expect(normalizeTimecode(null)).toBeNull();
    expect(normalizeTimecode(42)).toBeNull();
  });
});

describe('parseRowifyResponse: tolerates LLM schema drift', () => {
  it('accepts rows with "Animation" as visual_type (the actual reported failure)', () => {
    const raw = JSON.stringify({
      rows: [{
        timecode: '0:00-0:03',
        script_text: 'Hook line',
        visual_type: 'Animation',
        visual_description: 'A doodle of a face',
        ai_image_prompt: 'doodle of a face',
        stock_search_terms: '',
        on_screen_text: '',
        notes: '',
      }],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].visual_type).toBe('ai_image');
  });

  it('accepts "AI Image" + recovers missing on_screen_text', () => {
    const raw = JSON.stringify({
      rows: [{
        timecode: '0:00-0:03',
        script_text: 'Some line',
        visual_type: 'AI Image',
        visual_description: 'A scene',
        ai_image_prompt: 'cinematic',
        stock_search_terms: '',
        on_screen_text: '',
        notes: '',
      }],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows[0].visual_type).toBe('ai_image');
  });

  it('synthesizes a timecode when the LLM provides none', () => {
    const raw = JSON.stringify({
      rows: [
        { script_text: 'first', visual_type: 'ai_image', visual_description: '', ai_image_prompt: 'p', stock_search_terms: '', on_screen_text: '', notes: '' },
        { script_text: 'second', visual_type: 'ai_image', visual_description: '', ai_image_prompt: 'p', stock_search_terms: '', on_screen_text: '', notes: '' },
      ],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0].timecode).toMatch(/^\d+:\d{2}-\d+:\d{2}$/);
    expect(rows[1].timecode).toMatch(/^\d+:\d{2}-\d+:\d{2}$/);
    // Second row's start should be the first row's end (cumulative).
    expect(rows[0].timecode).toBe('0:00-0:03');
    expect(rows[1].timecode).toBe('0:03-0:06');
  });

  it('handles "0:00 - 0:03" with spaces around the dash', () => {
    const raw = JSON.stringify({
      rows: [{ timecode: '0:00 - 0:03', script_text: 'x', visual_type: 'ai_image', visual_description: '', ai_image_prompt: 'p', stock_search_terms: '', on_screen_text: '', notes: '' }],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows[0].timecode).toBe('0:00-0:03');
  });

  it('fills ai_image_prompt with description when the LLM forgot', () => {
    const raw = JSON.stringify({
      rows: [{
        timecode: '0:00-0:03',
        script_text: 'Hello world',
        visual_type: 'ai_image',
        visual_description: 'A face',
        ai_image_prompt: '',
        stock_search_terms: '',
        on_screen_text: '',
        notes: '',
      }],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows[0].ai_image_prompt).toBe('A face');
  });

  it('falls back to script_text for ai_image_prompt when even description is empty', () => {
    const raw = JSON.stringify({
      rows: [{
        timecode: '0:00-0:03',
        script_text: 'Hello world',
        visual_type: 'ai_image',
        visual_description: '',
        ai_image_prompt: '',
        stock_search_terms: '',
        on_screen_text: '',
        notes: '',
      }],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows[0].ai_image_prompt).toContain('Hello world');
  });

  it('synthesizes stock_search_terms for stock rows when the LLM forgot', () => {
    const raw = JSON.stringify({
      rows: [{
        timecode: '0:00-0:03',
        script_text: 'A line about lions',
        visual_type: 'stock',
        visual_description: 'Lion in savannah',
        ai_image_prompt: '',
        stock_search_terms: '',
        on_screen_text: '',
        notes: '',
      }],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows[0].stock_search_terms.length).toBeGreaterThan(0);
  });

  it('synthesizes on_screen_text for overlay rows', () => {
    const raw = JSON.stringify({
      rows: [{
        timecode: '0:00-0:03',
        script_text: 'Three words here',
        visual_type: 'overlay',
        visual_description: '',
        ai_image_prompt: '',
        stock_search_terms: '',
        on_screen_text: '',
        notes: '',
      }],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows[0].on_screen_text.length).toBeGreaterThan(0);
  });

  it('completes a Title Card row from script_text alone', () => {
    const raw = JSON.stringify({
      rows: [{
        timecode: '0:00-0:03',
        script_text: 'Section 1',
        visual_type: 'Title Card',
        visual_description: '',
        ai_image_prompt: 'should be wiped',
        stock_search_terms: 'should be wiped',
        on_screen_text: '',
        notes: '',
      }],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows[0].visual_type).toBe('Title Card');
    expect(rows[0].on_screen_text).toBe('Section 1');
    expect(rows[0].visual_description).toContain('Section 1');
    expect(rows[0].ai_image_prompt).toBe('');
    expect(rows[0].stock_search_terms).toBe('');
  });

  it('drops rows with empty script_text but keeps the rest', () => {
    const raw = JSON.stringify({
      rows: [
        { script_text: 'first', visual_type: 'ai_image', visual_description: '', ai_image_prompt: 'p', stock_search_terms: '', on_screen_text: '', notes: '' },
        { script_text: '', visual_type: 'ai_image', visual_description: '', ai_image_prompt: 'p', stock_search_terms: '', on_screen_text: '', notes: '' },
        { script_text: 'third', visual_type: 'ai_image', visual_description: '', ai_image_prompt: 'p', stock_search_terms: '', on_screen_text: '', notes: '' },
      ],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0].script_text).toBe('first');
    expect(rows[1].script_text).toBe('third');
  });

  it('coerces non-string fields rather than dropping the row', () => {
    const raw = JSON.stringify({
      rows: [{
        timecode: '0:00-0:03',
        script_text: 'a line',
        visual_type: 'ai_image',
        visual_description: null,
        ai_image_prompt: 42,           // wrong type — should coerce or fall back
        stock_search_terms: undefined,
        on_screen_text: null,
        notes: null,
      }],
    });
    const rows = parseRowifyResponse(raw);
    expect(rows).toHaveLength(1);
  });

  it('throws only when EVERY row is unsalvageable', () => {
    const raw = JSON.stringify({
      rows: [
        { script_text: '', visual_type: 'ai_image' },
        { script_text: null, visual_type: 'ai_image' },
        { script_text: '   ', visual_type: 'ai_image' }, // whitespace only
        'not-an-object',                                  // wrong shape entirely
      ],
    });
    expect(() => parseRowifyResponse(raw)).toThrow(/every row failed/);
  });

  it('still throws on the "rows is empty" structural failure', () => {
    expect(() => parseRowifyResponse(JSON.stringify({ rows: [] }))).toThrow(/rows must not be empty/);
  });

  it('still throws on the "rows is not an array" structural failure', () => {
    expect(() => parseRowifyResponse(JSON.stringify({ rows: {} }))).toThrow(/rows must be an array/);
  });
});
