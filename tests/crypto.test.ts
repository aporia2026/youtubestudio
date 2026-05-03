import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, decrypt } from '@/lib/crypto';

describe('crypto.encrypt / crypto.decrypt', () => {
  it('roundtrips ASCII plaintext', () => {
    const plaintext = 'hello world';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('roundtrips an empty string', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('roundtrips multi-byte unicode', () => {
    const plaintext = '日本語 — émoji 🎬 — \u{1F47B}';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('roundtrips a long blob', () => {
    const plaintext = 'x'.repeat(64 * 1024);
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'secret';
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  it('rejects ciphertext whose auth tag has been tampered with', () => {
    const ct = encrypt('hello');
    // Flip a bit in the auth tag region (bytes 16..32 in the unwrapped buffer).
    const buf = Buffer.from(ct, 'base64');
    buf[20] = buf[20] ^ 0x01;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects ciphertext whose body has been tampered with', () => {
    const ct = encrypt('hello world this is enough bytes for a meaningful flip');
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0x01;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects garbage input', () => {
    expect(() => decrypt('not-valid-base64-or-anything!')).toThrow();
  });
});

describe('crypto: ENCRYPTION_KEY independence (audit C6)', () => {
  const origEnc = process.env.ENCRYPTION_KEY;
  const origAuth = process.env.AUTH_SECRET;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.ENCRYPTION_KEY = origEnc;
    process.env.AUTH_SECRET = origAuth;
    warnSpy.mockRestore();
    vi.resetModules();
  });

  it('uses ENCRYPTION_KEY when set without warning about fallback', async () => {
    vi.resetModules();
    process.env.ENCRYPTION_KEY = 'a-distinct-encryption-key-for-this-test-only-32+chars';
    process.env.AUTH_SECRET = 'a-totally-different-auth-secret-for-this-test';
    const mod = await import('@/lib/crypto');
    const ct = mod.encrypt('hello');
    expect(mod.decrypt(ct)).toBe('hello');
    expect(warnSpy.mock.calls.find((c) => String(c[0]).includes('ENCRYPTION_KEY is unset'))).toBeUndefined();
  });

  it('falls back to AUTH_SECRET when ENCRYPTION_KEY is unset and warns once', async () => {
    vi.resetModules();
    delete process.env.ENCRYPTION_KEY;
    process.env.AUTH_SECRET = 'fallback-only-secret-used-when-encryption-key-missing';
    const mod = await import('@/lib/crypto');
    mod.encrypt('a');
    mod.encrypt('b');
    mod.encrypt('c');
    const fallbackWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('ENCRYPTION_KEY is unset'));
    expect(fallbackWarns.length).toBe(1);
  });

  it('throws when both env vars are unset', async () => {
    vi.resetModules();
    delete process.env.ENCRYPTION_KEY;
    delete process.env.AUTH_SECRET;
    const mod = await import('@/lib/crypto');
    expect(() => mod.encrypt('x')).toThrow(/ENCRYPTION_KEY or AUTH_SECRET must be set/);
  });

  it('ENCRYPTION_KEY and AUTH_SECRET produce DIFFERENT ciphertext spaces (independent secrets)', async () => {
    vi.resetModules();
    process.env.ENCRYPTION_KEY = 'unique-encryption-key-x-y-z-32+chars-padding-here';
    process.env.AUTH_SECRET = 'unique-auth-secret-a-b-c-d-32+chars-padding-here';
    const withEnc = await import('@/lib/crypto');
    const ctWithEnc = withEnc.encrypt('payload');

    vi.resetModules();
    delete process.env.ENCRYPTION_KEY;
    process.env.AUTH_SECRET = 'unique-auth-secret-a-b-c-d-32+chars-padding-here';
    const withAuth = await import('@/lib/crypto');
    // Ciphertext encrypted under ENCRYPTION_KEY must NOT decrypt under
    // AUTH_SECRET (different keys = different cipher streams).
    expect(() => withAuth.decrypt(ctWithEnc)).toThrow();
  });
});
