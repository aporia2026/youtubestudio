import { NextRequest, NextResponse } from 'next/server';
import { getVoices } from '@/lib/elevenlabs';

export async function GET(req: NextRequest) {
  const apiKey = req.headers.get('x-eleven-api-key') || process.env.ELEVENLABS_API_KEY || '';
  if (!apiKey) return NextResponse.json({ error: 'API key required' }, { status: 401 });

  try {
    const voices = await getVoices(apiKey);
    return NextResponse.json({ voices });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch voices' },
      { status: 500 }
    );
  }
}
