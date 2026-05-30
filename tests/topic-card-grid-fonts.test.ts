import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FONT_ID,
  findFontById,
  fontBrowserUrl,
  THUMBNAIL_FONTS,
  THUMBNAIL_FONT_CATEGORIES,
  THUMBNAIL_FONT_CATEGORY_LABELS,
  type ThumbnailFont,
} from '@/lib/thumbnail-formats/topic-card-grid-fonts';
import { fontFilePath } from '@/lib/thumbnail-formats/topic-card-grid-fonts-server';

describe('THUMBNAIL_FONTS registry', () => {
  it('contains exactly 22 entries (the curated picker set)', () => {
    expect(THUMBNAIL_FONTS).toHaveLength(22);
  });

  it('every entry has a unique kebab-case id', () => {
    const ids = THUMBNAIL_FONTS.map((f) => f.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('every entry has a non-empty SIL family name', () => {
    for (const f of THUMBNAIL_FONTS) {
      expect(f.family.length, `${f.id} family`).toBeGreaterThan(0);
    }
  });

  it('every entry references one of the declared categories', () => {
    const known = new Set<string>(THUMBNAIL_FONT_CATEGORIES);
    for (const f of THUMBNAIL_FONTS) {
      expect(known.has(f.category), `${f.id} category`).toBe(true);
    }
  });

  it('every category has at least one font (no empty optgroups)', () => {
    for (const cat of THUMBNAIL_FONT_CATEGORIES) {
      const inCat = THUMBNAIL_FONTS.filter((f) => f.category === cat);
      expect(inCat.length, `${cat} should not be empty`).toBeGreaterThan(0);
    }
  });

  it('every category has a human-readable label', () => {
    for (const cat of THUMBNAIL_FONT_CATEGORIES) {
      expect(THUMBNAIL_FONT_CATEGORY_LABELS[cat].length).toBeGreaterThan(0);
    }
  });

  it('every entry has a corresponding bundled file on disk', () => {
    // The integration safety net for the download script. If the
    // script wasn't run after a registry add, this fires.
    for (const f of THUMBNAIL_FONTS) {
      const onDisk = fontFilePath(f);
      expect(fs.existsSync(onDisk), `${f.id}: ${onDisk}`).toBe(true);
      const stats = fs.statSync(onDisk);
      expect(stats.size, `${f.id} file size`).toBeGreaterThan(1024);
    }
  });

  it('fontBrowserUrl serves files from /public/fonts/thumbnail-grid/', () => {
    const sample = THUMBNAIL_FONTS[0];
    expect(fontBrowserUrl(sample)).toBe(`/fonts/thumbnail-grid/${sample.file}`);
  });

  it('fontFilePath resolves absolute paths under process.cwd()', () => {
    const sample = THUMBNAIL_FONTS[0];
    const expected = path.join(process.cwd(), 'public/fonts/thumbnail-grid', sample.file);
    expect(fontFilePath(sample)).toBe(expected);
  });
});

describe('DEFAULT_FONT_ID', () => {
  it('resolves to a known registry entry', () => {
    expect(findFontById(DEFAULT_FONT_ID)).not.toBeNull();
  });

  it('is "patrick-hand" so existing flows match the bundled reference', () => {
    expect(DEFAULT_FONT_ID).toBe('patrick-hand');
  });

  it('Patrick Hand sits in the hand-drawn category', () => {
    const ph = findFontById('patrick-hand') as ThumbnailFont;
    expect(ph.category).toBe('hand-drawn');
  });
});

describe('findFontById', () => {
  it('returns the matching entry for a known id', () => {
    const entry = findFontById('bebas-neue');
    expect(entry).not.toBeNull();
    expect(entry!.family).toBe('Bebas Neue');
  });

  it('returns null for unknown ids', () => {
    expect(findFontById('not-a-font')).toBeNull();
    expect(findFontById('')).toBeNull();
    expect(findFontById(undefined)).toBeNull();
    expect(findFontById(null)).toBeNull();
  });
});
