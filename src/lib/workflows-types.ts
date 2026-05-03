/**
 * Client-safe types + the trigger/action registry for workflow rules.
 */

/**
 * Trigger events that can fire workflow rules. Mostly overlaps with the
 * webhook event registry on purpose — webhooks and workflows answer
 * different questions (notify a human vs. take an automated action),
 * but both subscribe to the same producer events.
 */
export const WORKFLOW_TRIGGER_EVENTS = [
  {
    type: 'ab_test_concluded',
    label: 'A/B test concluded',
    description: 'When the operator picks a winner on /ab-tests.',
    payload_fields: ['video_id', 'winner', 'channel_db_id'],
  },
  {
    type: 'cannibalization_high_risk',
    label: 'High-risk cannibalization detected',
    description: 'When a scan creates a high-risk overlap alert.',
    payload_fields: ['similarity', 'channel_a', 'channel_b'],
  },
  {
    type: 'video_analytics_synced',
    label: 'Video analytics refreshed',
    description: 'After a video_analytics sync — fields include observed CTR + AVP.',
    payload_fields: ['video_id', 'channel_db_id', 'ctr_percentage', 'average_view_percentage', 'views'],
  },
  {
    type: 'critic_panel_completed',
    label: 'Court of Critics panel completed',
    description: 'When a script panel finishes — overall_score + consensus_pass available.',
    payload_fields: ['panel_id', 'overall_score', 'consensus_pass'],
  },
  {
    type: 'video_published',
    label: 'Video published to YouTube',
    description: 'When a Publish-to-YouTube row flips to "live" — useful for "post to Slack when published" or "schedule a 7-day analytics snapshot".',
    payload_fields: ['publish_id', 'youtube_video_id', 'youtube_url', 'channel_db_id', 'project_id', 'schedule_item_id', 'title', 'privacy_status'],
  },
] as const;

export type WorkflowTriggerEventType = (typeof WORKFLOW_TRIGGER_EVENTS)[number]['type'];

export function isWorkflowTriggerEvent(value: unknown): value is WorkflowTriggerEventType {
  if (typeof value !== 'string') return false;
  return (WORKFLOW_TRIGGER_EVENTS as ReadonlyArray<{ type: string }>).some((e) => e.type === value);
}

/**
 * Action types the workflow runner knows how to execute. Each maps 1:1 to
 * a function in src/lib/workflows.ts under `executeAction`. Adding to the
 * union here without wiring the executor will silently mark runs as
 * skipped (with an "unknown action" reason).
 */
export const WORKFLOW_ACTION_TYPES = [
  {
    type: 'sync_video_analytics',
    label: 'Re-sync video analytics',
    description: 'Refresh view counts + retention curve for a YouTube video. Needs video_id + channel_db_id from the trigger payload.',
    config_fields: [],
  },
  {
    type: 'run_dip_analysis',
    label: 'Run fix-the-dip on a video',
    description: 'Detect retention drops + AI-suggest fixes. Needs the video to already have a script in the configured project.',
    config_fields: ['scriptText (required)'],
  },
  {
    type: 'run_cannibalization_scan',
    label: 'Run cannibalization scan',
    description: 'Pull cross-channel overlap alerts for the workspace. Useful as a daily cron-style schedule.',
    config_fields: ['windowDays (optional)'],
  },
  {
    type: 'send_webhook_event',
    label: 'Send a webhook',
    description: 'Fire a synthetic webhook event to all matching subscriptions. Use when you want a notification with a custom title.',
    config_fields: ['title (required)', 'detail (optional)'],
  },
] as const;

export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number]['type'];

export function isWorkflowActionType(value: unknown): value is WorkflowActionType {
  if (typeof value !== 'string') return false;
  return (WORKFLOW_ACTION_TYPES as ReadonlyArray<{ type: string }>).some((a) => a.type === value);
}

/**
 * Condition shape — supports just enough expressiveness for the common
 * cases ("only fire when CTR < 5%", "only when winner is variant A")
 * without becoming a full DSL. Empty `{}` means "always match".
 *
 * `field` is a dotted path into the trigger event payload
 * (e.g. "winner", "ctr_percentage", "channel_db_id").
 *
 * `op`:
 *   - `equals` / `not_equals` — works on strings + numbers
 *   - `lt` / `lte` / `gt` / `gte` — numbers only
 *   - `in` — value is an array, field equals any
 *   - `exists` — value ignored, true if field is non-null
 */
export type ConditionOp = 'equals' | 'not_equals' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'exists';

export interface WorkflowCondition {
  field?: string;
  op?: ConditionOp;
  value?: string | number | boolean | Array<string | number>;
  /** When set, ALL sub-conditions must pass. */
  all?: WorkflowCondition[];
  /** When set, ANY sub-condition must pass. */
  any?: WorkflowCondition[];
}

export interface WorkflowRuleRow {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  trigger_event_type: WorkflowTriggerEventType;
  condition: WorkflowCondition;
  action_type: WorkflowActionType;
  action_config: Record<string, unknown>;
  delay_seconds: number;
  created_by_collaborator_id: string | null;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
  fire_count: number;
}

export interface WorkflowActionRunRow {
  id: string;
  workspace_id: string;
  rule_id: string;
  trigger_event_type: string;
  trigger_event_payload: Record<string, unknown>;
  scheduled_for: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  action_type: string;
  action_config: Record<string, unknown>;
  result: Record<string, unknown>;
  error_message: string | null;
  attempts: number;
  duration_ms: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Common max-delay knob for the UI — 30 days. Mirrored in the migration's
 *  CHECK constraint (2592000 seconds). */
export const WORKFLOW_MAX_DELAY_SECONDS = 30 * 24 * 60 * 60;
