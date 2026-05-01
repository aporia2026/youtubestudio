/**
 * Per-request async-local store. Carries a request id (always) plus the
 * authenticated user / workspace ids (filled in once auth succeeds) so the
 * structured logger can emit them on every line without a function-arg dance.
 *
 * The store is mutable on purpose — `withErrorHandler` enters the context
 * with just `{ request_id, route }`, and `withAuth` / `withAdmin` mutate
 * `user_id` and `workspace_id` onto the existing object once the session
 * resolves. Nothing else should mutate the store.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  request_id: string;
  route?: string;
  user_id?: string;
  workspace_id?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function withRequestContext<T>(ctx: RequestContext, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run(ctx, fn);
}
