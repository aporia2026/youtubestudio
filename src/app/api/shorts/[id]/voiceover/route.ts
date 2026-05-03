import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { generateShortVoiceover } from '@/lib/shorts';

export const maxDuration = 60;

/**
 * POST /api/shorts/[id]/voiceover
 *
 * Body: { voiceId: string }
 *
 * Generates an ElevenLabs multilingual_v2 voiceover for the Short, uploads
 * to Vercel Blob, and writes the URL back onto the row. Idempotent — re-run
 * to regenerate with a different voice (overwrites the same blob path).
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const voiceId = typeof (body as { voiceId?: unknown } | null)?.voiceId === 'string'
      ? (body as { voiceId: string }).voiceId.trim()
      : '';
    if (!voiceId) {
      return NextResponse.json({ error: 'voiceId is required' }, { status: 400 });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'ELEVENLABS_API_KEY is not configured on the server.' },
        { status: 503 },
      );
    }

    try {
      const result = await generateShortVoiceover({
        shortId: id,
        workspaceId: session.ws,
        voiceId,
        elevenLabsApiKey: apiKey,
      });
      return NextResponse.json({ ...result, status: 'ready' });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: voiceover',
        knownPatterns: [
          { match: /not found/i, status: 404 },
        ],
        fallbackMessage: 'Voiceover generation failed.',
      });
    }
  },
);
