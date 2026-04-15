import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'perplexity_api_key';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  // 1 year
  maxAge: 60 * 60 * 24 * 365,
};

export async function GET() {
  const store = await cookies();
  const configured = !!store.get(COOKIE_NAME)?.value;
  return NextResponse.json({ configured });
}

export async function POST(req: NextRequest) {
  const { key } = await req.json();
  if (!key || typeof key !== 'string' || !key.trim()) {
    return NextResponse.json({ ok: false, error: 'Invalid key' }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, key.trim(), COOKIE_OPTS);
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, '', { ...COOKIE_OPTS, maxAge: 0 });
  return res;
}
