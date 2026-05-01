import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorHandler } from '@/lib/route-helpers';
import { SessionError } from '@/lib/session';
import { getRequestContext, withRequestContext } from '@/lib/request-context';
import { logger } from '@/lib/logger';

function makeReq(url = 'http://localhost:3000/api/anything'): NextRequest {
  return new NextRequest(url);
}

describe('withErrorHandler', () => {
  it('passes through a successful response and stamps x-request-id', async () => {
    const handler = withErrorHandler(async () => NextResponse.json({ ok: true }));
    const res = await handler(makeReq(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('honours a caller-provided x-request-id', async () => {
    const handler = withErrorHandler(async () => NextResponse.json({ ok: true }));
    const req = new NextRequest('http://localhost:3000/api/x', {
      headers: { 'x-request-id': 'caller-supplied-id-1' },
    });
    const res = await handler(req, { params: Promise.resolve({}) });
    expect(res.headers.get('x-request-id')).toBe('caller-supplied-id-1');
  });

  it('maps SessionError(401) to a JSON 401 response', async () => {
    const handler = withErrorHandler(async () => {
      throw new SessionError(401, 'Authentication required');
    });
    const res = await handler(makeReq(), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authentication required' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('maps SessionError(403) to a JSON 403 response', async () => {
    const handler = withErrorHandler(async () => {
      throw new SessionError(403, 'Admin access required');
    });
    const res = await handler(makeReq(), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Admin access required' });
  });

  it('maps an unknown thrown error to a JSON 500 and logs the stack', async () => {
    const captured: string[] = [];
    const realStderr = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const handler = withErrorHandler(async () => {
        throw new Error('database fell over');
      });
      const res = await handler(makeReq(), { params: Promise.resolve({}) });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(captured.some((c) => c.includes('"level":"error"'))).toBe(true);
      expect(captured.some((c) => c.includes('database fell over'))).toBe(true);
    } finally {
      process.stderr.write = realStderr;
    }
  });

  it('makes the request_id available to the handler via getRequestContext', async () => {
    let captured: string | undefined = undefined;
    const handler = withErrorHandler(async () => {
      captured = getRequestContext()?.request_id;
      return NextResponse.json({ ok: true });
    });
    await handler(makeReq(), { params: Promise.resolve({}) });
    expect(captured).toMatch(/[0-9a-f-]{36}/);
  });

  it('exposes the route path in the request context', async () => {
    let route: string | undefined;
    const handler = withErrorHandler(async () => {
      route = getRequestContext()?.route;
      return NextResponse.json({ ok: true });
    });
    await handler(makeReq('http://localhost:3000/api/projects/123'), {
      params: Promise.resolve({}),
    });
    expect(route).toBe('/api/projects/123');
  });
});

describe('request-context', () => {
  it('returns undefined outside of a context', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('isolates context per call', async () => {
    const a = withRequestContext({ request_id: 'a' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getRequestContext()?.request_id;
    });
    const b = withRequestContext({ request_id: 'b' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getRequestContext()?.request_id;
    });
    expect(await a).toBe('a');
    expect(await b).toBe('b');
  });

  it('allows mutating user_id / workspace_id on the stored object', () => {
    return withRequestContext({ request_id: 'r' }, () => {
      const ctx = getRequestContext()!;
      ctx.user_id = 'u-1';
      ctx.workspace_id = 'w-1';
      const re = getRequestContext()!;
      expect(re.user_id).toBe('u-1');
      expect(re.workspace_id).toBe('w-1');
    });
  });
});

describe('logger', () => {
  // Capture into arrays via direct stub instead of vi.spyOn — Vitest 3's
  // MockInstance generic doesn't play nicely with the overloaded
  // `process.stdout.write` signature in strict TS.
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const realStdout = process.stdout.write;
  const realStderr = process.stderr.write;

  beforeEach(() => {
    stdoutLines.length = 0;
    stderrLines.length = 0;
    process.stdout.write = ((chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
  });

  it('emits info to stdout as JSON', () => {
    logger.info('hello');
    expect(stdoutLines).toHaveLength(1);
    const line = JSON.parse(stdoutLines[0]);
    expect(line.level).toBe('info');
    expect(line.msg).toBe('hello');
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('emits warn / error to stderr', () => {
    logger.warn('careful');
    logger.error('explosion');
    expect(stderrLines).toHaveLength(2);
    expect(JSON.parse(stderrLines[0]).level).toBe('warn');
    expect(JSON.parse(stderrLines[1]).level).toBe('error');
  });

  it('includes request_id / user_id / workspace_id from context', () => {
    return withRequestContext({ request_id: 'r-1', user_id: 'u-1', workspace_id: 'w-1' }, () => {
      logger.info('hi', { extra: 1 });
      const line = JSON.parse(stdoutLines[0]);
      expect(line.request_id).toBe('r-1');
      expect(line.user_id).toBe('u-1');
      expect(line.workspace_id).toBe('w-1');
      expect(line.extra).toBe(1);
    });
  });

  it('drops undefined context fields from the line', () => {
    logger.info('orphan');
    const line = JSON.parse(stdoutLines[0]);
    expect('request_id' in line).toBe(false);
    expect('user_id' in line).toBe(false);
  });
});
