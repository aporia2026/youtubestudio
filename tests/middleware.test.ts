import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { isPublicApiPath, isMiddlewareSessionValid } from '@/middleware';

describe('middleware.isPublicApiPath', () => {
  it('lets all /api/auth/* paths through', () => {
    expect(isPublicApiPath('/api/auth/login')).toBe(true);
    expect(isPublicApiPath('/api/auth/logout')).toBe(true);
    expect(isPublicApiPath('/api/auth/forgot-password')).toBe(true);
    expect(isPublicApiPath('/api/auth/google/callback')).toBe(true);
    expect(isPublicApiPath('/api/auth/me')).toBe(true);
  });

  it('lets every token-portal namespace through', () => {
    expect(isPublicApiPath('/api/editor/abc123/projects/p-1')).toBe(true);
    expect(isPublicApiPath('/api/editor-dashboard/abc123')).toBe(true);
    expect(isPublicApiPath('/api/narrate/abc123/sections/s-1/upload')).toBe(true);
    expect(isPublicApiPath('/api/narrator-dashboard/abc123')).toBe(true);
    expect(isPublicApiPath('/api/activity/abc123')).toBe(true);
    expect(isPublicApiPath('/api/collaborator-prefs/abc123')).toBe(true);
    expect(isPublicApiPath('/api/public/schedule/abc123')).toBe(true);
    expect(isPublicApiPath('/api/notifications/unsubscribe/abc123')).toBe(true);
  });

  it('lets /api/review/[token]/* through but NOT /api/review/projects/*', () => {
    expect(isPublicApiPath('/api/review/sometoken123')).toBe(true);
    expect(isPublicApiPath('/api/review/sometoken123/comments')).toBe(true);
    expect(isPublicApiPath('/api/review/sometoken123/upload-video')).toBe(true);

    expect(isPublicApiPath('/api/review/projects')).toBe(false);
    expect(isPublicApiPath('/api/review/projects/p-1')).toBe(false);
    expect(isPublicApiPath('/api/review/projects/p-1/comments')).toBe(false);
  });

  it('blocks every other /api/* path by default', () => {
    expect(isPublicApiPath('/api/projects')).toBe(false);
    expect(isPublicApiPath('/api/projects/p-1')).toBe(false);
    expect(isPublicApiPath('/api/channels')).toBe(false);
    expect(isPublicApiPath('/api/schedule')).toBe(false);
    expect(isPublicApiPath('/api/admin/users')).toBe(false);
    expect(isPublicApiPath('/api/generate/script')).toBe(false);
    expect(isPublicApiPath('/api/qa/analyze')).toBe(false);
    expect(isPublicApiPath('/api/team/collaborators')).toBe(false);
  });

  it('does not match auth-look-alikes that aren\'t actually under /api/auth/', () => {
    expect(isPublicApiPath('/api/authentication')).toBe(false);
    expect(isPublicApiPath('/api/auth-something')).toBe(false);
  });

  it('does not match a top-level token segment outside the allow-listed namespaces', () => {
    // /api/anyrandompath — not a known portal namespace
    expect(isPublicApiPath('/api/sometoken')).toBe(false);
  });
});

describe('middleware.isMiddlewareSessionValid', () => {
  const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET!);

  function signWith(payload: Record<string, unknown>, opts: { expSec?: number } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const j = new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(opts.expSec === undefined ? undefined : now - 60)
      .setExpirationTime(opts.expSec === undefined ? '30d' : now + opts.expSec);
    return j.sign(secret());
  }

  it('returns true for a fresh, well-formed session', async () => {
    const t = await signWith({ uid: 'u-1', sysrole: 'user', ws: 'w-1' });
    expect(await isMiddlewareSessionValid(t)).toBe(true);
  });

  it('returns true for an admin session', async () => {
    const t = await signWith({ uid: 'admin-1', sysrole: 'admin', ws: 'w-1' });
    expect(await isMiddlewareSessionValid(t)).toBe(true);
  });

  it('returns false for an empty token', async () => {
    expect(await isMiddlewareSessionValid('')).toBe(false);
  });

  it('returns false for garbage text', async () => {
    expect(await isMiddlewareSessionValid('not-a-jwt')).toBe(false);
  });

  it('rejects the legacy {authenticated:true} payload (pre-Phase-1 sessions)', async () => {
    const t = await signWith({ authenticated: true });
    expect(await isMiddlewareSessionValid(t)).toBe(false);
  });

  it('rejects a token missing uid', async () => {
    const t = await signWith({ sysrole: 'user', ws: 'w-1' });
    expect(await isMiddlewareSessionValid(t)).toBe(false);
  });

  it('rejects a token with an unknown sysrole', async () => {
    const t = await signWith({ uid: 'u', sysrole: 'superuser', ws: 'w' });
    expect(await isMiddlewareSessionValid(t)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const t = await signWith({ uid: 'u', sysrole: 'user', ws: 'w' }, { expSec: -1 });
    expect(await isMiddlewareSessionValid(t)).toBe(false);
  });

  it('rejects a token signed with a different secret', async () => {
    const otherSecret = new TextEncoder().encode('a-totally-different-secret-' + 'x'.repeat(40));
    const foreign = await new SignJWT({ uid: 'u', sysrole: 'user', ws: 'w' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(otherSecret);
    expect(await isMiddlewareSessionValid(foreign)).toBe(false);
  });
});
