/**
 * Minimal structured JSON logger. Emits one line per event to stdout (info,
 * debug) or stderr (warn, error). Vercel captures both into its log drain
 * and the JSON shape lets future log-search tooling (Axiom, Logflare,
 * Sentry breadcrumbs) parse fields without regex.
 *
 * Pulls request id / user id / workspace id from the AsyncLocalStorage in
 * request-context.ts when they're set; otherwise emits without them. No
 * dependency on Sentry — that's wired in PR #7 via instrumentation.ts.
 */
import { getRequestContext } from './request-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogLine {
  ts: string;
  level: LogLevel;
  msg: string;
  request_id?: string;
  route?: string;
  user_id?: string;
  workspace_id?: string;
  [key: string]: unknown;
}

function emit(line: LogLine): void {
  // JSON.stringify with no replacer drops `undefined` fields, which is
  // exactly what we want — keeps lines readable when no context is present.
  const text = JSON.stringify(line) + '\n';
  if (line.level === 'error' || line.level === 'warn') {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
  }
}

function logAt(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const ctx = getRequestContext();
  emit({
    ts: new Date().toISOString(),
    level,
    msg,
    request_id: ctx?.request_id,
    route: ctx?.route,
    user_id: ctx?.user_id,
    workspace_id: ctx?.workspace_id,
    ...fields,
  });
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>): void => logAt('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>): void => logAt('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>): void => logAt('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>): void => logAt('error', msg, fields),
};
