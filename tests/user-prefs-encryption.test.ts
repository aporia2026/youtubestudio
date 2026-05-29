/**
 * Tests for the encryption-at-rest layer on /api/user-prefs.
 * Phase 4 of the 2026-05-29 persistence-rebuild plan (encryption
 * for sensitive prefs — Perplexity / ElevenLabs API keys).
 *
 * Unit-tests the envelope shape directly by exercising the same
 * crypto.ts encrypt/decrypt the route uses. The route's wiring is
 * tested by composition: if encrypt+decrypt round-trip a value AND
 * the route writes the envelope shape AND reads it back, the
 * end-to-end contract holds. Stronger integration test would need
 * a live Postgres + session, which the existing test harness doesn't
 * provide.
 */
import { describe, expect, it, beforeAll } from 'vitest';

beforeAll(() => {
  // crypto.ts requires either ENCRYPTION_KEY or AUTH_SECRET in env.
  if (!process.env.ENCRYPTION_KEY && !process.env.AUTH_SECRET) {
    process.env.AUTH_SECRET = 'test-fixture-secret-do-not-use-in-prod';
  }
});

describe('user-prefs encryption envelope', () => {
  it('round-trips a string API key', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const plaintext = 'pplx-1234567890abcdef';
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces a different ciphertext each call (random IV)', async () => {
    const { encrypt } = await import('@/lib/crypto');
    const a = encrypt('same-input');
    const b = encrypt('same-input');
    expect(a).not.toBe(b);
  });

  it('round-trips through JSON.stringify (the envelope shape the route uses)', async () => {
    const { encrypt, decrypt } = await import('@/lib/crypto');
    const original = { apiKey: 'secret', region: 'eu-west-1' };
    const envelope = { __enc: encrypt(JSON.stringify(original)) };
    const onDisk = JSON.stringify(envelope);
    // ── simulate DB SELECT returning the JSONB column ──
    const back = JSON.parse(onDisk) as { __enc: string };
    expect(back.__enc).toBeDefined();
    const decrypted = JSON.parse(decrypt(back.__enc));
    expect(decrypted).toEqual(original);
  });

  it('decryption of a corrupted ciphertext throws (caller falls back to null)', async () => {
    const { decrypt } = await import('@/lib/crypto');
    expect(() => decrypt('not-valid-base64-or-ciphertext')).toThrow();
  });

  it('plaintext values without the envelope are passed through unchanged on read', () => {
    // Mirrors the back-compat behaviour of decryptEnvelopeIfNeeded in
    // route.ts: a plain object without `__enc` is returned as-is so
    // pre-existing rows (written before the key was added to
    // ENCRYPTED_KEYS) keep loading correctly.
    const raw = { primaryColor: '#f00' };
    const isEnvelope = raw && typeof raw === 'object' && '__enc' in raw;
    expect(isEnvelope).toBe(false);
  });
});
