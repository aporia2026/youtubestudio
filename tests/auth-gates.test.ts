/**
 * Phase 8.6.4 — regression tests for the Phase 8.1 auth-gate fixes.
 *
 * These routes were previously unauthenticated (or only IP-rate-limited)
 * and either leaked cross-workspace data or burned AI tokens for
 * anonymous traffic. The fix wrapped each in `apiRoute.authed` and
 * added `workspace_id` filters. This test file calls each handler
 * with a request that has no auth cookie and asserts a 401 — catching
 * any future refactor that drops the wrapper.
 *
 * We do NOT exercise the DB path here. The handler short-circuits at
 * `requireUser()` before any SQL runs, so import-time DB connections
 * aren't needed and the test is hermetic.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock next/headers' cookies() to a no-op cookie store so requireUser
// can run outside the Next.js request lifecycle. Without this, the real
// cookies() throws "called outside request scope" → withErrorHandler
// turns it into a 500 instead of the SessionError(401) we want to test.
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: () => undefined,
      getAll: () => [],
      has: () => false,
    }),
}));

// Import each previously-leaking route module's handlers. Each import
// drags the module into the test bundle, so any TypeScript/build
// regression on these routes also surfaces here.
import * as projectScripts from '@/app/api/projects/[id]/scripts/route';
import * as competitorsList from '@/app/api/competitors/route';
import * as competitorById from '@/app/api/competitors/[id]/route';
import * as competitorSync from '@/app/api/competitors/[id]/sync/route';
import * as competitorAnalyze from '@/app/api/competitors/[id]/analyze/route';
import * as competitorIdeas from '@/app/api/competitors/[id]/ideas/route';
import * as competitorThumbAnalyze from '@/app/api/competitors/[id]/thumbnail-analyze/route';
import * as competitorVideoAnalyze from '@/app/api/competitors/[id]/video-analyze/route';
import * as competitorVideoBatch from '@/app/api/competitors/[id]/video-analyze-batch/route';
import * as generateIdeas from '@/app/api/generate/ideas/route';

// NextRequest's init type is stricter than RequestInit (signal can't be null).
// Local alias keeps the call sites concise.
type NextReqInit = ConstructorParameters<typeof NextRequest>[1];

function makeReq(url: string, init: NextReqInit = {}): NextRequest {
  // No `cookie` header → requireUser throws SessionError(401).
  return new NextRequest(url, init);
}

const STUB_PARAMS = { params: Promise.resolve({ id: 'aaaaaaaa-1111-2222-3333-444444444444' }) };

interface RouteCase {
  label: string;
  /** Module export name that must be present (= the auth-wrapped handler). */
  handlerKey: 'GET' | 'POST' | 'DELETE';
  /** Route module's exports. */
  mod: Record<string, unknown>;
  url: string;
  /** Some routes take a [id] param. Pass via STUB_PARAMS. */
  paramsCtx?: { params: Promise<{ id: string }> };
  body?: BodyInit;
}

const ROUTES: RouteCase[] = [
  // /api/projects/[id]/scripts — Audit C1
  {
    label: 'GET /api/projects/[id]/scripts',
    handlerKey: 'GET',
    mod: projectScripts as unknown as Record<string, unknown>,
    url: 'http://localhost/api/projects/abc/scripts',
    paramsCtx: STUB_PARAMS,
  },
  {
    label: 'POST /api/projects/[id]/scripts',
    handlerKey: 'POST',
    mod: projectScripts as unknown as Record<string, unknown>,
    url: 'http://localhost/api/projects/abc/scripts',
    paramsCtx: STUB_PARAMS,
    body: JSON.stringify({ title: 'x', content: 'x' }),
  },
  // /api/competitors family — Audit C2 (8 routes)
  {
    label: 'GET /api/competitors',
    handlerKey: 'GET',
    mod: competitorsList as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors',
  },
  {
    label: 'POST /api/competitors',
    handlerKey: 'POST',
    mod: competitorsList as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors',
    body: JSON.stringify({ channelId: 'UC123' }),
  },
  {
    label: 'GET /api/competitors/[id]',
    handlerKey: 'GET',
    mod: competitorById as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors/abc',
    paramsCtx: STUB_PARAMS,
  },
  {
    label: 'DELETE /api/competitors/[id]',
    handlerKey: 'DELETE',
    mod: competitorById as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors/abc',
    paramsCtx: STUB_PARAMS,
  },
  {
    label: 'POST /api/competitors/[id]/sync',
    handlerKey: 'POST',
    mod: competitorSync as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors/abc/sync',
    paramsCtx: STUB_PARAMS,
  },
  {
    label: 'POST /api/competitors/[id]/analyze',
    handlerKey: 'POST',
    mod: competitorAnalyze as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors/abc/analyze',
    paramsCtx: STUB_PARAMS,
    body: JSON.stringify({}),
  },
  {
    label: 'POST /api/competitors/[id]/ideas',
    handlerKey: 'POST',
    mod: competitorIdeas as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors/abc/ideas',
    paramsCtx: STUB_PARAMS,
    body: JSON.stringify({}),
  },
  {
    label: 'POST /api/competitors/[id]/thumbnail-analyze',
    handlerKey: 'POST',
    mod: competitorThumbAnalyze as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors/abc/thumbnail-analyze',
    paramsCtx: STUB_PARAMS,
    body: JSON.stringify({}),
  },
  {
    label: 'POST /api/competitors/[id]/video-analyze',
    handlerKey: 'POST',
    mod: competitorVideoAnalyze as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors/abc/video-analyze',
    paramsCtx: STUB_PARAMS,
    body: JSON.stringify({}),
  },
  {
    label: 'POST /api/competitors/[id]/video-analyze-batch',
    handlerKey: 'POST',
    mod: competitorVideoBatch as unknown as Record<string, unknown>,
    url: 'http://localhost/api/competitors/abc/video-analyze-batch',
    paramsCtx: STUB_PARAMS,
    body: JSON.stringify({}),
  },
  // /api/generate/ideas — Audit C3
  {
    label: 'POST /api/generate/ideas',
    handlerKey: 'POST',
    mod: generateIdeas as unknown as Record<string, unknown>,
    url: 'http://localhost/api/generate/ideas',
    body: JSON.stringify({ niche: 'x', topic: 'y' }),
  },
];

describe('Phase 8.1 auth gates — anonymous requests must 401', () => {
  for (const r of ROUTES) {
    it(`${r.label} — returns 401 without a session`, async () => {
      const handler = r.mod[r.handlerKey] as
        | ((req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>)
        | undefined;
      expect(handler, `${r.label} must export ${r.handlerKey}`).toBeDefined();

      const req = makeReq(r.url, {
        method: r.handlerKey,
        headers: r.body ? { 'content-type': 'application/json' } : {},
        body: r.body,
      });
      // ctx isn't always read by handlers without [id] params, but
      // passing the stub doesn't hurt.
      const ctx = r.paramsCtx ?? { params: Promise.resolve({} as Record<string, string>) };
      const res = await handler!(req, ctx);

      expect(res.status, `${r.label} returned ${res.status} not 401`).toBe(401);
      const body = (await res.json()) as { error?: string };
      // The 401 message should NOT leak which resource was being queried
      // — confirms the handler stopped before touching the DB.
      expect(body.error).toMatch(/auth|session|unauth/i);
    });
  }
});
