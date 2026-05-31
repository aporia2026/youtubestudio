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

  it('every entry has both bundled files on disk (TTF + WOFF2)', () => {
    // The integration safety net for the download script. If the
    // script wasn't run after a registry add — OR if a future change
    // accidentally drops one format — this fires.
    const bundledDir = path.join(process.cwd(), 'public/fonts/thumbnail-grid');
    for (const f of THUMBNAIL_FONTS) {
      const ttfPath = fontFilePath(f);
      expect(fs.existsSync(ttfPath), `${f.id} TTF: ${ttfPath}`).toBe(true);
      const ttfStats = fs.statSync(ttfPath);
      expect(ttfStats.size, `${f.id} TTF size`).toBeGreaterThan(1024);

      const webPath = path.join(bundledDir, f.webFile);
      expect(fs.existsSync(webPath), `${f.id} WOFF2: ${webPath}`).toBe(true);
      const webStats = fs.statSync(webPath);
      expect(webStats.size, `${f.id} WOFF2 size`).toBeGreaterThan(1024);
    }
  });

  it('file extension contract: file is .ttf, webFile is .woff2', () => {
    // Server-side Pango on Vercel's prebuilt sharp cannot decode WOFF2
    // (FreeType wasn't built with brotli). The TTF / WOFF2 split is
    // load-bearing — pin the contract so a future renamer can't
    // accidentally point `file` back at a WOFF2.
    for (const f of THUMBNAIL_FONTS) {
      expect(f.file.endsWith('.ttf'), `${f.id} file must end in .ttf`).toBe(true);
      expect(f.webFile.endsWith('.woff2'), `${f.id} webFile must end in .woff2`).toBe(true);
    }
  });

  it('fontBrowserUrl serves the WOFF2 variant under /public/fonts/thumbnail-grid/', () => {
    const sample = THUMBNAIL_FONTS[0];
    expect(fontBrowserUrl(sample)).toBe(`/fonts/thumbnail-grid/${sample.webFile}`);
    expect(fontBrowserUrl(sample).endsWith('.woff2')).toBe(true);
  });

  it('fontFilePath resolves to the TTF absolute path under process.cwd()', () => {
    const sample = THUMBNAIL_FONTS[0];
    const expected = path.join(process.cwd(), 'public/fonts/thumbnail-grid', sample.file);
    expect(fontFilePath(sample)).toBe(expected);
    expect(fontFilePath(sample).endsWith('.ttf')).toBe(true);
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
