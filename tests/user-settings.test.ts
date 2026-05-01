import { describe, expect, it } from 'vitest';
import {
  parseUserSettings,
  serializeUserSettings,
  SETTINGS_VERSION,
} from '@/lib/user-settings';
import { encrypt } from '@/lib/crypto';

describe('parseUserSettings', () => {
  it('returns defaults on null input', () => {
    expect(parseUserSettings(null)).toEqual({ v: SETTINGS_VERSION });
  });

  it('returns defaults on empty string', () => {
    expect(parseUserSettings('')).toEqual({ v: SETTINGS_VERSION });
  });

  it('returns defaults on garbage that fails to decrypt', () => {
    expect(parseUserSettings('not-base64-anything!!')).toEqual({ v: SETTINGS_VERSION });
  });

  it('returns defaults when the decrypted blob is not JSON', () => {
    const corrupt = encrypt('not json at all');
    expect(parseUserSettings(corrupt)).toEqual({ v: SETTINGS_VERSION });
  });

  it('returns defaults when the decrypted JSON is not an object', () => {
    expect(parseUserSettings(encrypt(JSON.stringify(['array', 'not', 'object'])))).toEqual({
      v: SETTINGS_VERSION,
    });
    expect(parseUserSettings(encrypt(JSON.stringify('a string')))).toEqual({
      v: SETTINGS_VERSION,
    });
    expect(parseUserSettings(encrypt(JSON.stringify(null)))).toEqual({
      v: SETTINGS_VERSION,
    });
  });

  it('returns defaults when the version mismatches (forward compat)', () => {
    const future = encrypt(JSON.stringify({ v: 99, active_channel_id: 'ws-1' }));
    expect(parseUserSettings(future)).toEqual({ v: SETTINGS_VERSION });
  });

  it('reads active_channel_id when string', () => {
    const blob = encrypt(JSON.stringify({ v: 1, active_channel_id: 'channel-uuid-1' }));
    expect(parseUserSettings(blob)).toEqual({
      v: 1,
      active_channel_id: 'channel-uuid-1',
    });
  });

  it('reads active_channel_id = null explicitly', () => {
    const blob = encrypt(JSON.stringify({ v: 1, active_channel_id: null }));
    expect(parseUserSettings(blob)).toEqual({
      v: 1,
      active_channel_id: null,
    });
  });

  it('drops unknown fields silently', () => {
    const blob = encrypt(
      JSON.stringify({ v: 1, active_channel_id: 'c-1', some_future_field: 'x' }),
    );
    expect(parseUserSettings(blob)).toEqual({
      v: 1,
      active_channel_id: 'c-1',
    });
  });

  it('drops a non-string non-null active_channel_id', () => {
    const blob = encrypt(JSON.stringify({ v: 1, active_channel_id: 42 }));
    expect(parseUserSettings(blob)).toEqual({ v: 1 });
  });
});

describe('serializeUserSettings', () => {
  it('roundtrips through parseUserSettings', () => {
    const settings = { v: 1 as const, active_channel_id: 'c-1' };
    expect(parseUserSettings(serializeUserSettings(settings))).toEqual(settings);
  });

  it('always stamps the current version, even if input has no v', () => {
    // @ts-expect-error -- deliberate: caller forgot to set v
    const blob = serializeUserSettings({ active_channel_id: 'c-1' });
    expect(parseUserSettings(blob)).toEqual({ v: 1, active_channel_id: 'c-1' });
  });

  it('always stamps the current version, overriding stale input v', () => {
    // @ts-expect-error -- deliberate: caller passed v=99
    const blob = serializeUserSettings({ v: 99, active_channel_id: 'c-1' });
    expect(parseUserSettings(blob)).toEqual({ v: 1, active_channel_id: 'c-1' });
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const settings = { v: 1 as const, active_channel_id: 'c-1' };
    const a = serializeUserSettings(settings);
    const b = serializeUserSettings(settings);
    expect(a).not.toBe(b);
    expect(parseUserSettings(a)).toEqual(parseUserSettings(b));
  });

  it('roundtrips an explicit null active_channel_id', () => {
    const settings = { v: 1 as const, active_channel_id: null };
    expect(parseUserSettings(serializeUserSettings(settings))).toEqual(settings);
  });
});
