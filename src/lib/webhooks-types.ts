/**
 * Client-safe types + the event registry for outbound webhooks.
 */

export type WebhookKind = 'slack' | 'discord' | 'generic';

/**
 * Every event the dispatcher can emit. Keep this in sync with the
 * places in the codebase that call `dispatchWebhookEvent` — adding to
 * the union here without wiring it from a producer is harmless (just
 * means no one ever fires it); removing one breaks producers silently.
 *
 * UI uses the descriptions to render the per-event subscription
 * checkboxes on /webhooks.
 */
export const WEBHOOK_EVENT_TYPES = [
  {
    type: 'ab_test_concluded',
    label: 'A/B test concluded',
    description: 'Fires when an A/B title/thumbnail test is concluded with a winner.',
  },
  {
    type: 'cannibalization_high_risk',
    label: 'High-risk cannibalization detected',
    description: 'Fires when a scan creates a high-risk cross-channel overlap alert.',
  },
  {
    type: 'critic_panel_completed',
    label: 'Court of Critics panel completed',
    description: 'Fires when a script panel finishes running.',
  },
  {
    type: 'retention_dip_severe',
    label: 'Severe retention dip detected',
    description: 'Fires when fix-the-dip detects a "cliff" severity dip in a published video.',
  },
  {
    type: 'video_published',
    label: 'Video published to YouTube',
    description: 'Fires when a Publish-to-YouTube row flips to "live" (YouTube finished processing the upload).',
  },
  {
    type: 'test',
    label: 'Test event',
    description: 'Manual test from the /webhooks page. Always sends regardless of filters.',
  },
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]['type'];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  if (typeof value !== 'string') return false;
  return (WEBHOOK_EVENT_TYPES as ReadonlyArray<{ type: string }>).some((e) => e.type === value);
}

/** Database row — `webhook_url_encrypted` is NEVER returned to the
 *  client. The route layer projects it to `url_preview` only. */
export interface WebhookSubscriptionRow {
  id: string;
  workspace_id: string;
  kind: WebhookKind;
  label: string;
  url_preview: string;
  event_filters: string[];
  enabled: boolean;
  created_by_collaborator_id: string | null;
  created_at: string;
  updated_at: string;
  last_delivery_at: string | null;
  last_delivery_status: number | null;
}

export interface WebhookDeliveryRow {
  id: string;
  workspace_id: string;
  subscription_id: string;
  event_type: string;
  event_payload: Record<string, unknown>;
  http_status: number | null;
  response_body: string | null;
  error_message: string | null;
  succeeded: boolean;
  duration_ms: number | null;
  sent_at: string;
}

/** Input shape for fire-and-forget event emit. */
export interface WebhookEvent {
  type: WebhookEventType;
  /** Human-readable headline. Slack/Discord show this prominently. */
  title: string;
  /** Optional detail body. Markdown-light (works in both Slack mrkdwn and Discord). */
  detail?: string;
  /** Bag of structured fields — UI uses these for the rich attachment.
   *  Common keys: video_id, channel_name, score, link. */
  fields?: Record<string, string | number | boolean | null>;
  /** Optional click-through URL — both Slack and Discord render it as a link. */
  url?: string;
}

export const WEBHOOK_LABEL_MAX = 80;
export const WEBHOOK_URL_PREVIEW_LEN = 40;
