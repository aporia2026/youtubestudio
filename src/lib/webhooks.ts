/**
 * Outbound webhook dispatcher.
 *
 * Workspace owners configure 1+ subscriptions on /webhooks: a Slack
 * incoming webhook URL or a Discord channel webhook URL, plus a list
 * of event types they care about. When `dispatchWebhookEvent` is called
 * (typically by an orchestrator like concludeAbTest), every matching
 * subscription is fired with a kind-formatted payload.
 *
 * Failures DO NOT propagate — webhook delivery is fire-and-forget so a
 * Slack outage can't break A/B-test conclusion. Every send is logged
 * to `webhook_deliveries` so the user can see what happened.
 *
 * URL secrecy:
 *   - The full URL is encrypted at rest via src/lib/crypto.ts
 *   - Routes return only `url_preview` (host + last 4 chars). The
 *     full URL never leaves the server.
 *   - We URL-validate at create time: must be HTTPS, must point at the
 *     known host of the chosen kind (slack.com / discord.com / discordapp.com).
 *     Generic webhooks bypass the host check.
 */
import { sql } from '@vercel/postgres';
import { encrypt, decrypt } from './crypto';
import { logger } from './logger';
import { checkSafePublicUrl } from './url-safety';
import {
  WEBHOOK_LABEL_MAX,
  WEBHOOK_URL_PREVIEW_LEN,
  isWebhookEventType,
  type WebhookDeliveryRow,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookKind,
  type WebhookSubscriptionRow,
} from './webhooks-types';

export type {
  WebhookDeliveryRow,
  WebhookEvent,
  WebhookEventType,
  WebhookKind,
  WebhookSubscriptionRow,
} from './webhooks-types';

// ---------------------------------------------------------------------------
// URL validation + preview
// ---------------------------------------------------------------------------

const SLACK_HOSTS: ReadonlySet<string> = new Set(['hooks.slack.com']);
const DISCORD_HOSTS: ReadonlySet<string> = new Set(['discord.com', 'discordapp.com']);

export function validateWebhookUrl(kind: WebhookKind, raw: string): { ok: true; url: string } | { ok: false; error: string } {
  // SSRF + protocol + private-IP/host checks centralised in url-safety.
  // Per-kind host pinning runs through the same helper via allowedHosts.
  // Audit M6: previously the `generic` kind got only the partial private-
  // address blocklist defined inline here. Now every kind goes through
  // the comprehensive RFC1918 / loopback / link-local / IMDS / IPv6
  // private-range checks plus protocol enforcement.
  const allowedHosts =
    kind === 'slack' ? SLACK_HOSTS :
    kind === 'discord' ? DISCORD_HOSTS :
    undefined;  // generic — no host pinning, but SSRF block list still applies
  const r = checkSafePublicUrl(raw, {
    allowedProtocols: ['https:'],
    allowedHosts,
  });
  if (!r.ok) return { ok: false, error: `Webhook URL rejected: ${r.error}` };
  return { ok: true, url: r.url.toString() };
}

export function buildUrlPreview(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = url.length > 4 ? url.slice(-4) : '****';
    const head = `${parsed.host}${parsed.pathname.split('/').slice(0, 3).join('/')}`;
    const combined = `${head}…${tail}`;
    return combined.length > WEBHOOK_URL_PREVIEW_LEN
      ? combined.slice(0, WEBHOOK_URL_PREVIEW_LEN - 1) + '…'
      : combined;
  } catch {
    return url.slice(0, WEBHOOK_URL_PREVIEW_LEN);
  }
}

// ---------------------------------------------------------------------------
// Payload formatting
// ---------------------------------------------------------------------------

/**
 * Slack incoming-webhook payload. Uses Block Kit so the rich layout
 * (header + fields + button) renders correctly in any Slack workspace.
 */
export function formatSlackPayload(event: WebhookEvent): Record<string, unknown> {
  const fieldEntries = Object.entries(event.fields ?? {}).filter(([, v]) => v !== null && v !== undefined);
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: event.title.slice(0, 150), emoji: true },
    },
  ];
  if (event.detail) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: event.detail.slice(0, 2900) },
    });
  }
  if (fieldEntries.length > 0) {
    blocks.push({
      type: 'section',
      fields: fieldEntries.slice(0, 10).map(([k, v]) => ({
        type: 'mrkdwn',
        text: `*${k}:*\n${String(v).slice(0, 200)}`,
      })),
    });
  }
  if (event.url) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Studio', emoji: true },
          url: event.url,
        },
      ],
    });
  }
  return {
    text: event.title.slice(0, 250), // fallback for notifications
    blocks,
  };
}

/**
 * Discord webhook payload. Uses an embed for rich layout. Fields cap at
 * 25 per Discord's API; we already cap at 10 below.
 */
export function formatDiscordPayload(event: WebhookEvent): Record<string, unknown> {
  const fieldEntries = Object.entries(event.fields ?? {}).filter(([, v]) => v !== null && v !== undefined);
  const colorByEvent: Partial<Record<WebhookEventType, number>> = {
    cannibalization_high_risk: 0xf87171,
    retention_dip_severe: 0xfb923c,
    ab_test_concluded: 0xc084fc,
    critic_panel_completed: 0x4ade80,
    test: 0x60a5fa,
  };
  const embed: Record<string, unknown> = {
    title: event.title.slice(0, 256),
    description: event.detail ? event.detail.slice(0, 4000) : undefined,
    color: colorByEvent[event.type] ?? 0xa78bfa,
    timestamp: new Date().toISOString(),
    fields:
      fieldEntries.length > 0
        ? fieldEntries.slice(0, 10).map(([k, v]) => ({
            name: k.slice(0, 256),
            value: String(v).slice(0, 1024),
            inline: true,
          }))
        : undefined,
    url: event.url,
    footer: { text: 'YouTube Studio' },
  };
  return { embeds: [embed] };
}

/** Plain "generic" sender — for any HTTPS endpoint that wants the raw
 *  event JSON (Zapier hooks, custom n8n flows, etc.). */
export function formatGenericPayload(event: WebhookEvent): Record<string, unknown> {
  return {
    type: event.type,
    title: event.title,
    detail: event.detail ?? null,
    fields: event.fields ?? {},
    url: event.url ?? null,
    sent_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

interface DeliveryAttempt {
  http_status: number | null;
  response_body: string | null;
  error_message: string | null;
  succeeded: boolean;
  duration_ms: number;
}

async function sendOnce(url: string, body: Record<string, unknown>): Promise<DeliveryAttempt> {
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const duration = Date.now() - startedAt;
    const responseText = await res.text().catch(() => '');
    return {
      http_status: res.status,
      response_body: responseText.slice(0, 1000),
      error_message: null,
      succeeded: res.ok,
      duration_ms: duration,
    };
  } catch (err) {
    return {
      http_status: null,
      response_body: null,
      error_message: err instanceof Error ? err.message : String(err),
      succeeded: false,
      duration_ms: Date.now() - startedAt,
    };
  }
}

/**
 * Fire-and-forget event dispatch. Loads matching subscriptions for the
 * workspace, formats the payload per kind, sends, and records every
 * attempt. Errors are LOGGED but never thrown — webhook reliability
 * is the user's problem, not the producer's.
 */
export async function dispatchWebhookEvent(workspaceId: string, event: WebhookEvent): Promise<void> {
  if (!isWebhookEventType(event.type)) {
    logger.warn('webhooks: dispatch with unknown event type', { type: event.type });
    return;
  }
  let subs: Array<{ id: string; kind: WebhookKind; webhook_url_encrypted: string; event_filters: string[] }>;
  try {
    const { rows } = await sql<{ id: string; kind: WebhookKind; webhook_url_encrypted: string; event_filters: string[] }>`
      SELECT id, kind, webhook_url_encrypted, event_filters
        FROM webhook_subscriptions
       WHERE workspace_id = ${workspaceId}::uuid
         AND enabled = TRUE
    `;
    subs = rows;
  } catch (err) {
    logger.error('webhooks: failed to load subscriptions', { detail: err instanceof Error ? err.message : String(err) });
    return;
  }

  const matching = subs.filter(
    (s) =>
      // Empty filters = subscribe to all events. Test events ignore filters.
      event.type === 'test' || s.event_filters.length === 0 || s.event_filters.includes(event.type),
  );
  if (matching.length === 0) return;

  // Cap fan-out concurrency at 5. Without this, a workspace with 50
  // subscriptions and one slow Slack endpoint would block the whole
  // dispatch on Promise.allSettled until the slowest tail returned —
  // burning the producer's wall-clock budget. Audit M7.
  await runWithConcurrency(matching, 5, async (sub) => {
      let url: string;
      try {
        url = decrypt(sub.webhook_url_encrypted);
      } catch (err) {
        logger.error('webhooks: failed to decrypt URL', {
          subscription_id: sub.id,
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const payload =
        sub.kind === 'slack'
          ? formatSlackPayload(event)
          : sub.kind === 'discord'
            ? formatDiscordPayload(event)
            : formatGenericPayload(event);
      const attempt = await sendOnce(url, payload);

      await sql`
        INSERT INTO webhook_deliveries (
          workspace_id, subscription_id, event_type, event_payload,
          http_status, response_body, error_message, succeeded, duration_ms
        ) VALUES (
          ${workspaceId}::uuid,
          ${sub.id}::uuid,
          ${event.type},
          ${JSON.stringify({ title: event.title, detail: event.detail, fields: event.fields, url: event.url })}::jsonb,
          ${attempt.http_status},
          ${attempt.response_body},
          ${attempt.error_message},
          ${attempt.succeeded},
          ${attempt.duration_ms}
        )
      `.catch((err) => logger.warn('webhooks: failed to log delivery', { detail: err instanceof Error ? err.message : String(err) }));

      await sql`
        UPDATE webhook_subscriptions
           SET last_delivery_at = NOW(),
               last_delivery_status = ${attempt.http_status},
               updated_at = NOW()
         WHERE id = ${sub.id}::uuid
      `.catch(() => { /* ignore */ });
    });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateWebhookSubscriptionArgs {
  workspaceId: string;
  collaboratorId: string | null;
  kind: WebhookKind;
  label: string;
  webhookUrl: string;
  eventFilters: string[];
}

export async function createWebhookSubscription(args: CreateWebhookSubscriptionArgs): Promise<{ id: string }> {
  const label = args.label.trim().slice(0, WEBHOOK_LABEL_MAX) || `${args.kind} webhook`;
  const validation = validateWebhookUrl(args.kind, args.webhookUrl);
  if (!validation.ok) throw new Error(validation.error);

  // Filter event_filters to known event types — drop anything unknown.
  const filters = args.eventFilters.filter(isWebhookEventType);

  const encrypted = encrypt(validation.url);
  const preview = buildUrlPreview(validation.url);

  // Postgres TEXT[] literal — same defensive pattern as in
  // retention-predictor.ts. Strip anything that isn't a recognised event
  // type so we can never inject a stray brace into the literal.
  const filtersLiteral = `{${filters.map((f) => f.replace(/[^A-Za-z0-9_]/g, '')).join(',')}}`;

  const { rows } = await sql<{ id: string }>`
    INSERT INTO webhook_subscriptions (
      workspace_id, kind, label, webhook_url_encrypted, url_preview,
      event_filters, enabled, created_by_collaborator_id
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.kind},
      ${label},
      ${encrypted},
      ${preview},
      ${filtersLiteral}::text[],
      TRUE,
      ${args.collaboratorId}::uuid
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export interface UpdateWebhookSubscriptionArgs {
  id: string;
  workspaceId: string;
  label?: string;
  enabled?: boolean;
  eventFilters?: string[];
}

export async function updateWebhookSubscription(args: UpdateWebhookSubscriptionArgs): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (args.label !== undefined) {
    sets.push(`label = $${i++}`);
    vals.push(args.label.trim().slice(0, WEBHOOK_LABEL_MAX));
  }
  if (args.enabled !== undefined) {
    sets.push(`enabled = $${i++}`);
    vals.push(args.enabled);
  }
  if (args.eventFilters !== undefined) {
    const filters = args.eventFilters.filter(isWebhookEventType);
    const filtersLiteral = `{${filters.map((f) => f.replace(/[^A-Za-z0-9_]/g, '')).join(',')}}`;
    sets.push(`event_filters = $${i++}::text[]`);
    vals.push(filtersLiteral);
  }
  if (sets.length === 0) return true;
  sets.push(`updated_at = NOW()`);
  vals.push(args.id, args.workspaceId);
  const result = await sql.query(
    `UPDATE webhook_subscriptions SET ${sets.join(', ')} WHERE id = $${i++}::uuid AND workspace_id = $${i}::uuid`,
    vals,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteWebhookSubscription(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM webhook_subscriptions
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}

export async function listWebhookSubscriptions(workspaceId: string): Promise<WebhookSubscriptionRow[]> {
  const { rows } = await sql<WebhookSubscriptionRow>`
    SELECT id, workspace_id, kind, label, url_preview,
           event_filters, enabled, created_by_collaborator_id,
           created_at::text AS created_at,
           updated_at::text AS updated_at,
           last_delivery_at::text AS last_delivery_at,
           last_delivery_status
      FROM webhook_subscriptions
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY created_at DESC
  `;
  return rows;
}

export async function listWebhookDeliveries(
  workspaceId: string,
  opts: { subscriptionId?: string; limit?: number } = {},
): Promise<WebhookDeliveryRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.subscriptionId) {
    const { rows } = await sql<WebhookDeliveryRow>`
      SELECT id, workspace_id, subscription_id, event_type, event_payload,
             http_status, response_body, error_message, succeeded,
             duration_ms, sent_at::text AS sent_at
        FROM webhook_deliveries
       WHERE workspace_id = ${workspaceId}::uuid
         AND subscription_id = ${opts.subscriptionId}::uuid
       ORDER BY sent_at DESC
       LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<WebhookDeliveryRow>`
    SELECT id, workspace_id, subscription_id, event_type, event_payload,
           http_status, response_body, error_message, succeeded,
           duration_ms, sent_at::text AS sent_at
      FROM webhook_deliveries
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY sent_at DESC
     LIMIT ${limit}
  `;
  return rows;
}

/** Send a synthetic "test" event to a single subscription. Bypasses
 *  event_filters so the user always gets the test message. */
export async function sendTestWebhook(id: string, workspaceId: string): Promise<{ ok: boolean; message: string }> {
  const { rows } = await sql<{ kind: WebhookKind; webhook_url_encrypted: string; label: string }>`
    SELECT kind, webhook_url_encrypted, label
      FROM webhook_subscriptions
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid AND enabled = TRUE
     LIMIT 1
  `;
  const sub = rows[0];
  if (!sub) return { ok: false, message: 'Subscription not found or disabled.' };
  let url: string;
  try {
    url = decrypt(sub.webhook_url_encrypted);
  } catch {
    return { ok: false, message: 'Failed to decrypt webhook URL.' };
  }
  const event: WebhookEvent = {
    type: 'test',
    title: '✅ Test webhook from YouTube Studio',
    detail: `If you can see this, the **${sub.label}** subscription is wired correctly.`,
    fields: {
      kind: sub.kind,
      sent_at: new Date().toISOString(),
    },
  };
  const payload =
    sub.kind === 'slack'
      ? formatSlackPayload(event)
      : sub.kind === 'discord'
        ? formatDiscordPayload(event)
        : formatGenericPayload(event);
  const attempt = await sendOnce(url, payload);
  await sql`
    INSERT INTO webhook_deliveries (
      workspace_id, subscription_id, event_type, event_payload,
      http_status, response_body, error_message, succeeded, duration_ms
    ) VALUES (
      ${workspaceId}::uuid,
      ${id}::uuid,
      'test',
      ${JSON.stringify(event)}::jsonb,
      ${attempt.http_status},
      ${attempt.response_body},
      ${attempt.error_message},
      ${attempt.succeeded},
      ${attempt.duration_ms}
    )
  `.catch(() => { /* ignore */ });
  await sql`
    UPDATE webhook_subscriptions
       SET last_delivery_at = NOW(), last_delivery_status = ${attempt.http_status}, updated_at = NOW()
     WHERE id = ${id}::uuid
  `.catch(() => { /* ignore */ });
  return {
    ok: attempt.succeeded,
    message: attempt.succeeded
      ? `Sent. Receiving server replied ${attempt.http_status}.`
      : attempt.error_message ?? `Receiving server replied ${attempt.http_status ?? 'unknown'}.`,
  };
}

// ---------------------------------------------------------------------------
// Concurrency helper (audit M7)
// ---------------------------------------------------------------------------

/**
 * Run `worker(item)` for every item with at most `limit` running in
 * parallel. Always settles after every worker has resolved or
 * rejected — like Promise.allSettled but with bounded concurrency so
 * one slow tail can't hold up everything else queued behind it.
 *
 * Pure helper (no DB / network deps) — exported only as a module-local
 * utility. If a third caller appears, lift to src/lib/concurrency.ts.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const cap = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < cap; i++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          try {
            await worker(items[idx]);
          } catch (err) {
            // Swallow — caller's `worker` is responsible for its own
            // logging. Keeps the runner alive so other items still process.
            logger.warn('webhooks: worker threw', {
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })(),
    );
  }
  await Promise.all(runners);
}
