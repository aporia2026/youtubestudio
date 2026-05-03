/**
 * Route handler wrappers used by every API route in PR #5+ to consistently:
 *   - propagate a request id through async-local request context
 *   - turn SessionError (401/403) into a JSON error response
 *   - turn unknown exceptions into a 500 + structured log line
 *   - gate routes behind `requireUser` / `requireAdmin`
 *
 * Composition shape:
 *   export const GET = apiRoute.authed(async (session, req, ctx) => { ... });
 *
 * The first handler arg for authed/admin handlers is the SessionPayload,
 * not the request — this is intentional. It makes the auth contract
 * impossible to miss when reading a route handler.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireAdmin, requireUser, SessionError, type SessionPayload } from './session';
import { getRequestContext, withRequestContext } from './request-context';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type EmptyParams = {};

export type RouteContext<P = EmptyParams> = { params: Promise<P> };

export type PublicHandler<P = EmptyParams> = (
  req: NextRequest,
  ctx: RouteContext<P>,
) => Promise<Response>;

export type AuthedHandler<P = EmptyParams> = (
  session: SessionPayload,
  req: NextRequest,
  ctx: RouteContext<P>,
) => Promise<Response>;

function deriveRequestId(req: NextRequest): string {
  // Honour an upstream-provided request id if present (proxy, gateway,
  // load tester) so traces correlate across the boundary. Otherwise mint
  // a fresh UUID v4.
  return req.headers.get('x-request-id') || randomUUID();
}

function asJsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Outermost wrapper. Establishes the request-context store, catches every
 * thrown exception and turns it into a JSON response. SessionError carries
 * its own status (401 or 403). Anything else is an unexpected 500 and gets
 * logged at error level with the stack.
 */
export function withErrorHandler<P>(handler: PublicHandler<P>): PublicHandler<P> {
  return async (req, ctx) => {
    const request_id = deriveRequestId(req);
    return withRequestContext(
      { request_id, route: req.nextUrl?.pathname },
      async () => {
        try {
          const response = await handler(req, ctx);
          // Echo the request id on the response so clients (and the dev
          // network panel) can correlate logs.
          response.headers.set('x-request-id', request_id);
          return response;
        } catch (err) {
          if (err instanceof SessionError) {
            const r = asJsonError(err.message, err.status);
            r.headers.set('x-request-id', request_id);
            return r;
          }
          const detail = err instanceof Error ? err.stack || err.message : String(err);
          logger.error('route handler threw', { detail });
          const r = asJsonError('Internal server error', 500);
          r.headers.set('x-request-id', request_id);
          return r;
        }
      },
    );
  };
}

/**
 * Authentication gate. Throws SessionError(401) on no/invalid session;
 * the surrounding withErrorHandler turns that into a JSON 401.
 */
export function withAuth<P>(handler: AuthedHandler<P>): PublicHandler<P> {
  return async (req, ctx) => {
    const session = await requireUser();
    const stored = getRequestContext();
    if (stored) {
      stored.user_id = session.uid;
      stored.workspace_id = session.ws;
    }
    return handler(session, req, ctx);
  };
}

/**
 * Admin gate. Throws SessionError(401) without a session, SessionError(403)
 * when system_role !== 'admin'. The surrounding withErrorHandler maps both.
 */
export function withAdmin<P>(handler: AuthedHandler<P>): PublicHandler<P> {
  return async (req, ctx) => {
    const session = await requireAdmin();
    const stored = getRequestContext();
    if (stored) {
      stored.user_id = session.uid;
      stored.workspace_id = session.ws;
    }
    return handler(session, req, ctx);
  };
}

export interface KnownErrorPattern {
  /** Regex against err.message. The first matching pattern wins. */
  match: RegExp;
  /** HTTP status to return for this domain error. Use 4xx for user
   *  errors (404, 409, 422). The error message passes through to the
   *  client as-is — only known/expected messages should be in this list. */
  status: number;
}

/**
 * Standard error response for catch blocks in domain-action routes
 * (start an A/B test, conclude one, post a comment reply, etc).
 *
 * Two-tier classification:
 *   1. If `err.message` matches a known pattern, log at WARN and pass
 *      the message through to the client (4xx). These are user-facing
 *      explanations of expected failure modes — surfacing them is the
 *      point.
 *   2. Otherwise log at ERROR with the full detail and return a
 *      generic 502/500 message — never leak the raw exception text to
 *      the client because it can include DB/internal API details.
 *
 * Replaces the 17-route copy-pasted pattern of regex-mapping
 * `err.message` to a status code and returning the message verbatim.
 */
export function domainErrorResponse(
  err: unknown,
  opts: {
    /** Short label for the log line: e.g. 'critic-panel: complete'. */
    op: string;
    /** Known patterns checked in order. First match wins. */
    knownPatterns?: KnownErrorPattern[];
    /** Status when no pattern matches. Defaults to 502 (upstream
     *  failure — most route catches wrap external/AI calls). */
    fallbackStatus?: number;
    /** Generic message returned with the fallback status. Defaults to
     *  a polite "try again" string. Routes can override to be
     *  domain-specific (e.g. 'Could not start the AB test.'). */
    fallbackMessage?: string;
  },
): NextResponse {
  const detail = err instanceof Error ? err.message : String(err);
  const matched = opts.knownPatterns?.find((p) => p.match.test(detail));
  if (matched) {
    logger.warn(`${opts.op}: known failure → ${matched.status}`, { detail });
    return NextResponse.json({ error: detail }, { status: matched.status });
  }
  logger.error(`${opts.op}: unexpected failure`, { detail });
  return NextResponse.json(
    { error: opts.fallbackMessage ?? 'Operation failed — please try again.' },
    { status: opts.fallbackStatus ?? 502 },
  );
}

/**
 * Convenience composer. Routes prefer this over wiring withErrorHandler +
 * withAuth manually so the wrappers always compose in the same order.
 */
export const apiRoute = {
  /** Logged-in users only. The handler receives the session as its first arg. */
  authed<P = EmptyParams>(handler: AuthedHandler<P>): PublicHandler<P> {
    return withErrorHandler(withAuth(handler));
  },
  /** Admin users only. Same shape as authed. */
  admin<P = EmptyParams>(handler: AuthedHandler<P>): PublicHandler<P> {
    return withErrorHandler(withAdmin(handler));
  },
  /** No auth required. Wraps with the error handler so 500s + request ids work. */
  public<P = EmptyParams>(handler: PublicHandler<P>): PublicHandler<P> {
    return withErrorHandler(handler);
  },
};
