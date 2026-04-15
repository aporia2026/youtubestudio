import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

export const maxDuration = 30;

const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type AllowedMediaType = typeof ALLOWED_MEDIA_TYPES[number];

export async function POST(req: NextRequest) {
  try {
    const { limited } = checkRateLimit(`image-style:${getClientIP(req)}`, 15, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

    let body: { imageBase64?: string; mediaType?: string };
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { imageBase64, mediaType } = body;
    if (!imageBase64 || !mediaType) {
      return NextResponse.json({ error: 'imageBase64 and mediaType are required' }, { status: 400 });
    }
    if (!(ALLOWED_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
      return NextResponse.json({ error: `Unsupported media type. Allowed: ${ALLOWED_MEDIA_TYPES.join(', ')}` }, { status: 400 });
    }
    // Rough size guard — base64 of a 5 MB file is ~6.7 MB of string
    if (imageBase64.length > 7_000_000) {
      return NextResponse.json({ error: 'Image too large — maximum 5 MB' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured' }, { status: 500 });
    }

    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType as AllowedMediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: `Analyze the visual style of this image and describe it in 2-3 sentences for use as a creative brief for AI image generation. Focus on: color palette, mood/tone, lighting style, composition style, visual aesthetic (e.g. cinematic, animated, documentary, stock photo, etc.), and any distinctive visual elements. Be specific and actionable — describe what makes this style unique so an AI can replicate it.

Return ONLY the style description, no preamble or explanation.`,
            },
          ],
        },
      ],
    });

    const textBlock = message.content.find(b => b.type === 'text');
    const description = textBlock?.type === 'text' ? textBlock.text.trim() : '';
    if (!description) {
      return NextResponse.json({ error: 'AI returned an empty style description' }, { status: 500 });
    }
    return NextResponse.json({ description });
  } catch (err: unknown) {
    console.error('Image style analysis error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Analysis failed' },
      { status: 500 },
    );
  }
}
