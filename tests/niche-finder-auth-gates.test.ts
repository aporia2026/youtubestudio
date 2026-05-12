/**
 * Auth-gate regression tests for the niche-finder routes.
 *
 * Mirrors the pattern from tests/auth-gates.test.ts (Phase 8.6.4):
 * every request lands without a session cookie and we assert 401,
 * catching any future refactor that accidentally drops
 * `apiRoute.authed` from the route module.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: () => undefined,
      getAll: () => [],
      has: () => false,
    }),
}));

import * as deepDiveRoute from '@/app/api/niche-finder/deep-dive/route';
import * as nicheBySlugRoute from '@/app/api/niche-finder/niches/[slug]/route';

type NextReqInit = ConstructorParameters<typeof NextRequest>[1];

function makeReq(url: string, init: NextReqInit = {}): NextRequest {
  return new NextRequest(url, init);
}

describe('niche-finder routes refuse anonymous traffic', () => {
  it('POST /api/niche-finder/deep-dive returns 401 with no session', async () => {
    const POST = (deepDiveRoute as unknown as { POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).POST;
    const req = makeReq('http://localhost/api/niche-finder/deep-dive', {
      method: 'POST',
      body: JSON.stringify({ nicheText: 'history' }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('GET /api/niche-finder/niches/[slug] returns 401 with no session', async () => {
    const GET = (nicheBySlugRoute as unknown as { GET: (req: NextRequest, ctx: { params: Promise<{ slug: string }> }) => Promise<Response> }).GET;
    const req = makeReq('http://localhost/api/niche-finder/niches/history');
    const res = await GET(req, { params: Promise.resolve({ slug: 'history' }) });
    expect(res.status).toBe(401);
  });
});
