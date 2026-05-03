import { describe, expect, it } from 'vitest';
import {
  buildUrlPreview,
  formatDiscordPayload,
  formatGenericPayload,
  formatSlackPayload,
  validateWebhookUrl,
} from '@/lib/webhooks';
import { WEBHOOK_EVENT_TYPES, isWebhookEventType } from '@/lib/webhooks-types';

describe('validateWebhookUrl', () => {
  it('accepts a valid Slack webhook URL', () => {
    const out = validateWebhookUrl('slack', 'https://hooks.slack.com/services/T01/B02/abc123');
    expect(out.ok).toBe(true);
  });

  it('accepts both discord.com and discordapp.com', () => {
    expect(validateWebhookUrl('discord', 'https://discord.com/api/webhooks/123/abc').ok).toBe(true);
    expect(validateWebhookUrl('discord', 'https://discordapp.com/api/webhooks/123/abc').ok).toBe(true);
  });

  it('rejects HTTP (must be HTTPS)', () => {
    const out = validateWebhookUrl('slack', 'http://hooks.slack.com/services/T01/B02/abc');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/HTTPS/);
  });

  it('rejects Slack URLs not on hooks.slack.com', () => {
    const out = validateWebhookUrl('slack', 'https://example.com/webhook');
    expect(out.ok).toBe(false);
  });

  it('rejects Discord URLs not on discord.com or discordapp.com', () => {
    const out = validateWebhookUrl('discord', 'https://example.com/webhook');
    expect(out.ok).toBe(false);
  });

  it('rejects loopback / private hosts even when kind=generic', () => {
    expect(validateWebhookUrl('generic', 'https://localhost/hook').ok).toBe(false);
    expect(validateWebhookUrl('generic', 'https://127.0.0.1/hook').ok).toBe(false);
    expect(validateWebhookUrl('generic', 'https://169.254.169.254/').ok).toBe(false);
    expect(validateWebhookUrl('generic', 'https://api.internal/x').ok).toBe(false);
    expect(validateWebhookUrl('generic', 'https://api.local/x').ok).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(validateWebhookUrl('generic', 'not a url').ok).toBe(false);
    expect(validateWebhookUrl('generic', '').ok).toBe(false);
  });

  it('accepts a generic HTTPS URL on a public host', () => {
    expect(validateWebhookUrl('generic', 'https://example.com/api/hook').ok).toBe(true);
  });
});

describe('buildUrlPreview', () => {
  it('strips most of the URL but keeps host + last 4 chars', () => {
    const preview = buildUrlPreview('https://hooks.slack.com/services/T01/B02/abc123def456');
    expect(preview).toContain('hooks.slack.com');
    expect(preview).toMatch(/f456$/);
    expect(preview.length).toBeLessThanOrEqual(40);
  });

  it('does not include the full token in the preview', () => {
    const url = 'https://hooks.slack.com/services/T01/B02/SUPER_SECRET_TOKEN';
    const preview = buildUrlPreview(url);
    expect(preview).not.toContain('SUPER_SECRET');
  });

  it('handles malformed URLs gracefully (truncates)', () => {
    expect(buildUrlPreview('not a url at all that goes way past the cap so we know')).toMatch(/^[^.].{0,40}/);
  });
});

describe('formatSlackPayload', () => {
  it('builds a Block Kit payload with header + text + button', () => {
    const payload = formatSlackPayload({
      type: 'ab_test_concluded',
      title: 'A/B test won',
      detail: 'Variant A wins.',
      fields: { winner: 'A', video_id: 'abc' },
      url: 'https://example.com',
    });
    expect(payload.text).toContain('A/B test won');
    const blocks = payload.blocks as Array<{ type: string }>;
    expect(blocks[0]!.type).toBe('header');
    expect(blocks.some((b) => b.type === 'section')).toBe(true);
    expect(blocks.some((b) => b.type === 'actions')).toBe(true);
  });

  it('omits the actions block when no url is provided', () => {
    const payload = formatSlackPayload({ type: 'test', title: 'x' });
    const blocks = payload.blocks as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
  });

  it('caps at 10 fields', () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 25; i++) fields[`f${i}`] = `${i}`;
    const payload = formatSlackPayload({ type: 'test', title: 'x', fields });
    const blocks = payload.blocks as Array<{ type: string; fields?: unknown[] }>;
    const fieldsBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
    expect((fieldsBlock?.fields ?? []).length).toBeLessThanOrEqual(10);
  });
});

describe('formatDiscordPayload', () => {
  it('builds a single embed with title, description, fields, color', () => {
    const payload = formatDiscordPayload({
      type: 'cannibalization_high_risk',
      title: 'Overlap',
      detail: 'Two channels collide',
      fields: { a: '1', b: '2' },
      url: 'https://example.com',
    });
    const embed = (payload.embeds as Array<Record<string, unknown>>)[0]!;
    expect(embed.title).toBe('Overlap');
    expect(embed.description).toBe('Two channels collide');
    expect((embed.fields as Array<unknown>).length).toBe(2);
    expect(typeof embed.color).toBe('number');
    expect(embed.url).toBe('https://example.com');
  });

  it('uses different colors for different event types', () => {
    const a = (formatDiscordPayload({ type: 'cannibalization_high_risk', title: 'x' }).embeds as Array<{ color: number }>)[0]!;
    const b = (formatDiscordPayload({ type: 'ab_test_concluded', title: 'x' }).embeds as Array<{ color: number }>)[0]!;
    expect(a.color).not.toBe(b.color);
  });
});

describe('formatGenericPayload', () => {
  it('returns a flat JSON object with type/title/detail/fields/url/sent_at', () => {
    const payload = formatGenericPayload({
      type: 'test',
      title: 'hi',
      detail: 'world',
      fields: { x: 1 },
      url: 'https://example.com',
    });
    expect(payload.type).toBe('test');
    expect(payload.title).toBe('hi');
    expect(payload.detail).toBe('world');
    expect((payload.fields as Record<string, unknown>).x).toBe(1);
    expect(payload.url).toBe('https://example.com');
    expect(typeof payload.sent_at).toBe('string');
  });
});

describe('isWebhookEventType', () => {
  it('accepts every declared event type', () => {
    for (const e of WEBHOOK_EVENT_TYPES) {
      expect(isWebhookEventType(e.type)).toBe(true);
    }
  });

  it('rejects unknown strings + non-strings', () => {
    expect(isWebhookEventType('made_up')).toBe(false);
    expect(isWebhookEventType(null)).toBe(false);
    expect(isWebhookEventType(42)).toBe(false);
    expect(isWebhookEventType('')).toBe(false);
  });

  it('includes video_published so the publishing producer can dispatch it', () => {
    expect(isWebhookEventType('video_published')).toBe(true);
  });
});
