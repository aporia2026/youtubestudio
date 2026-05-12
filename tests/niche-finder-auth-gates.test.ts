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
import * as fromChannelRoute from '@/app/api/niche-finder/discover/from-channel/route';
import * as fromInterestsRoute from '@/app/api/niche-finder/discover/from-interests/route';
import * as fromCategoryRoute from '@/app/api/niche-finder/discover/from-category/route';
import * as outliersRoute from '@/app/api/niche-finder/outliers/route';
import * as watchlistRoute from '@/app/api/niche-finder/watchlist/route';
import * as watchlistBySlugRoute from '@/app/api/niche-finder/watchlist/[slug]/route';
import * as rescoreCronRoute from '@/app/api/cron/rescore-niche-watchlist/route';
import * as outlierPresetsRoute from '@/app/api/niche-finder/outliers/presets/route';
import * as outlierPresetByIdRoute from '@/app/api/niche-finder/outliers/presets/[id]/route';

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

  it('POST /api/niche-finder/discover/from-channel returns 401 with no session', async () => {
    const POST = (fromChannelRoute as unknown as { POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).POST;
    const req = makeReq('http://localhost/api/niche-finder/discover/from-channel', {
      method: 'POST',
      body: JSON.stringify({ channelUrl: 'https://youtube.com/@example' }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('POST /api/niche-finder/discover/from-interests returns 401 with no session', async () => {
    const POST = (fromInterestsRoute as unknown as { POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).POST;
    const req = makeReq('http://localhost/api/niche-finder/discover/from-interests', {
      method: 'POST',
      body: JSON.stringify({ interests: ['history', 'tech'] }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('GET /api/niche-finder/discover/from-category returns 401 with no session', async () => {
    const GET = (fromCategoryRoute as unknown as { GET: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).GET;
    const req = makeReq('http://localhost/api/niche-finder/discover/from-category');
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('POST /api/niche-finder/discover/from-category returns 401 with no session', async () => {
    const POST = (fromCategoryRoute as unknown as { POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).POST;
    const req = makeReq('http://localhost/api/niche-finder/discover/from-category', {
      method: 'POST',
      body: JSON.stringify({ categorySlug: 'finance' }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('POST /api/niche-finder/outliers returns 401 with no session', async () => {
    const POST = (outliersRoute as unknown as { POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).POST;
    const req = makeReq('http://localhost/api/niche-finder/outliers', {
      method: 'POST',
      body: JSON.stringify({ niche: 'history' }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('GET /api/niche-finder/watchlist returns 401 with no session', async () => {
    const GET = (watchlistRoute as unknown as { GET: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).GET;
    const req = makeReq('http://localhost/api/niche-finder/watchlist');
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('POST /api/niche-finder/watchlist returns 401 with no session', async () => {
    const POST = (watchlistRoute as unknown as { POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).POST;
    const req = makeReq('http://localhost/api/niche-finder/watchlist', {
      method: 'POST',
      body: JSON.stringify({ nicheSlug: 'history' }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/niche-finder/watchlist/[slug] returns 401 with no session', async () => {
    const DELETE = (watchlistBySlugRoute as unknown as { DELETE: (req: NextRequest, ctx: { params: Promise<{ slug: string }> }) => Promise<Response> }).DELETE;
    const req = makeReq('http://localhost/api/niche-finder/watchlist/history', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ slug: 'history' }) });
    expect(res.status).toBe(401);
  });

  it('GET /api/niche-finder/outliers/presets returns 401 with no session', async () => {
    const GET = (outlierPresetsRoute as unknown as { GET: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).GET;
    const req = makeReq('http://localhost/api/niche-finder/outliers/presets');
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('POST /api/niche-finder/outliers/presets returns 401 with no session', async () => {
    const POST = (outlierPresetsRoute as unknown as { POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }).POST;
    const req = makeReq('http://localhost/api/niche-finder/outliers/presets', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', nicheQuery: 'history', filters: {} }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/niche-finder/outliers/presets/[id] returns 401 with no session', async () => {
    const DELETE = (outlierPresetByIdRoute as unknown as { DELETE: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response> }).DELETE;
    const req = makeReq('http://localhost/api/niche-finder/outliers/presets/some-id', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'some-id' }) });
    expect(res.status).toBe(401);
  });

  it('POST /api/cron/rescore-niche-watchlist returns 401 without the CRON_SECRET bearer', async () => {
    const POST = (rescoreCronRoute as unknown as { POST: (req: NextRequest) => Promise<Response> }).POST;
    // Force the non-localhost branch with a public hostname; the
    // route's `isLocal` check requires both NODE_ENV!=='production'
    // AND hostname being localhost/127.0.0.1 to bypass auth, so a
    // public hostname is enough on its own.
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'correct-secret';
    try {
      const req = makeReq('https://prod.example.com/api/cron/rescore-niche-watchlist', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-secret' },
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    } finally {
      if (original === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = original;
    }
  });
});
