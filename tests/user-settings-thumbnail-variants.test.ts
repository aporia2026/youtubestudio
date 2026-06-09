import { describe, expect, it } from 'vitest';
import { parseUserSettings, serializeUserSettings, SETTINGS_VERSION } from '@/lib/user-settings';

/**
 * Round-trip tests for the thumbnail-variant settings fields added
 * 2026-06-09 (`thumbnail_variant_count`, `thumbnail_default_image_model`,
 * `thumbnail_default_style`, `thumbnail_variants_enabled`). Catches the
 * common "I added a field to the interface but forgot to mirror it into
 * `parseUserSettings`" bug where a saved value silently round-trips to
 * undefined.
 */

describe('parseUserSettings — thumbnail variant fields', () => {
  it('round-trips thumbnail_variant_count', () => {
    const encrypted = serializeUserSettings({ v: SETTINGS_VERSION, thumbnail_variant_count: 3 });
    const parsed = parseUserSettings(encrypted);
    expect(parsed.thumbnail_variant_count).toBe(3);
  });

  it('round-trips thumbnail_default_image_model', () => {
    const encrypted = serializeUserSettings({
      v: SETTINGS_VERSION,
      thumbnail_default_image_model: 'gpt-image-2-t2i',
    });
    const parsed = parseUserSettings(encrypted);
    expect(parsed.thumbnail_default_image_model).toBe('gpt-image-2-t2i');
  });

  it('round-trips thumbnail_default_style', () => {
    const encrypted = serializeUserSettings({
      v: SETTINGS_VERSION,
      thumbnail_default_style: 'paint_explainer_v1_doodle',
    });
    const parsed = parseUserSettings(encrypted);
    expect(parsed.thumbnail_default_style).toBe('paint_explainer_v1_doodle');
  });

  it('round-trips thumbnail_variants_enabled (true and false)', () => {
    expect(parseUserSettings(serializeUserSettings({ v: SETTINGS_VERSION, thumbnail_variants_enabled: true })).thumbnail_variants_enabled).toBe(true);
    expect(parseUserSettings(serializeUserSettings({ v: SETTINGS_VERSION, thumbnail_variants_enabled: false })).thumbnail_variants_enabled).toBe(false);
  });

  it('round-trips explicit nulls instead of dropping them', () => {
    const encrypted = serializeUserSettings({
      v: SETTINGS_VERSION,
      thumbnail_variant_count: null,
      thumbnail_default_image_model: null,
      thumbnail_default_style: null,
      thumbnail_variants_enabled: null,
    });
    const parsed = parseUserSettings(encrypted);
    expect(parsed.thumbnail_variant_count).toBeNull();
    expect(parsed.thumbnail_default_image_model).toBeNull();
    expect(parsed.thumbnail_default_style).toBeNull();
    expect(parsed.thumbnail_variants_enabled).toBeNull();
  });

  it('rejects malformed (non-number, non-string, non-boolean) values', () => {
    // parseUserSettings only accepts well-shaped values; anything else
    // is dropped so a corrupt blob can't crash the consumer.
    const encrypted = serializeUserSettings({
      v: SETTINGS_VERSION,
      // @ts-expect-error — intentionally wrong shape for the test
      thumbnail_variant_count: 'three',
      // @ts-expect-error — intentionally wrong shape for the test
      thumbnail_variants_enabled: 'yes',
    });
    const parsed = parseUserSettings(encrypted);
    expect(parsed.thumbnail_variant_count).toBeUndefined();
    expect(parsed.thumbnail_variants_enabled).toBeUndefined();
  });
});
