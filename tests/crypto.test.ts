import { describe, expect, it } from 'vitest';
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
