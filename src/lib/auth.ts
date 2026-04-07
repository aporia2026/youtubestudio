import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

let _secret: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (!_secret) {
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new Error('AUTH_SECRET environment variable is not set. Add it to your .env.local or Vercel project settings.');
    _secret = new TextEncoder().encode(secret);
  }
  return _secret;
}
const COOKIE_NAME = 'yt_studio_session';

export async function createSession(): Promise<string> {
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(getSecret());
  return token;
}

export async function verifySession(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, getSecret());
    return true;
  } catch {
    return false;
  }
}

export async function getSession(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return false;
  return verifySession(token);
}

export { COOKIE_NAME };
