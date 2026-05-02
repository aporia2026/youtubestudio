import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Static-asset tests for the narrator PWA. Renders no React — just
 * asserts the JSON manifest + service worker contracts that mobile
 * browsers will hold us to.
 */

function readPublic(rel: string): string {
  return readFileSync(resolve(process.cwd(), 'public', rel), 'utf8');
}

describe('narrator-manifest.json', () => {
  const json = JSON.parse(readPublic('narrator-manifest.json'));

  it('declares the required PWA fields', () => {
    expect(json.name).toMatch(/Narrator/i);
    expect(json.short_name).toBeDefined();
    expect(json.start_url).toMatch(/^\/narrator/);
    expect(json.scope).toMatch(/^\/narrator/);
    expect(json.display).toBe('standalone');
  });

  it('uses theme + background colors that match the app theme', () => {
    expect(json.theme_color).toBe('#0d0d12');
    expect(json.background_color).toBe('#0d0d12');
  });

  it('declares at least one icon and includes a maskable variant', () => {
    expect(Array.isArray(json.icons)).toBe(true);
    expect(json.icons.length).toBeGreaterThan(0);
    const maskable = json.icons.some((i: { purpose?: string }) =>
      (i.purpose ?? '').split(/\s+/).includes('maskable'),
    );
    expect(maskable).toBe(true);
  });
});

describe('narrator-sw.js', () => {
  const sw = readPublic('narrator-sw.js');

  it('exports a CACHE_VERSION token (so cache busts on deploy)', () => {
    expect(sw).toMatch(/CACHE_VERSION\s*=\s*['"]narrator-/);
  });

  it('handles install + activate + fetch lifecycle events', () => {
    expect(sw).toContain("addEventListener('install'");
    expect(sw).toContain("addEventListener('activate'");
    expect(sw).toContain("addEventListener('fetch'");
  });

  it('NEVER caches non-GET requests (uploads must hit the network)', () => {
    expect(sw).toMatch(/req\.method !== ['"]GET['"]/);
  });

  it('lets cross-origin requests pass through untouched (Vercel Blob uploads)', () => {
    expect(sw).toMatch(/url\.origin !== self\.location\.origin/);
  });

  it('uses network-first for /api/narrate/* so narration data stays fresh', () => {
    expect(sw).toMatch(/\/api\/narrate\//);
    expect(sw).toMatch(/networkFirst/);
  });

  it('declares an offline fallback page', () => {
    expect(sw).toMatch(/OFFLINE_FALLBACK\s*=\s*['"]\/narrator\/offline/);
  });

  it('purges old caches on activate', () => {
    expect(sw).toMatch(/caches\.delete/);
  });
});
