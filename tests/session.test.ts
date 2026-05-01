import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  verifySessionToken,
  SessionError,
  _resetSecretCacheForTests,
} from '@/lib/session';
import { SignJWT } from 'jose';

describe('session.createSession + verifySessionToken', () => {
  it('round-trips a valid payload', async () => {
    const token = await createSession({ uid: 'u-1', sysrole: 'user', ws: 'ws-1' });
    const verified = await verifySessionToken(token);
    expect(verified).toEqual({ uid: 'u-1', sysrole: 'user', ws: 'ws-1' });
  });

  it('round-trips an admin payload', async () => {
    const token = await createSession({ uid: 'admin-1', sysrole: 'admin', ws: 'ws-1' });
    expect(await verifySessionToken(token)).toEqual({
      uid: 'admin-1',
      sysrole: 'admin',
      ws: 'ws-1',
    });
  });

  it('returns null for a totally invalid token', async () => {
    expect(await verifySessionToken('not-a-jwt')).toBeNull();
    expect(await verifySessionToken('')).toBeNull();
  });

  it('returns null for a token signed with a different secret', async () => {
    const otherSecret = new TextEncoder().encode('a-different-secret-' + 'x'.repeat(48));
    const foreign = await new SignJWT({ uid: 'u', sysrole: 'user', ws: 'w' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(otherSecret);
    expect(await verifySessionToken(foreign)).toBeNull();
  });

  it('returns null when the payload is missing uid', async () => {
    // forge a properly-signed token whose payload is missing uid
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET!);
    const forged = await new SignJWT({ sysrole: 'user', ws: 'w' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(secret);
    expect(await verifySessionToken(forged)).toBeNull();
  });

  it('returns null when sysrole is not in the allowed set', async () => {
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET!);
    const forged = await new SignJWT({ uid: 'u', sysrole: 'superuser', ws: 'w' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(secret);
    expect(await verifySessionToken(forged)).toBeNull();
  });

  it('returns null when ws is empty', async () => {
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET!);
    const forged = await new SignJWT({ uid: 'u', sysrole: 'user', ws: '' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(secret);
    expect(await verifySessionToken(forged)).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const secret = new TextEncoder().encode(process.env.AUTH_SECRET!);
    const expired = await new SignJWT({ uid: 'u', sysrole: 'user', ws: 'w' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 31)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret);
    expect(await verifySessionToken(expired)).toBeNull();
  });

  it('returns null for a tampered token (signature mismatch)', async () => {
    const token = await createSession({ uid: 'u-1', sysrole: 'user', ws: 'ws-1' });
    // Flip the last char of the signature segment.
    const parts = token.split('.');
    const sig = parts[2];
    const tampered = parts[0] + '.' + parts[1] + '.' + sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');
    expect(await verifySessionToken(tampered)).toBeNull();
  });
});

describe('session.SessionError', () => {
  it('preserves status code', () => {
    const e = new SessionError(401, 'no');
    expect(e.status).toBe(401);
    expect(e.name).toBe('SessionError');
  });

  it('is throwable and identifiable', () => {
    let caught: unknown = null;
    try {
      throw new SessionError(403, 'forbidden');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionError);
    expect((caught as SessionError).status).toBe(403);
  });
});

describe('session secret handling', () => {
  const ORIGINAL_SECRET = process.env.AUTH_SECRET;

  beforeEach(() => {
    _resetSecretCacheForTests();
  });

  afterEach(() => {
    process.env.AUTH_SECRET = ORIGINAL_SECRET;
    _resetSecretCacheForTests();
  });

  it('throws if AUTH_SECRET is not set', async () => {
    delete process.env.AUTH_SECRET;
    await expect(createSession({ uid: 'u', sysrole: 'user', ws: 'w' })).rejects.toThrow(
      /AUTH_SECRET/,
    );
  });

  it('caches the secret across calls in one process', async () => {
    process.env.AUTH_SECRET = 'cached-secret-' + 'x'.repeat(48);
    const t1 = await createSession({ uid: 'u', sysrole: 'user', ws: 'w' });
    // changing the env after first use must NOT affect verification
    process.env.AUTH_SECRET = 'new-secret-' + 'x'.repeat(48);
    expect(await verifySessionToken(t1)).not.toBeNull();
  });
});
