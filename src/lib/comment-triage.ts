/**
 * AI-driven comment intent classification + suggested reply.
 *
 * Two stages, both pure-ish:
 *   1. `buildTriagePrompt` — constructs system + user prompts. The
 *      system prompt teaches the model the intent enum + how to write
 *      a *suggested reply* without committing to it (the user always
 *      reviews before posting).
 *   2. `parseTriageOutput` — parses the model JSON output, validates
 *      intent against the enum, clamps confidence to [0,1].
 *
 * The orchestrator `triageComments` runs the per-comment LLM call
 * sequentially with bounded concurrency (CONCURRENCY = 3), persists the
 * result to youtube_comments via persistIntentClassification, and
 * returns a per-comment summary the route serves.
 *
 * Sequential + bounded rather than full Promise.all because:
 *   - Anthropic Tier-1 rate limit is 50 req/min; bursts of 25 trigger
 *     transient 429s.
 *   - Each individual classification is fast (~1s with Haiku).
 */
import { generateText } from './ai';
import { parseLlmJson } from './parse-llm-json';
import {
  COMMENT_INTENT_VALUES,
  isCommentIntent,
  type CommentIntent,
} from './youtube-comments-types';
import {
  listCommentsForTriage,
  persistIntentClassification,
  logger,
  type YoutubeCommentRow,
} from './youtube-comments';

export type { CommentIntent } from './youtube-comments-types';

const DEFAULT_TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface TriageInput {
  comment_text: string;
  author_name?: string | null;
  like_count?: number;
  video_title?: string | null;
  channel_name?: string | null;
  niche?: string | null;
}

export function buildTriagePrompt(input: TriageInput): { system: string; user: string } {
  const intentList = COMMENT_INTENT_VALUES.join(' | ');
  return {
    system: `You triage a single YouTube comment for a channel owner. You return:
  1. an INTENT classification from this exact enum: ${intentList}
  2. a CONFIDENCE score 0-1
  3. a SUGGESTED_REPLY — a short, natural-voice reply the channel owner could send back, OR null if the comment doesn't deserve a reply (spam, troll, off-topic).

Intent definitions:
  - "question": viewer is asking something. Reply usually warranted.
  - "support": viewer needs help (broken link, can't find a thing, wants a follow-up resource).
  - "fan": positive engagement, praise, "loved this video". A short heart-back reply is fine; don't over-respond.
  - "feedback": substantive critique (not insults). Worth thanking + acknowledging.
  - "troll": insult, bait, hostility without substance. NO reply (suggested_reply must be null).
  - "spam": bot, scam link, "check my channel" without context. NO reply.
  - "self_promo": another creator pushing their content. NO reply unless they're a relevant collaborator.
  - "other": anything that doesn't fit above. confidence should reflect uncertainty.

Suggested reply rules:
  - Match the channel's voice — don't be corporate.
  - Keep it short — 1-2 sentences max.
  - For questions, give a real answer if you can infer one; if not, suggest where to look ("check the description / pinned comment").
  - For fans, just a warm thanks works.
  - NEVER include @mentions or URLs unless the comment explicitly asks for them.
  - NEVER promise something the creator might not deliver ("I'll make a follow-up video").

Output STRICTLY this JSON:
{
  "intent": "<one of the enum values>",
  "confidence": <0-1 float>,
  "suggested_reply": "<short reply or null>"
}`,
    user: `${input.video_title ? `Video: "${input.video_title}"\n` : ''}${input.channel_name ? `Channel: ${input.channel_name}\n` : ''}${input.niche ? `Niche: ${input.niche}\n` : ''}${input.author_name ? `Comment by: ${input.author_name}` : ''}${input.like_count ? ` (${input.like_count} likes)` : ''}

Comment:
"""
${input.comment_text.slice(0, 4000)}
"""

Output JSON only.`,
  };
}

interface RawTriageOutput {
  intent?: unknown;
  confidence?: unknown;
  suggested_reply?: unknown;
}

export interface TriageResult {
  intent: CommentIntent;
  confidence: number;
  suggested_reply: string | null;
}

export function parseTriageOutput(raw: string): TriageResult {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    throw new Error(
      `Could not parse JSON from triage output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as RawTriageOutput;
  const intent: CommentIntent = isCommentIntent(obj.intent) ? obj.intent : 'other';
  const confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0.5;
  let suggested_reply: string | null = null;
  if (typeof obj.suggested_reply === 'string') {
    const t = obj.suggested_reply.trim();
    suggested_reply = t.length > 0 && t.toLowerCase() !== 'null' ? t.slice(0, 800) : null;
  }
  return { intent, confidence, suggested_reply };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface TriageCommentsArgs {
  workspaceId: string;
  videoId?: string;
  limit?: number;
  reclassify?: boolean;
  modelId?: string;
  /** Optional context attached to every classification — same value
   *  for the whole batch. The model uses this to write better suggested
   *  replies in voice. */
  contextual?: { videoTitle?: string; channelName?: string; niche?: string };
}

export interface TriagedSummary {
  id: string;
  intent: CommentIntent;
  confidence: number;
  suggested_reply: string | null;
}

export async function triageComments(args: TriageCommentsArgs): Promise<{
  triaged: TriagedSummary[];
  failed: Array<{ id: string; error: string }>;
  considered: number;
}> {
  const modelId = args.modelId || DEFAULT_TRIAGE_MODEL;
  const todo = await listCommentsForTriage(args.workspaceId, {
    limit: args.limit,
    videoId: args.videoId,
    reclassify: args.reclassify,
  });
  if (todo.length === 0) {
    return { triaged: [], failed: [], considered: 0 };
  }

  const triaged: TriagedSummary[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  // Bounded concurrency loop — chunks of CONCURRENCY in parallel.
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const slice = todo.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      slice.map((c) => triageOne(c, modelId, args.contextual ?? {}, args.workspaceId)),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j]!;
      const c = slice[j]!;
      if (r.status === 'fulfilled') {
        triaged.push({ id: c.id, ...r.value });
      } else {
        failed.push({ id: c.id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
      }
    }
  }

  return { triaged, failed, considered: todo.length };
}

async function triageOne(
  comment: YoutubeCommentRow,
  modelId: string,
  contextual: { videoTitle?: string; channelName?: string; niche?: string },
  workspaceId: string,
): Promise<TriageResult> {
  const { system, user } = buildTriagePrompt({
    comment_text: comment.text,
    author_name: comment.author_name,
    like_count: comment.like_count,
    video_title: contextual.videoTitle,
    channel_name: contextual.channelName,
    niche: contextual.niche,
  });
  let raw: string;
  try {
    raw = await generateText({
      modelId,
      systemPrompt: system,
      prompt: user,
      maxTokens: 600,
      temperature: 0.2,
    });
  } catch (err) {
    logger.warn('comment-triage: generateText failed', {
      comment_id: comment.id,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const result = parseTriageOutput(raw);
  await persistIntentClassification({
    id: comment.id,
    workspaceId,
    intent: result.intent,
    confidence: result.confidence,
    suggestedReply: result.suggested_reply,
    modelId,
  });
  return result;
}
