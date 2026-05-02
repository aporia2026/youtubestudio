import type { Migration } from './types';

/**
 * Outbound Slack/Discord webhooks.
 *
 * Per-workspace subscriptions: a list of webhook URLs (typically a Slack
 * incoming webhook or a Discord channel webhook) with per-event filters.
 * When an interesting thing happens in the workspace (A/B test
 * concluded, cannibalization detected, etc.), the dispatcher checks
 * which subscriptions are subscribed to that event type and fires.
 *
 * `webhook_url` is encrypted at rest using src/lib/crypto.ts (AES-256-
 * GCM) — these tokens are bearer credentials. Never SELECT them in any
 * route that returns data to the client; expose only `url_preview`
 * (the host + last 4 chars).
 *
 * `webhook_deliveries` is the audit log — every send attempt stamped
 * with HTTP status + response body (truncated). Used for the "recent
 * deliveries" UI and for retry-on-failure logic later.
 */
const migration: Migration = {
  id: '0030_create_webhook_subscriptions',
  description: 'Outbound webhook subscriptions (Slack/Discord) + delivery audit log',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

        kind TEXT NOT NULL DEFAULT 'slack',
        label TEXT NOT NULL,
        webhook_url_encrypted TEXT NOT NULL,
        url_preview TEXT NOT NULL,

        event_filters TEXT[] NOT NULL DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,

        created_by_collaborator_id UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_delivery_at TIMESTAMPTZ,
        last_delivery_status INTEGER,

        CONSTRAINT webhook_subscriptions_kind_chk
          CHECK (kind IN ('slack','discord','generic'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_workspace
        ON webhook_subscriptions(workspace_id, enabled, kind)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,

        event_type TEXT NOT NULL,
        event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,

        http_status INTEGER,
        response_body TEXT,
        error_message TEXT,
        succeeded BOOLEAN NOT NULL DEFAULT FALSE,
        duration_ms INTEGER,

        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
        ON webhook_deliveries(subscription_id, sent_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_workspace
        ON webhook_deliveries(workspace_id, sent_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS webhook_deliveries`);
    await client.query(`DROP TABLE IF EXISTS webhook_subscriptions`);
  },
};

export default migration;
