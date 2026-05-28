/**
 * Server-side ledger writer for paid AI-provider generations.
 *
 * Phase 1.0 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md). Every paid generation
 * route calls `recordIntent` BEFORE invoking the provider, then
 * `markDelivered` on success or `markFailed` on error. The resulting
 * rows in `provider_generations` (migration 0100) are scanned nightly
 * by the reconciliation cron to recover orphaned charges — generations
 * where the provider was billed but the URL never reached a
 * user-visible `project_assets` row.
 *
 * Design contract:
 *
 *   - `recordIntent` is NOT fire-and-forget. If we can't write the
 *     intent row, we MUST NOT call the provider — that's the exact bug
 *     class this table prevents. The helper throws on failure and the
 *     route is expected to surface a 503 to the client, telling them
 *     to retry. Better a transient failure than another untraceable
 *     charge.
 *
 *   - `markDelivered` and `markFailed` ARE fire-and-forget. By the time
 *     either runs, the provider has already been called; failing to
 *     update the row leaves it in 'pending' state and the
 *     reconciliation cron will later sweep it (pending rows older than
 *     ~10 minutes are treated as crashed mid-generation; the row's
 *     route + intent metadata is enough for forensics even without the
 *     terminal status). We don't want a logging glitch to take down
 *     the user's already-completed generation.
 *
 *   - `clientIntentId` is OPTIONAL in Phase 1.0. Once Phase 1.2 ships
 *     the client-side `mutate()` chokepoint, the X-Intent-Id header
 *     will be set and we can dedupe retries at the server. Until then,
 *     each call produces a fresh row.
 *
 *   - `costUsd` is best-effort. Some providers (Kie polling, Atlas
 *     async) don't return a cost in the response; the route either
 *     looks it up from a static price table (image-models.ts) or leaves
 *     it null. The reconciliation cron flags rows with NULL cost so we
 *     can backfill via provider billing exports periodically.
 *
 * Why a dedicated helper instead of inlining the SQL in every route:
 *   1. Single source of truth for the status transitions (pending →
 *      delivered/failed/etc.). If we ever add an enum value or change
 *      the column shape, one file to edit.
 *   2. Consistent namespaced logging — every paid call lands in the
 *      same Sentry breadcrumb stream with the same field names.
 *   3. Makes the API contract explicit at every call site: routes
 *      that bypass this helper become very visible during code review
 *      and the Phase 2.1 ESLint rule.
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';

export type ProviderGenerationStatus =
  | 'pending'
  | 'delivered'
  | 'attached'
  | 'failed'
  | 'refund_pending'
  | 'recovered'
  | 'refunded';

export type ProviderGenerationSlot = 'image' | 'overlay' | 'clip' | 'thumbnail';

export interface RecordIntentArgs {
  /** Per-call client-generated UUID. Optional in Phase 1.0; set once
   *  the client-side `mutate()` chokepoint (Phase 1.2) is wired up. */
  clientIntentId?: string | null;
  /** Authenticated user id from the session. Nullable so routes that
   *  pre-date `apiRoute.authed` (e.g. /api/thumbnails/image, which is
   *  proxy-gated only and doesn't read the session itself) can still
   *  record a row instead of hard-failing. The DB column matches:
   *  `user_id UUID REFERENCES collaborators(id) ON DELETE SET NULL`. */
  userId: string | null;
  workspaceId?: string | null;
  /** The route this call originated from, for forensics. Use the path
   *  string, e.g. `/api/generate/production-doc/image`. */
  route: string;
  /** Where this generation will land if the client successfully
   *  attaches the URL via /row-asset. Nullable for ad-hoc / test
   *  flows that aren't tied to a project row. */
  projectId?: string | null;
  rowIndex?: number | null;
  slot?: ProviderGenerationSlot | null;
  /** Provider identifier — keep stable across calls so the cost
   *  rollup and reconciliation cron can group reliably. */
  provider: string;
  /** The specific model variant invoked, e.g. `nano-banana-pro`,
   *  `gpt-image-2-mini`, `flux-2-pro`. */
  providerModel?: string | null;
}

export interface MarkDeliveredArgs {
  id: string;
  /** The provider's request id (Kie taskId, Replicate prediction.id,
   *  Atlas UUID). Stored so support can join from a provider's
   *  invoice / dashboard back to our row. */
  providerRequestId?: string | null;
  /** The final URL — usually the R2-mirrored URL, falling back to the
   *  provider's URL if the mirror fails. */
  responseUrl: string;
  /** Best-effort USD cost. Pass null if the route doesn't know. */
  costUsd?: number | null;
  /** End-to-end ms for the provider call. */
  durationMs?: number | null;
}

export interface MarkFailedArgs {
  id: string;
  /** Human-readable reason — truncated to 400 chars before write. */
  failureReason: string;
  /** Optional provider id if the call got far enough to return one. */
  providerRequestId?: string | null;
  durationMs?: number | null;
}

export interface RecordIntentResult {
  /** UUID of the inserted row. Pass to `markDelivered` / `markFailed`. */
  id: string;
}

/**
 * Insert a 'pending' row BEFORE calling the provider. Throws on DB
 * failure so the caller can short-circuit instead of charging the
 * provider with no record. Logs are namespaced `[provider-generations
 * pending]`.
 */
export async function recordIntent(args: RecordIntentArgs): Promise<RecordIntentResult> {
  const slot = args.slot ?? null;
  const projectId = args.projectId ?? null;
  const rowIndex = args.rowIndex ?? null;
  const workspaceId = args.workspaceId ?? null;
  const clientIntentId = args.clientIntentId ?? null;
  const providerModel = args.providerModel ?? null;

  try {
    // Branch on clientIntentId presence. When present, use ON CONFLICT
    // to short-circuit client-side retries (Phase 1.2 behaviour). When
    // absent (Phase 1.0 before mutate() ships), plain INSERT — the
    // partial unique index excludes NULL rows so we'd never conflict
    // anyway, but spelling that out keeps the SQL simple and avoids
    // any Postgres edge case around partial-index conflict inference
    // with NULL conflict targets.
    let id: string | undefined;
    if (clientIntentId) {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO provider_generations (
          client_intent_id, user_id, workspace_id,
          project_id, row_index, slot,
          route, provider, provider_model,
          status
        ) VALUES (
          ${clientIntentId}::uuid,
          ${args.userId}::uuid,
          ${workspaceId}::uuid,
          ${projectId}::uuid,
          ${rowIndex},
          ${slot},
          ${args.route},
          ${args.provider},
          ${providerModel},
          'pending'
        )
        ON CONFLICT (client_intent_id)
          WHERE client_intent_id IS NOT NULL
        DO UPDATE SET
          updated_at = NOW()
        RETURNING id
      `;
      id = rows[0]?.id;
    } else {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO provider_generations (
          user_id, workspace_id,
          project_id, row_index, slot,
          route, provider, provider_model,
          status
        ) VALUES (
          ${args.userId}::uuid,
          ${workspaceId}::uuid,
          ${projectId}::uuid,
          ${rowIndex},
          ${slot},
          ${args.route},
          ${args.provider},
          ${providerModel},
          'pending'
        )
        RETURNING id
      `;
      id = rows[0]?.id;
    }
    if (!id) {
      throw new Error('provider-generations insert returned no id');
    }
    logger.info('[provider-generations pending]', {
      id,
      route: args.route,
      provider: args.provider,
      provider_model: providerModel,
      project_id: projectId,
      row_index: rowIndex,
      slot,
      client_intent_id: clientIntentId,
    });
    return { id };
  } catch (err) {
    logger.error('[provider-generations pending failed]', {
      route: args.route,
      provider: args.provider,
      project_id: projectId,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Update a previously-recorded intent to 'delivered' with the
 * provider's request id and the final response URL. Fire-and-forget —
 * a logging failure here doesn't undo the successful provider call.
 */
export async function markDelivered(args: MarkDeliveredArgs): Promise<void> {
  try {
    await sql`
      UPDATE provider_generations
         SET status = 'delivered',
             provider_request_id = ${args.providerRequestId ?? null},
             response_url = ${args.responseUrl},
             cost_usd = ${args.costUsd ?? null},
             duration_ms = ${args.durationMs ?? null},
             updated_at = NOW()
       WHERE id = ${args.id}::uuid
         AND status = 'pending'
    `;
    logger.info('[provider-generations delivered]', {
      id: args.id,
      provider_request_id: args.providerRequestId,
      cost_usd: args.costUsd ?? null,
      duration_ms: args.durationMs ?? null,
    });
  } catch (err) {
    logger.warn('[provider-generations delivered update failed]', {
      id: args.id,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Update a previously-recorded intent to 'failed' with the reason.
 * Fire-and-forget for the same reason as `markDelivered`. The status
 * predicate `status = 'pending'` keeps idempotent retries from
 * overwriting an already-terminal row.
 */
export async function markFailed(args: MarkFailedArgs): Promise<void> {
  const reason = args.failureReason.slice(0, 400);
  try {
    await sql`
      UPDATE provider_generations
         SET status = 'failed',
             provider_request_id = COALESCE(${args.providerRequestId ?? null}, provider_request_id),
             failure_reason = ${reason},
             duration_ms = ${args.durationMs ?? null},
             updated_at = NOW()
       WHERE id = ${args.id}::uuid
         AND status = 'pending'
    `;
    logger.info('[provider-generations failed]', {
      id: args.id,
      provider_request_id: args.providerRequestId,
      reason,
    });
  } catch (err) {
    logger.warn('[provider-generations failed update failed]', {
      id: args.id,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
