import { describe, expect, it } from 'vitest';
import { isWhiteBackgroundSketchStyle } from '@/lib/sketch-style';

describe('isWhiteBackgroundSketchStyle', () => {
  it('returns true for the four bundled sketch styles', () => {
    expect(isWhiteBackgroundSketchStyle('doodle_explainer')).toBe(true);
    expect(isWhiteBackgroundSketchStyle('doodle_explainer_2')).toBe(true);
    expect(isWhiteBackgroundSketchStyle('paint_explainer_v1')).toBe(true);
    expect(isWhiteBackgroundSketchStyle('whiteboard')).toBe(true);
  });

  it('returns false for photo / cinematic / stock styles', () => {
    expect(isWhiteBackgroundSketchStyle('cinematic')).toBe(false);
    expect(isWhiteBackgroundSketchStyle('animation_2d')).toBe(false);
    expect(isWhiteBackgroundSketchStyle('animation_3d')).toBe(false);
    expect(isWhiteBackgroundSketchStyle('documentary')).toBe(false);
    expect(isWhiteBackgroundSketchStyle('stock')).toBe(false);
    expect(isWhiteBackgroundSketchStyle('tech')).toBe(false);
    expect(isWhiteBackgroundSketchStyle('viral')).toBe(false);
  });

  it('returns false for user-defined styles (UUIDs)', () => {
    // User styles could be anything; defaulting to false avoids
    // silently white-filling a style the user expected AI to inpaint.
    expect(isWhiteBackgroundSketchStyle('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isWhiteBackgroundSketchStyle('custom-style-id')).toBe(false);
  });

  it('returns false for empty / null / undefined', () => {
    expect(isWhiteBackgroundSketchStyle(undefined)).toBe(false);
    expect(isWhiteBackgroundSketchStyle(null)).toBe(false);
    expect(isWhiteBackgroundSketchStyle('')).toBe(false);
  });

  it('is case-sensitive — capitalised variants do not match', () => {
    // The style registry uses canonical lowercase ids; capitalised
    // input means a caller passed a label by mistake. We don't
    // silently normalise — that hides bugs at the call site.
    expect(isWhiteBackgroundSketchStyle('Doodle_Explainer')).toBe(false);
    expect(isWhiteBackgroundSketchStyle('WHITEBOARD')).toBe(false);
  });
});
