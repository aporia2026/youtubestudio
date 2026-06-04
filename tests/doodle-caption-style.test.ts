/**
 * Unit tests for the Doodle/Paint caption-style resolver. Documents the
 * load-bearing invariant: a Short with an empty caption-style config
 * renders identically to the pre-2026-06-04 hardcoded look (yellow
 * comic-bold uppercase, 6px black outline, positionY = 0.55), and any
 * field the user sets overrides only that field.
 *
 * Plan: `_plans/2026-06-04-shorts-captions-position-and-assets-context.md`.
 */
import { describe, expect, it } from 'vitest';
import type { ShortsCaptionsStyle } from '@/lib/shorts-render-types';
import {
  DOODLE_CAPTION_DEFAULTS,
  entryEffectTransform,
  resolveDoodleCaptionStyle,
} from '@/remotion/doodle-caption-style';

describe('resolveDoodleCaptionStyle', () => {
  it('returns the doodle defaults when given undefined', () => {
    const r = resolveDoodleCaptionStyle(undefined);
    expect(r.color).toBe('#facc15');
    expect(r.outlineColor).toBe('#0f172a');
    expect(r.outlineWidth).toBe(6);
    expect(r.textTransform).toBe('uppercase');
    expect(r.positionY).toBe(0.55);
    expect(r.paddingX).toBe(64);
    expect(r.sizeScale).toBe(1);
    expect(r.fontWeight).toBe(900);
    expect(r.entryEffect).toBe('fade');
    expect(r.background).toBe('none');
  });

  it('returns the doodle defaults when given an empty object', () => {
    const r = resolveDoodleCaptionStyle({});
    expect(r).toEqual(resolveDoodleCaptionStyle(undefined));
  });

  it('applies a single field override (color) without touching others', () => {
    const r = resolveDoodleCaptionStyle({ color: '#ff0000' });
    expect(r.color).toBe('#ff0000');
    expect(r.outlineColor).toBe(DOODLE_CAPTION_DEFAULTS.outlineColor);
    expect(r.outlineWidth).toBe(DOODLE_CAPTION_DEFAULTS.outlineWidth);
    expect(r.textTransform).toBe(DOODLE_CAPTION_DEFAULTS.textTransform);
    expect(r.positionY).toBe(DOODLE_CAPTION_DEFAULTS.positionY);
  });

  it('honors the position chip choices the editor sets (top / center / bottom)', () => {
    // The editor maps Top -> 0.16, Center -> 0.5, Bottom -> 0.82.
    expect(resolveDoodleCaptionStyle({ positionY: 0.16 }).positionY).toBe(0.16);
    expect(resolveDoodleCaptionStyle({ positionY: 0.5 }).positionY).toBe(0.5);
    expect(resolveDoodleCaptionStyle({ positionY: 0.82 }).positionY).toBe(0.82);
  });

  it('clamps a hostile positionY override to the [0, 1] range', () => {
    expect(resolveDoodleCaptionStyle({ positionY: -5 }).positionY).toBe(0);
    expect(resolveDoodleCaptionStyle({ positionY: 12 }).positionY).toBe(1);
  });

  it('clamps negative outlineWidth + paddingX to zero', () => {
    expect(resolveDoodleCaptionStyle({ outlineWidth: -3 }).outlineWidth).toBe(0);
    expect(resolveDoodleCaptionStyle({ paddingX: -10 }).paddingX).toBe(0);
  });

  it('clamps sizeScale to a usable minimum so 0 does not render captions invisibly', () => {
    expect(resolveDoodleCaptionStyle({ sizeScale: 0 }).sizeScale).toBe(0.1);
    expect(resolveDoodleCaptionStyle({ sizeScale: -1 }).sizeScale).toBe(0.1);
  });

  it('applies every field at once when the user picks a full override', () => {
    const cfg: ShortsCaptionsStyle = {
      fontFamily: 'Anton',
      fontWeight: 400,
      color: '#00ffaa',
      highlightColor: '#ff00aa',
      outlineColor: '#123456',
      outlineWidth: 2,
      shadow: '0 2px 4px rgba(0,0,0,0.4)',
      textTransform: 'lowercase',
      letterSpacing: 0,
      lineHeight: 1.4,
      sizeScale: 1.3,
      positionY: 0.2,
      paddingX: 40,
      entryEffect: 'pop',
      background: 'solid',
      backgroundColor: '#222',
    };
    const r = resolveDoodleCaptionStyle(cfg);
    expect(r.fontFamily).toBe('Anton');
    expect(r.fontWeight).toBe(400);
    expect(r.color).toBe('#00ffaa');
    expect(r.highlightColor).toBe('#ff00aa');
    expect(r.outlineColor).toBe('#123456');
    expect(r.outlineWidth).toBe(2);
    expect(r.shadow).toBe('0 2px 4px rgba(0,0,0,0.4)');
    expect(r.textTransform).toBe('lowercase');
    expect(r.letterSpacing).toBe(0);
    expect(r.lineHeight).toBe(1.4);
    expect(r.sizeScale).toBe(1.3);
    expect(r.positionY).toBe(0.2);
    expect(r.paddingX).toBe(40);
    expect(r.entryEffect).toBe('pop');
    expect(r.background).toBe('solid');
    expect(r.backgroundColor).toBe('#222');
  });
});

describe('entryEffectTransform', () => {
  it('returns identity transform for the default fade effect', () => {
    const t = entryEffectTransform('fade', 100);
    expect(t.scale).toBe(1);
    expect(t.translateY).toBe(0);
  });

  it('pop effect scales from 0.6 to 1.0 over 140ms', () => {
    expect(entryEffectTransform('pop', 0).scale).toBe(0.6);
    expect(entryEffectTransform('pop', 70).scale).toBeCloseTo(0.8, 5);
    expect(entryEffectTransform('pop', 140).scale).toBe(1);
    // Past the window, it stays at the final value.
    expect(entryEffectTransform('pop', 500).scale).toBe(1);
  });

  it('slide-up effect goes from 40px below to 0 over 160ms', () => {
    expect(entryEffectTransform('slide-up', 0).translateY).toBe(40);
    expect(entryEffectTransform('slide-up', 80).translateY).toBe(20);
    expect(entryEffectTransform('slide-up', 160).translateY).toBe(0);
    expect(entryEffectTransform('slide-up', 1000).translateY).toBe(0);
  });

  it('none effect is the identity transform too', () => {
    const t = entryEffectTransform('none', 100);
    expect(t.scale).toBe(1);
    expect(t.translateY).toBe(0);
    expect(t.opacityMul).toBe(1);
  });
});
