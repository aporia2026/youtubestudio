import { describe, expect, it } from 'vitest';
import {
  YOUTUBE_CATEGORIES,
  DEFAULT_YOUTUBE_CATEGORY_ID,
  findYoutubeCategory,
  isValidYoutubeCategoryId,
} from '@/lib/youtube-categories';

describe('youtube-categories', () => {
  it('exposes a non-empty frozen list with stable IDs', () => {
    expect(YOUTUBE_CATEGORIES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(YOUTUBE_CATEGORIES)).toBe(true);
    for (const cat of YOUTUBE_CATEGORIES) {
      expect(cat.id).toMatch(/^\d+$/);
      expect(cat.label.length).toBeGreaterThan(0);
      expect(cat.hint.length).toBeGreaterThan(0);
    }
  });

  it('includes Education (27) — the documented default for explainer shorts', () => {
    expect(DEFAULT_YOUTUBE_CATEGORY_ID).toBe('27');
    expect(findYoutubeCategory('27')?.label).toBe('Education');
  });

  it('returns null for unknown ids', () => {
    expect(findYoutubeCategory('999')).toBeNull();
    expect(findYoutubeCategory('')).toBeNull();
    expect(findYoutubeCategory(null)).toBeNull();
    expect(findYoutubeCategory(undefined)).toBeNull();
  });

  it('validates assignable ids', () => {
    expect(isValidYoutubeCategoryId('22')).toBe(true);  // People & Blogs
    expect(isValidYoutubeCategoryId('27')).toBe(true);  // Education
    expect(isValidYoutubeCategoryId('30')).toBe(false); // Movies — not assignable
    expect(isValidYoutubeCategoryId(null)).toBe(false);
  });
});
