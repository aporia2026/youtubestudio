import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THUMBNAIL_STYLE_ID,
  resolveThumbnailStyle,
  THUMBNAIL_STYLES,
} from '@/lib/thumbnail-styles';

describe('THUMBNAIL_STYLES', () => {
  it('has at least one entry', () => {
    expect(THUMBNAIL_STYLES.length).toBeGreaterThan(0);
  });

  it('every entry has the required fields', () => {
    for (const s of THUMBNAIL_STYLES) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.ai_image_suffix).toBeTruthy();
      expect(s.preferred_image_model).toBeTruthy();
    }
  });

  it('has no duplicate ids', () => {
    const ids = THUMBNAIL_STYLES.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the paint_explainer_v1_doodle entry', () => {
    expect(THUMBNAIL_STYLES.some(s => s.id === 'paint_explainer_v1_doodle')).toBe(true);
  });

  it('paint_explainer_v1_doodle has the typography contract baked in', () => {
    const style = THUMBNAIL_STYLES.find(s => s.id === 'paint_explainer_v1_doodle');
    expect(style).toBeDefined();
    // The hook typography is the signature element — losing it breaks
    // the entire style. Guard against accidental edits stripping it.
    expect(style!.ai_image_suffix).toMatch(/yellow/i);
    expect(style!.ai_image_suffix).toMatch(/black/i);
    expect(style!.ai_image_suffix).toMatch(/comic-bold|bold/i);
    // Hook + character expression are both load-bearing
    expect(style!.ai_image_suffix).toMatch(/hook/i);
    expect(style!.ai_image_suffix).toMatch(/emotion/i);
    // Forbidden look-alikes — the style is explicitly NOT these
    expect(style!.ai_image_suffix.toLowerCase()).toContain('no gradient');
    expect(style!.ai_image_suffix.toLowerCase()).toContain('no drop shadow');
  });

  it('paint_explainer_v1_doodle prefers Kie GPT Image 2 (per user spec 2026-06-09)', () => {
    const style = THUMBNAIL_STYLES.find(s => s.id === 'paint_explainer_v1_doodle');
    expect(style!.preferred_image_model).toBe('gpt-image-2-t2i');
  });

  it('paint_explainer_v1_doodle exposes structured character expressions', () => {
    const style = THUMBNAIL_STYLES.find(s => s.id === 'paint_explainer_v1_doodle');
    expect(Array.isArray(style!.supported_character_expressions)).toBe(true);
    expect(style!.supported_character_expressions!.length).toBeGreaterThan(0);
  });

  it('paint_explainer_v1_doodle exposes background-scene presets including custom', () => {
    const style = THUMBNAIL_STYLES.find(s => s.id === 'paint_explainer_v1_doodle');
    expect(Array.isArray(style!.supported_background_scenes)).toBe(true);
    expect(style!.supported_background_scenes!.some(s => s.id === 'custom')).toBe(true);
  });
});

describe('resolveThumbnailStyle', () => {
  it('returns the entry for a known id', () => {
    const s = resolveThumbnailStyle('paint_explainer_v1_doodle');
    expect(s?.id).toBe('paint_explainer_v1_doodle');
  });

  it('returns undefined for an unknown id', () => {
    expect(resolveThumbnailStyle('does_not_exist')).toBeUndefined();
  });

  it('returns undefined for null / undefined / empty', () => {
    expect(resolveThumbnailStyle(null)).toBeUndefined();
    expect(resolveThumbnailStyle(undefined)).toBeUndefined();
    expect(resolveThumbnailStyle('')).toBeUndefined();
  });
});

describe('DEFAULT_THUMBNAIL_STYLE_ID', () => {
  it('resolves to a real registry entry', () => {
    expect(resolveThumbnailStyle(DEFAULT_THUMBNAIL_STYLE_ID)).toBeDefined();
  });
});
