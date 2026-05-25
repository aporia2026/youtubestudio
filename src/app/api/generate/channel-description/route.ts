import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { generateText, getModelById } from '@/lib/ai';
import {
  channelDescriptionPrompt,
  type ChannelDescriptionBrandKitInput,
} from '@/lib/prompts';
import {
  CHANNEL_DESCRIPTION_STYLES,
  type ChannelDescriptionStyle,
} from '@/lib/channel-description-styles';
import { parseBrandKit } from '@/lib/channel-brand-kit';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';
import { apiRoute } from '@/lib/route-helpers';

export const maxDuration = 60;

/** Cap on user-supplied free-text inputs that flow into the prompt. Keeps
 *  the prompt size predictable and prevents a 5MB paste from blowing the
 *  rate limit / spend budget for a single call. */
const MAX_INPUT_CHARS = 4000;

function trimInput(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.slice(0, MAX_INPUT_CHARS).trim();
}

const VALID_STYLE_VALUES = new Set<string>(CHANNEL_DESCRIPTION_STYLES.map((s) => s.value));

/**
 * POST /api/generate/channel-description
 *
 * Two call modes:
 *
 *   1. Connected (existing channel) — body includes `channelId`. The route
 *      reads the channel's name / niche / notes / brand_kit from the DB
 *      (workspace-scoped) so the client doesn't have to send them, and so
 *      the prompt always sees the authoritative server-side state.
 *
 *   2. Unconnected (new channel during add flow) — body includes raw
 *      `name`, optional `niche` and `notes`, and no `channelId`. No brand
 *      kit is applied (a new channel has none yet).
 *
 * Both modes require `modelId`, `style`, and accept an optional `brief`.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  try {
    const { limited, resetIn } = checkRateLimit(
      `channel-description:${getClientIP(req)}`,
      10,
      60_000,
    );
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const channelId = typeof body.channelId === 'string' && body.channelId.trim() ? body.channelId.trim() : null;
    const brief = trimInput(body.brief);
    const style: ChannelDescriptionStyle = VALID_STYLE_VALUES.has(body.style)
      ? (body.style as ChannelDescriptionStyle)
      : 'short-bio';

    const model = getModelById(modelId);
    if (!model) {
      return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    }

    // Resolve channel signals + brand kit. Connected mode reads from the DB
    // so we never trust client-supplied name/niche for a channel the user
    // claims to own; unconnected mode just uses what the client sent.
    let name = '';
    let niche: string | null = null;
    let notes: string | null = null;
    let brandKit: ChannelDescriptionBrandKitInput | null = null;

    if (channelId) {
      const result = await sql`
        SELECT name, niche, notes, brand_kit
          FROM channels
         WHERE id = ${channelId} AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      const row = result.rows[0];
      if (!row) {
        return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
      }
      name = String(row.name || '');
      niche = (row.niche as string | null) ?? null;
      notes = (row.notes as string | null) ?? null;
      const kit = parseBrandKit(row.brand_kit);
      brandKit = {
        tone: kit.tone,
        vocabulary_level: kit.vocabulary_level,
        sentence_length: kit.sentence_length,
        voice_examples: kit.voice_examples,
        banned_phrases: kit.banned_phrases,
        required_phrases: kit.required_phrases,
        hook_style: kit.hook_style,
        brand_keywords: kit.brand_keywords,
      };
    } else {
      name = trimInput(body.name);
      niche = trimInput(body.niche) || null;
      notes = trimInput(body.notes) || null;
      brandKit = null;
    }

    if (!name) {
      return NextResponse.json(
        { error: 'Channel name is required (provide channelId or name in the request body)' },
        { status: 400 },
      );
    }

    const { system, user } = channelDescriptionPrompt({
      brief,
      name,
      niche,
      notes,
      brandKit,
      style,
    });

    const description = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 1200,
      temperature: 0.7,
      spend: await makeSpendContext('channel_description', {
        channelDbId: channelId,
        metadata: { style, hasBrandKit: brandKit !== null },
      }),
    });

    const cleaned = description.trim();
    if (!cleaned) {
      return NextResponse.json(
        { error: 'The model returned an empty response — try again or pick a different model' },
        { status: 502 },
      );
    }

    return NextResponse.json({ description: cleaned, style });
  } catch (err: unknown) {
    logger.error('Channel description generation error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 },
    );
  }
});
