import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    google: !!process.env.GOOGLE_AI_API_KEY,
    kie: !!process.env.KIE_API_KEY,
    youtube: !!process.env.YOUTUBE_API_KEY,
    postgres: !!process.env.POSTGRES_URL,
    blob: !!process.env.BLOB_READ_WRITE_TOKEN,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
  });
}
