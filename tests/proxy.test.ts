import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { isPathPublic, isSessionValid } from '@/proxy';

describe('proxy.isPathPublic', () => {
  it('lets all auth flow paths through', () => {
    expect(isPathPublic('/login')).toBe(true);
    expect(isPathPublic('/forgot-password')).toBe(true);
    expect(isPathPublic('/api/auth/login')).toBe(true);
    expect(isPathPublic('/api/auth/logout')).toBe(true);
    expect(isPathPublic('/api/auth/forgot-password')).toBe(true);
    expect(isPathPublic('/api/auth/reset-password')).toBe(true);
    expect(isPathPublic('/api/auth/accept-invite')).toBe(true);
    expect(isPathPublic('/api/auth/google')).toBe(true);
    expect(isPathPublic('/api/auth/google/callback')).toBe(true);
  });

  it('lets every token-portal namespace through', () => {
    expect(isPathPublic('/editor/abc123')).toBe(true);
    expect(isPathPublic('/editor/abc123/projects/p-1')).toBe(true);
    expect(isPathPublic('/api/editor/abc123/projects/p-1')).toBe(true);
    expect(isPathPublic('/api/editor-dashboard/abc123')).toBe(true);
    expect(isPathPublic('/narrate/abc123')).toBe(true);
    expect(isPathPublic('/narrator/abc123')).toBe(true);
    expect(isPathPublic('/api/narrate/abc123/sections/s-1/upload')).toBe(true);
    expect(isPathPublic('/api/narrator/take-comments/c-1')).toBe(true);
    expect(isPathPublic('/api/narrator-dashboard/abc123')).toBe(true);
    expect(isPathPublic('/api/activity/abc123')).toBe(true);
    expect(isPathPublic('/api/collaborator-prefs/abc123')).toBe(true);
    expect(isPathPublic('/share/abc123')).toBe(true);
    expect(isPathPublic('/api/public/schedule/abc123')).toBe(true);
    expect(isPathPublic('/unsubscribe/abc123')).toBe(true);
    expect(isPathPublic('/api/notifications/unsubscribe/abc123')).toBe(true);
  });

  it('lets the new accept-invite + reset-password token pages through', () => {
    expect(isPathPublic('/accept-invite/somelongtokenvalue')).toBe(true);
    expect(isPathPublic('/reset-password/somelongtokenvalue')).toBe(true);
  });

  it('lets review tokens through but NOT review/projects (owner surface)', () => {
    expect(isPathPublic('/review/abc123')).toBe(true);
    expect(isPathPublic('/api/review/abc123')).toBe(true);
    expect(isPathPublic('/api/review/abc123/comments')).toBe(true);

    expect(isPathPublic('/api/review/projects')).toBe(false);
    expect(isPathPublic('/api/review/projects/p-1')).toBe(false);
    expect(isPathPublic('/api/review/projects/p-1/comments')).toBe(false);
  });

  it('lets the voiceover audio proxy through but NOT its sibling routes', () => {
    // <uuid>/audio shape — UUID is the access token, server-side
    // renderers + alignment cache fetch this without a session cookie.
    expect(isPathPublic('/api/voiceovers/8c4f2a1e-9b3d-4f7c-a5e2-1d6b8e4c9f0a/audio')).toBe(true);
    // Sibling routes stay gated.
    expect(isPathPublic('/api/voiceovers/library')).toBe(false);
    expect(isPathPublic('/api/voiceovers/align')).toBe(false);
    // Look-alikes that aren't actually `<uuid>/audio` don't pass.
    expect(isPathPublic('/api/voiceovers/not-a-uuid/audio')).toBe(false);
    expect(isPathPublic('/api/voiceovers/8c4f2a1e-9b3d-4f7c-a5e2-1d6b8e4c9f0a')).toBe(false);
    expect(isPathPublic('/api/voiceovers/8c4f2a1e-9b3d-4f7c-a5e2-1d6b8e4c9f0a/audio/extra')).toBe(false);
  });

  it('lets static asset paths through', () => {
    expect(isPathPublic('/_next/static/foo.js')).toBe(true);
    expect(isPathPublic('/favicon.ico')).toBe(true);
  });

  it('blocks every other path by default', () => {
    expect(isPathPublic('/')).toBe(false);
    expect(isPathPublic('/dashboard')).toBe(false);
    expect(isPathPublic('/admin')).toBe(false);
    expect(isPathPublic('/admin/users/abc')).toBe(false);
    expect(isPathPublic('/api/projects')).toBe(false);
    expect(isPathPublic('/api/projects/p-1')).toBe(false);
    expect(isPathPublic('/api/channels')).toBe(false);
    expect(isPathPublic('/api/schedule')).toBe(false);
    expect(isPathPublic('/api/admin/users')).toBe(false);
    expect(isPathPublic('/api/generate/script')).toBe(false);
  });

  it('does not match auth-look-alikes that aren\'t actually under /api/auth/', () => {
    expect(isPathPublic('/api/authentication')).toBe(false);
    expect(isPathPublic('/api/auth-something')).toBe(false);
  });

  it('does not match a top-level token segment outside the allow-listed namespaces', () => {
    expect(isPathPublic('/api/sometoken')).toBe(false);
    expect(isPathPublic('/sometoken')).toBe(false);
  });
});

describe('proxy.isSessionValid', () => {
  const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET!);

  function signWith(payload: Record<string, unknown>, opts: { expSec?: number } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const j = new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(opts.expSec === undefined ? undefined : now - 60)
      .setExpirationTime(opts.expSec === undefined ? '30d' : now + opts.expSec);
    return j.sign(secret());
  }

  it('returns true for a fresh, well-formed user session', async () => {
    const t = await signWith({ uid: 'u-1', sysrole: 'user', ws: 'w-1' });
    expect(await isSessionValid(t)).toBe(true);
  });

  it('returns true for an admin session', async () => {
    const t = await signWith({ uid: 'admin-1', sysrole: 'admin', ws: 'w-1' });
    expect(await isSessionValid(t)).toBe(true);
  });

  it('returns false for undefined / empty / garbage tokens', async () => {
    expect(await isSessionValid(undefined)).toBe(false);
    expect(await isSessionValid('')).toBe(false);
    expect(await isSessionValid('not-a-jwt')).toBe(false);
  });

  it('rejects the legacy {authenticated:true} payload (pre-Phase-1 sessions)', async () => {
    const t = await signWith({ authenticated: true });
    expect(await isSessionValid(t)).toBe(false);
  });

  it('rejects a token missing uid', async () => {
    const t = await signWith({ sysrole: 'user', ws: 'w-1' });
    expect(await isSessionValid(t)).toBe(false);
  });

  it('rejects a token with an unknown sysrole', async () => {
    const t = await signWith({ uid: 'u', sysrole: 'superuser', ws: 'w' });
    expect(await isSessionValid(t)).toBe(false);
  });

  it('rejects a token with empty ws', async () => {
    const t = await signWith({ uid: 'u', sysrole: 'user', ws: '' });
    expect(await isSessionValid(t)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const t = await signWith({ uid: 'u', sysrole: 'user', ws: 'w' }, { expSec: -1 });
    expect(await isSessionValid(t)).toBe(false);
  });

  it('rejects a token signed with a different secret', async () => {
    const otherSecret = new TextEncoder().encode('a-totally-different-secret-' + 'x'.repeat(40));
    const foreign = await new SignJWT({ uid: 'u', sysrole: 'user', ws: 'w' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(otherSecret);
    expect(await isSessionValid(foreign)).toBe(false);
  });
});
