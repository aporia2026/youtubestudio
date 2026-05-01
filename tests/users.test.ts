import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  generateOneShotToken,
  hashOneShotToken,
  tokensEqual,
  PasswordTooShortError,
} from '@/lib/users';

describe('users.hashPassword / verifyPassword', () => {
  it('hashes a 12-char password and verifies the original', async () => {
    const plain = 'a'.repeat(12);
    const hashed = await hashPassword(plain);
    expect(hashed).toMatch(/^\$2[aby]\$/);
    expect(await verifyPassword(plain, hashed)).toBe(true);
  });

  it('rejects a password shorter than 12 chars', async () => {
    await expect(hashPassword('short')).rejects.toBeInstanceOf(PasswordTooShortError);
    await expect(hashPassword('eleven-chrs')).rejects.toBeInstanceOf(PasswordTooShortError);
  });

  it('rejects a non-string password', async () => {
    // @ts-expect-error -- deliberate runtime check
    await expect(hashPassword(undefined)).rejects.toBeInstanceOf(PasswordTooShortError);
    // @ts-expect-error -- deliberate runtime check
    await expect(hashPassword(null)).rejects.toBeInstanceOf(PasswordTooShortError);
  });

  it('produces a different hash for the same plaintext (random salt)', async () => {
    const plain = 'a-strong-password-123';
    const a = await hashPassword(plain);
    const b = await hashPassword(plain);
    expect(a).not.toBe(b);
    expect(await verifyPassword(plain, a)).toBe(true);
    expect(await verifyPassword(plain, b)).toBe(true);
  });

  it('returns false for a wrong password', async () => {
    const hashed = await hashPassword('the-real-password');
    expect(await verifyPassword('the-fake-password', hashed)).toBe(false);
  });

  it('returns false when either side is empty', async () => {
    expect(await verifyPassword('', 'whatever')).toBe(false);
    expect(await verifyPassword('whatever', '')).toBe(false);
    expect(await verifyPassword('', '')).toBe(false);
    expect(await verifyPassword('whatever', null)).toBe(false);
  });

  it('returns false on a malformed hash without throwing', async () => {
    expect(await verifyPassword('whatever', 'not-a-bcrypt-hash')).toBe(false);
  });

  it('uses a cost factor of at least 10', async () => {
    const hashed = await hashPassword('the-real-password');
    const cost = parseInt(hashed.split('$')[2], 10);
    expect(cost).toBeGreaterThanOrEqual(10);
  });
});

describe('users.generateOneShotToken / hashOneShotToken / tokensEqual', () => {
  it('generates 64-char hex tokens', () => {
    const t = generateOneShotToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('every generated token is unique with very high probability', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) tokens.add(generateOneShotToken());
    expect(tokens.size).toBe(1000);
  });

  it('hashOneShotToken produces a deterministic 64-char sha-256 hex digest', () => {
    const t = 'some-token-value';
    const h1 = hashOneShotToken(t);
    const h2 = hashOneShotToken(t);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashOneShotToken differs for different inputs', () => {
    expect(hashOneShotToken('a')).not.toBe(hashOneShotToken('b'));
  });

  it('hashOneShotToken does not equal its input (so a DB dump leaks no plaintext)', () => {
    const t = generateOneShotToken();
    expect(hashOneShotToken(t)).not.toBe(t);
  });

  it('tokensEqual returns true for identical strings, false otherwise', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('', '')).toBe(true);
  });

  it('tokensEqual is length-safe (no buffer length mismatch crash)', () => {
    expect(() => tokensEqual('a', 'aaaaa')).not.toThrow();
    expect(tokensEqual('a', 'aaaaa')).toBe(false);
  });
});
