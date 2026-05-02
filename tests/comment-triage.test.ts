import { describe, expect, it } from 'vitest';
import { buildTriagePrompt, parseTriageOutput } from '@/lib/comment-triage';
import { parseCommentThreadItem } from '@/lib/youtube-comments';
import {
  COMMENT_INTENT_META,
  COMMENT_INTENT_VALUES,
  isCommentIntent,
} from '@/lib/youtube-comments-types';

describe('isCommentIntent / COMMENT_INTENT_VALUES', () => {
  it('every value in the constant array passes the guard', () => {
    for (const v of COMMENT_INTENT_VALUES) {
      expect(isCommentIntent(v)).toBe(true);
    }
  });
  it('rejects unknown / non-string values', () => {
    expect(isCommentIntent('happy')).toBe(false);
    expect(isCommentIntent(null)).toBe(false);
    expect(isCommentIntent(0)).toBe(false);
    expect(isCommentIntent({})).toBe(false);
  });
  it('every value has display metadata (label + color + description)', () => {
    for (const v of COMMENT_INTENT_VALUES) {
      const meta = COMMENT_INTENT_META[v];
      expect(meta.label).toBeTruthy();
      expect(meta.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(meta.description.length).toBeGreaterThan(20);
    }
  });
});

describe('buildTriagePrompt', () => {
  it('embeds the comment text + author + intent enum in the prompts', () => {
    const { system, user } = buildTriagePrompt({
      comment_text: 'When are you uploading the next part?',
      author_name: 'Alice',
      like_count: 4,
    });
    expect(system).toContain('question');
    expect(system).toContain('troll');
    expect(system).toContain('STRICTLY this JSON');
    expect(user).toContain('When are you uploading the next part?');
    expect(user).toContain('Alice');
    expect(user).toContain('(4 likes)');
  });

  it('omits optional context lines when not provided', () => {
    const { user } = buildTriagePrompt({ comment_text: 'x' });
    expect(user).not.toMatch(/^Video:/m);
    expect(user).not.toMatch(/^Channel:/m);
    expect(user).not.toMatch(/^Niche:/m);
    expect(user).not.toMatch(/^Comment by:/m);
  });

  it('forbids @mentions and URLs in suggested replies (in the system prompt)', () => {
    const { system } = buildTriagePrompt({ comment_text: 'x' });
    expect(system).toMatch(/NEVER include @mentions or URLs/);
  });

  it('forbids replies for trolls / spam / self-promo (in the system prompt)', () => {
    const { system } = buildTriagePrompt({ comment_text: 'x' });
    expect(system).toMatch(/NO reply/);
  });

  it('truncates oversized comment text in the user prompt', () => {
    const huge = 'x'.repeat(10000);
    const { user } = buildTriagePrompt({ comment_text: huge });
    // 4000 char cap inside the prompt builder.
    const between = user.split('"""')[1] ?? '';
    expect(between.trim().length).toBeLessThanOrEqual(4001);
  });
});

describe('parseTriageOutput', () => {
  it('parses a clean JSON response', () => {
    const raw = JSON.stringify({
      intent: 'question',
      confidence: 0.9,
      suggested_reply: 'Great question — covered in the description!',
    });
    const out = parseTriageOutput(raw);
    expect(out.intent).toBe('question');
    expect(out.confidence).toBe(0.9);
    expect(out.suggested_reply).toMatch(/description/);
  });

  it('parses fenced JSON', () => {
    const fenced = '```json\n' + JSON.stringify({ intent: 'fan', confidence: 0.95, suggested_reply: 'thanks!' }) + '\n```';
    const out = parseTriageOutput(fenced);
    expect(out.intent).toBe('fan');
  });

  it('falls back to "other" when intent is missing or invalid', () => {
    expect(parseTriageOutput(JSON.stringify({})).intent).toBe('other');
    expect(parseTriageOutput(JSON.stringify({ intent: 'happy', confidence: 0.5 })).intent).toBe('other');
  });

  it('clamps confidence to [0, 1]', () => {
    expect(parseTriageOutput(JSON.stringify({ intent: 'fan', confidence: 1.7 })).confidence).toBe(1);
    expect(parseTriageOutput(JSON.stringify({ intent: 'fan', confidence: -0.4 })).confidence).toBe(0);
  });

  it('treats string "null" and empty string as no suggested_reply', () => {
    expect(parseTriageOutput(JSON.stringify({ intent: 'troll', confidence: 0.9, suggested_reply: 'null' })).suggested_reply).toBeNull();
    expect(parseTriageOutput(JSON.stringify({ intent: 'spam', confidence: 0.99, suggested_reply: '' })).suggested_reply).toBeNull();
  });

  it('truncates oversized suggested_reply', () => {
    const huge = 'a'.repeat(2000);
    const out = parseTriageOutput(JSON.stringify({ intent: 'fan', confidence: 0.9, suggested_reply: huge }));
    expect(out.suggested_reply!.length).toBeLessThanOrEqual(800);
  });

  it('throws on garbage', () => {
    expect(() => parseTriageOutput('not json at all')).toThrow(/Could not parse JSON/);
  });
});

describe('parseCommentThreadItem', () => {
  function fakeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'thread1',
      snippet: {
        videoId: 'vid1',
        totalReplyCount: 3,
        topLevelComment: {
          id: 'comment_id_xyz',
          snippet: {
            textOriginal: 'Hello world',
            authorDisplayName: 'Alice',
            authorChannelId: { value: 'UCabc' },
            likeCount: 4,
            publishedAt: '2026-05-01T12:00:00Z',
            updatedAt: '2026-05-01T12:00:00Z',
            moderationStatus: 'published',
            ...((overrides as { topSnippet?: object }).topSnippet ?? {}),
          },
        },
      },
    };
  }

  it('parses a normal item into the canonical row shape', () => {
    const out = parseCommentThreadItem('vid1', fakeItem());
    expect(out).toEqual(
      expect.objectContaining({
        youtube_video_id: 'vid1',
        youtube_comment_id: 'comment_id_xyz',
        author_name: 'Alice',
        author_channel_id: 'UCabc',
        text: 'Hello world',
        like_count: 4,
        reply_count: 3,
        moderation_status: 'published',
      }),
    );
  });

  it('returns null when required fields are missing', () => {
    expect(parseCommentThreadItem('vid1', {})).toBeNull();
    expect(parseCommentThreadItem('vid1', { snippet: {} })).toBeNull();
    expect(parseCommentThreadItem('vid1', { snippet: { topLevelComment: { id: 'x', snippet: {} } } })).toBeNull();
  });

  it('falls back from textOriginal to textDisplay if needed', () => {
    const item = {
      snippet: {
        topLevelComment: {
          id: 'c1',
          snippet: { textDisplay: 'fallback text', authorDisplayName: 'Bob', likeCount: 0 },
        },
      },
    };
    const out = parseCommentThreadItem('vid1', item);
    expect(out?.text).toBe('fallback text');
  });

  it('truncates oversized text to 10k chars', () => {
    const item = {
      snippet: {
        topLevelComment: {
          id: 'c1',
          snippet: { textOriginal: 'x'.repeat(20000), authorDisplayName: 'X', likeCount: 0 },
        },
      },
    };
    const out = parseCommentThreadItem('vid1', item);
    expect(out?.text!.length).toBeLessThanOrEqual(10000);
  });

  it('coerces missing like_count / reply_count to 0', () => {
    const item = {
      snippet: {
        topLevelComment: {
          id: 'c1',
          snippet: { textOriginal: 'x', authorDisplayName: 'X' },
        },
      },
    };
    const out = parseCommentThreadItem('vid1', item);
    expect(out?.like_count).toBe(0);
    expect(out?.reply_count).toBe(0);
  });
});
