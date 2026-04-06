import { NextRequest, NextResponse } from 'next/server';
import { getUserSubscription } from '@/lib/elevenlabs';

export async function GET(req: NextRequest) {
  const apiKey = req.headers.get('x-eleven-api-key') || '';
  if (!apiKey) return NextResponse.json({ error: 'API key required' }, { status: 401 });

  try {
    const sub = await getUserSubscription(apiKey);
    return NextResponse.json(sub);
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
