import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const { provider } = await req.json();

  try {
    if (provider === 'anthropic') {
      if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say "ok"' }],
      });
      return NextResponse.json({ ok: true, model: res.model });
    }

    if (provider === 'openai') {
      if (!process.env.OPENAI_API_KEY) return NextResponse.json({ ok: false, error: 'OPENAI_API_KEY not set' });
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say "ok"' }],
      });
      return NextResponse.json({ ok: true, model: res.model });
    }

    if (provider === 'google') {
      if (!process.env.GOOGLE_AI_API_KEY) return NextResponse.json({ ok: false, error: 'GOOGLE_AI_API_KEY not set' });
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      await model.generateContent('Say "ok"');
      return NextResponse.json({ ok: true, model: 'gemini-2.0-flash' });
    }

    if (provider === 'kie') {
      if (!process.env.KIE_API_KEY) return NextResponse.json({ ok: false, error: 'KIE_API_KEY not set' });
      const res = await fetch('https://api.kie.ai/api/v1/chat/credit', {
        headers: { 'Authorization': `Bearer ${process.env.KIE_API_KEY}` },
      });
      if (!res.ok) return NextResponse.json({ ok: false, error: `Kie.ai returned ${res.status}` });
      const credits = await res.json();
      return NextResponse.json({ ok: true, credits });
    }

    if (provider === 'youtube') {
      if (!process.env.YOUTUBE_API_KEY) return NextResponse.json({ ok: false, error: 'YOUTUBE_API_KEY not set' });
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`
      );
      if (!res.ok) return NextResponse.json({ ok: false, error: `YouTube API returned ${res.status}` });
      return NextResponse.json({ ok: true });
    }

    if (provider === 'postgres') {
      if (!process.env.POSTGRES_URL) return NextResponse.json({ ok: false, error: 'POSTGRES_URL not set' });
      const { sql } = await import('@/lib/db');
      await sql`SELECT 1`;
      return NextResponse.json({ ok: true });
    }

    if (provider === 'blob') {
      if (!process.env.BLOB_READ_WRITE_TOKEN) return NextResponse.json({ ok: false, error: 'BLOB_READ_WRITE_TOKEN not set' });
      const { list } = await import('@vercel/blob');
      await list({ limit: 1 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: `Unknown provider: ${provider}` }, { status: 400 });
  } catch (err: unknown) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Connection failed',
    });
  }
}
