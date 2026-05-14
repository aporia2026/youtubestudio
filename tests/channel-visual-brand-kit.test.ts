import { afterEach, describe, expect, it } from 'vitest';
import {
  parseVisualBrandKit,
  isVisualBrandKitNonEmpty,
  resolveBrandKitForRender,
  isAllowedLogoUrl,
  VISUAL_BRAND_KIT_VERSION,
} from '@/lib/channel-visual-brand-kit';
import { ALLOWED_FONT_FAMILIES } from '@/remotion/fonts';
import { DEFAULT_BRAND_KIT } from '@/remotion/types';

describe('parseVisualBrandKit', () => {
  it('returns defaults for non-objects', () => {
    expect(parseVisualBrandKit(null)).toEqual({ v: VISUAL_BRAND_KIT_VERSION });
    expect(parseVisualBrandKit(undefined)).toEqual({ v: VISUAL_BRAND_KIT_VERSION });
    expect(parseVisualBrandKit('hi')).toEqual({ v: VISUAL_BRAND_KIT_VERSION });
    expect(parseVisualBrandKit(42)).toEqual({ v: VISUAL_BRAND_KIT_VERSION });
    expect(parseVisualBrandKit([])).toEqual({ v: VISUAL_BRAND_KIT_VERSION });
  });

  it('rejects a version mismatch (forward compat)', () => {
    expect(parseVisualBrandKit({ v: 99, fontFamily: 'Inter' })).toEqual({
      v: VISUAL_BRAND_KIT_VERSION,
    });
  });

  it('treats a missing v as v=1 (the legacy `{}` default)', () => {
    expect(parseVisualBrandKit({ fontFamily: 'Inter' })).toEqual({
      v: 1,
      fontFamily: 'Inter',
    });
  });

  // ─── Font allowlist (the security-critical part) ────────────────────────

  it('accepts every name in the curated registry', () => {
    for (const name of ALLOWED_FONT_FAMILIES) {
      expect(parseVisualBrandKit({ fontFamily: name }).fontFamily).toBe(name);
      expect(parseVisualBrandKit({ titleFontFamily: name }).titleFontFamily).toBe(name);
    }
  });

  it('drops font names outside the allowlist', () => {
    expect(parseVisualBrandKit({ fontFamily: 'Comic Sans MS' }).fontFamily).toBeUndefined();
    expect(parseVisualBrandKit({ fontFamily: 'system-ui' }).fontFamily).toBeUndefined();
    // Common injection shapes — they parse off the allowlist, not because
    // of CSS escaping, but because the allowlist is whole-string equality.
    expect(parseVisualBrandKit({ fontFamily: '<script>alert(1)</script>' }).fontFamily).toBeUndefined();
    expect(parseVisualBrandKit({ fontFamily: 'Inter, javascript:alert(1)' }).fontFamily).toBeUndefined();
  });

  it('drops non-string font values', () => {
    expect(parseVisualBrandKit({ fontFamily: 42 }).fontFamily).toBeUndefined();
    expect(parseVisualBrandKit({ fontFamily: null }).fontFamily).toBeUndefined();
    expect(parseVisualBrandKit({ fontFamily: ['Inter'] }).fontFamily).toBeUndefined();
    expect(parseVisualBrandKit({ fontFamily: { name: 'Inter' } }).fontFamily).toBeUndefined();
  });

  // ─── Hex color validation ────────────────────────────────────────────────

  it('accepts well-formed six-digit hex colors (both cases)', () => {
    const k = parseVisualBrandKit({
      primaryColor: '#ff0000',
      secondaryColor: '#ABCDEF',
      backgroundColor: '#FfFfFf',
      textColor: '#111111',
      titleColor: '#0a0b0c',
    });
    expect(k.primaryColor).toBe('#ff0000');
    expect(k.secondaryColor).toBe('#ABCDEF');
    expect(k.backgroundColor).toBe('#FfFfFf');
    expect(k.textColor).toBe('#111111');
    expect(k.titleColor).toBe('#0a0b0c');
  });

  it('drops malformed colors (short-form, missing #, non-hex chars, length cheats)', () => {
    expect(parseVisualBrandKit({ primaryColor: '#abc' }).primaryColor).toBeUndefined();
    expect(parseVisualBrandKit({ primaryColor: 'ff0000' }).primaryColor).toBeUndefined();
    expect(parseVisualBrandKit({ primaryColor: '#gg0000' }).primaryColor).toBeUndefined();
    expect(parseVisualBrandKit({ primaryColor: '#ff00000' }).primaryColor).toBeUndefined();
    expect(parseVisualBrandKit({ primaryColor: 'rgb(255,0,0)' }).primaryColor).toBeUndefined();
    expect(
      parseVisualBrandKit({ primaryColor: '#ff0000; background-image: url(x)' }).primaryColor,
    ).toBeUndefined();
  });

  // ─── Logo URL allowlist ─────────────────────────────────────────────────
  //
  // The allowlist depends on R2_IMAGES_PUBLIC_URL — those branches need
  // env var setup/teardown. Static r2.cloudflarestorage.com hosts always
  // pass regardless of env.

  describe('logo URL', () => {
    afterEach(() => {
      delete process.env.R2_IMAGES_PUBLIC_URL;
    });

    it('accepts r2.cloudflarestorage.com URLs', () => {
      const k = parseVisualBrandKit({
        logoUrl: 'https://abc.r2.cloudflarestorage.com/channel-logos/xyz.png',
      });
      expect(k.logoUrl).toBe('https://abc.r2.cloudflarestorage.com/channel-logos/xyz.png');
    });

    it('accepts the env-var public URL host when configured', () => {
      process.env.R2_IMAGES_PUBLIC_URL = 'https://images.example.com';
      const k = parseVisualBrandKit({
        logoUrl: 'https://images.example.com/channel-logos/xyz.png',
      });
      expect(k.logoUrl).toBe('https://images.example.com/channel-logos/xyz.png');
    });

    it('rejects non-allowlisted hosts even when they look R2-ish', () => {
      expect(
        parseVisualBrandKit({
          logoUrl: 'https://evil.example.com/logo.png',
        }).logoUrl,
      ).toBeUndefined();
      expect(
        parseVisualBrandKit({
          logoUrl: 'https://r2.cloudflarestorage.com.evil.example.com/logo.png',
        }).logoUrl,
      ).toBeUndefined();
    });

    it('rejects dangerous protocols outright', () => {
      expect(
        parseVisualBrandKit({ logoUrl: 'javascript:alert(1)' }).logoUrl,
      ).toBeUndefined();
      expect(
        parseVisualBrandKit({ logoUrl: 'data:image/png;base64,AAA' }).logoUrl,
      ).toBeUndefined();
      expect(
        parseVisualBrandKit({ logoUrl: 'file:///etc/passwd' }).logoUrl,
      ).toBeUndefined();
    });

    it('isAllowedLogoUrl handles malformed inputs without throwing', () => {
      expect(isAllowedLogoUrl('')).toBe(false);
      expect(isAllowedLogoUrl('not-a-url')).toBe(false);
      expect(isAllowedLogoUrl('https://')).toBe(false);
      // Malformed env var must not crash the check.
      process.env.R2_IMAGES_PUBLIC_URL = 'not a url';
      expect(isAllowedLogoUrl('https://abc.r2.cloudflarestorage.com/x')).toBe(true);
    });
  });

  // ─── Channel name + general field shapes ────────────────────────────────

  it('trims and length-caps the channel display name', () => {
    expect(parseVisualBrandKit({ channelName: '  TechFlow  ' }).channelName).toBe('TechFlow');
    expect(parseVisualBrandKit({ channelName: '' }).channelName).toBeUndefined();
    expect(parseVisualBrandKit({ channelName: '   ' }).channelName).toBeUndefined();
    const long = 'a'.repeat(200);
    const k = parseVisualBrandKit({ channelName: long });
    expect(k.channelName).toBeDefined();
    expect(k.channelName!.length).toBeLessThanOrEqual(80);
  });

  it('silently drops unknown extra keys', () => {
    const k = parseVisualBrandKit({
      v: 1,
      fontFamily: 'Inter',
      __proto__: { polluted: true },
      shouldBeIgnored: 'whatever',
    } as unknown);
    expect(k).toEqual({ v: 1, fontFamily: 'Inter' });
    expect((k as unknown as Record<string, unknown>).shouldBeIgnored).toBeUndefined();
  });
});

describe('isVisualBrandKitNonEmpty', () => {
  it('returns false for the empty v1 kit', () => {
    expect(isVisualBrandKitNonEmpty({ v: 1 })).toBe(false);
  });

  it('returns true once any field is set', () => {
    expect(isVisualBrandKitNonEmpty({ v: 1, fontFamily: 'Inter' })).toBe(true);
    expect(isVisualBrandKitNonEmpty({ v: 1, primaryColor: '#ff0000' })).toBe(true);
    expect(isVisualBrandKitNonEmpty({ v: 1, channelName: 'TechFlow' })).toBe(true);
    expect(isVisualBrandKitNonEmpty({ v: 1, logoUrl: 'https://abc.r2.cloudflarestorage.com/x' })).toBe(true);
  });
});

describe('resolveBrandKitForRender', () => {
  it('returns DEFAULT_BRAND_KIT when both layers are null', () => {
    expect(resolveBrandKitForRender(null, null)).toEqual(DEFAULT_BRAND_KIT);
  });

  it('applies the channel layer over the default', () => {
    const merged = resolveBrandKitForRender(
      { v: 1, primaryColor: '#ff0000', channelName: 'TechFlow' },
      null,
    );
    expect(merged.primaryColor).toBe('#ff0000');
    expect(merged.channelName).toBe('TechFlow');
    // Untouched fields keep their default values.
    expect(merged.backgroundColor).toBe(DEFAULT_BRAND_KIT.backgroundColor);
  });

  it('applies the override on top of the channel layer', () => {
    const merged = resolveBrandKitForRender(
      { v: 1, primaryColor: '#ff0000', channelName: 'TechFlow' },
      { v: 1, primaryColor: '#00ff00' },
    );
    expect(merged.primaryColor).toBe('#00ff00');
    expect(merged.channelName).toBe('TechFlow'); // unchanged by the override
  });

  it('expands font registry names into CSS fallback stacks', () => {
    const merged = resolveBrandKitForRender(
      { v: 1, fontFamily: 'Patrick Hand', titleFontFamily: 'Anton' },
      null,
    );
    // The Remotion-side family from @remotion/google-fonts is in there,
    // plus a generic fallback so a CDN hiccup never produces an unreadable
    // glyph fallback.
    expect(merged.fontFamily).toMatch(/Patrick Hand/);
    expect(merged.fontFamily).toMatch(/cursive|sans-serif|serif|monospace/);
    expect(merged.titleFontFamily).toMatch(/Anton/);
    expect(merged.titleFontFamily).toMatch(/Impact|sans-serif/);
  });

  it('falls through to default font stack on an unknown family (defence-in-depth)', () => {
    const merged = resolveBrandKitForRender(
      { v: 1, fontFamily: 'NotARealFont' as never },
      null,
    );
    // resolveFontStack returns the Inter stack for unknown families.
    expect(merged.fontFamily).toMatch(/Inter/);
  });
});
