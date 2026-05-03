import { SignJWT, jwtVerify } from 'jose';
import { sql } from '@/lib/db';
import { encrypt, decrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  // Analytics API access — needed for impressions, CTR, AVD, retention curves.
  // Channels OAuth-connected before PR #3 don't have this scope; they degrade
  // to Data-API-only stats until the user re-runs the connect flow.
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

function getOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }
  return { clientId, clientSecret };
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set');
  return new TextEncoder().encode(secret);
}

function getRedirectUri(): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL
    || process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`
    || 'http://localhost:3000';
  return `${base}/api/auth/google/callback`;
}

/**
 * Build the Google OAuth authorization URL.
 * The `state` parameter is a signed JWT carrying the channel DB id.
 */
export async function getAuthorizationUrl(channelDbId: string): Promise<string> {
  const { clientId } = getOAuthConfig();

  const state = await new SignJWT({ channelDbId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getSecret());

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Verify the state JWT and extract the channel DB id.
 */
export async function verifyState(state: string): Promise<{ channelDbId: string }> {
  const { payload } = await jwtVerify(state, getSecret());
  return { channelDbId: payload.channelDbId as string };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = getOAuthConfig();

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: getRedirectUri(),
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  return res.json();
}

/**
 * Refresh an access token using the stored refresh token.
 */
async function refreshAccessToken(refreshTokenEncrypted: string): Promise<{ access_token: string; expires_in: number }> {
  const { clientId, clientSecret } = getOAuthConfig();
  const refreshToken = decrypt(refreshTokenEncrypted);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  return res.json();
}

/**
 * Store OAuth tokens in the database (encrypted).
 */
export async function storeTokens(
  channelDbId: string,
  tokens: TokenResponse,
  googleEmail?: string,
): Promise<void> {
  const accessTokenEnc = encrypt(tokens.access_token);
  const refreshTokenEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
  const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const scopesCsv = `{${tokens.scope.split(' ').join(',')}}`;

  // Upsert — update if already connected. workspace_id is NOT NULL on
  // oauth_tokens since migration 0013 — copy it from the parent channel.
  await sql`
    INSERT INTO oauth_tokens (channel_id, provider, access_token_encrypted, refresh_token_encrypted, token_expiry, scopes, google_email, workspace_id)
    SELECT ${channelDbId}::uuid, 'google', ${accessTokenEnc}, ${refreshTokenEnc},
           ${expiry}::timestamptz, ${scopesCsv}::text[], ${googleEmail || null},
           c.workspace_id
      FROM channels c WHERE c.id = ${channelDbId}::uuid
    ON CONFLICT (channel_id, provider) DO UPDATE SET
      access_token_encrypted = EXCLUDED.access_token_encrypted,
      refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, oauth_tokens.refresh_token_encrypted),
      token_expiry = EXCLUDED.token_expiry,
      scopes = EXCLUDED.scopes,
      google_email = COALESCE(EXCLUDED.google_email, oauth_tokens.google_email),
      updated_at = NOW()
  `;

  // Mark channel as OAuth-connected
  await sql`UPDATE channels SET oauth_connected = true WHERE id = ${channelDbId}::uuid`;
}

/**
 * Get a valid access token for a channel, along with granted scopes.
 * Handles refresh transparently.
 */
export async function getValidAccessToken(channelDbId: string): Promise<string | null>;
export async function getValidAccessToken(channelDbId: string, includeScopes: true): Promise<{ token: string; scopes: string[] } | null>;
export async function getValidAccessToken(
  channelDbId: string,
  includeScopes?: true,
): Promise<string | { token: string; scopes: string[] } | null> {
  const result = await sql`
    SELECT access_token_encrypted, refresh_token_encrypted, token_expiry, scopes
    FROM oauth_tokens
    WHERE channel_id = ${channelDbId}::uuid AND provider = 'google'
  `;

  if (!result.rows.length) return null;

  const row = result.rows[0];
  const expiry = new Date(row.token_expiry as string);
  const scopes: string[] = (row.scopes as string[]) || [];

  let token: string;

  // If token is still valid (with 5-min buffer), return it
  if (expiry.getTime() > Date.now() + 5 * 60 * 1000) {
    token = decrypt(row.access_token_encrypted as string);
  } else {
    // Token expired — refresh it
    if (!row.refresh_token_encrypted) return null;

    try {
      const refreshed = await refreshAccessToken(row.refresh_token_encrypted as string);
      const newAccessEnc = encrypt(refreshed.access_token);
      const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

      await sql`
        UPDATE oauth_tokens
        SET access_token_encrypted = ${newAccessEnc}, token_expiry = ${newExpiry}::timestamptz, updated_at = NOW()
        WHERE channel_id = ${channelDbId}::uuid AND provider = 'google'
      `;

      token = refreshed.access_token;
    } catch (err) {
      logger.error('Token refresh failed for channel', { channel_db_id: channelDbId, detail: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  if (includeScopes) return { token, scopes };
  return token;
}

const SHEETS_ONLY_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

/**
 * Build the Google OAuth URL for Sheets-only auth (no YouTube).
 *
 * `workspaceId` is bound into the signed state JWT so the callback can
 * attribute the resulting tokens to the correct tenant — without trusting
 * the session cookie, which `SameSite=Lax` may still withhold on some
 * cross-site redirect chains. State expires in 10 minutes; a stale or
 * forged state JWT is rejected by `verifyStatePayload`.
 */
export async function getAuthorizationUrlForSheets(workspaceId: string): Promise<string> {
  if (!workspaceId) throw new Error('getAuthorizationUrlForSheets: workspaceId is required');
  const { clientId } = getOAuthConfig();
  const state = await new SignJWT({ flow: 'sheets', workspaceId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getSecret());
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SHEETS_ONLY_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Verify state JWT and return full payload (works for both flows). */
export async function verifyStatePayload(state: string): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(state, getSecret());
  return payload as Record<string, unknown>;
}

/**
 * Store Google auth tokens for a workspace.
 *
 * Upsert key is `(workspace_id, email)` — reconnecting the same account in
 * the same workspace updates in place; a different account creates a new
 * row that the workspace's "latest" pointer (ORDER BY updated_at DESC) then
 * picks up. The legacy `ON CONFLICT (email)` would have silently mutated
 * another workspace's row, which is why we ship migration 0036 alongside.
 */
export async function storeSheetsTokens(
  workspaceId: string,
  tokens: TokenResponse,
  email: string,
): Promise<void> {
  if (!workspaceId) throw new Error('storeSheetsTokens: workspaceId is required');
  const accessTokenEnc = encrypt(tokens.access_token);
  const refreshTokenEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
  const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const scopesCsv = `{${tokens.scope.split(' ').join(',')}}`;
  await sql`
    INSERT INTO google_auth_tokens (workspace_id, email, access_token_encrypted, refresh_token_encrypted, token_expiry, scopes)
    VALUES (${workspaceId}::uuid, ${email}, ${accessTokenEnc}, ${refreshTokenEnc}, ${expiry}::timestamptz, ${scopesCsv}::text[])
    ON CONFLICT (workspace_id, email) DO UPDATE SET
      access_token_encrypted = EXCLUDED.access_token_encrypted,
      refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, google_auth_tokens.refresh_token_encrypted),
      token_expiry = EXCLUDED.token_expiry,
      scopes = EXCLUDED.scopes,
      updated_at = NOW()
  `;
}

/**
 * Get a valid access token for the workspace's most-recently-connected
 * Google account. Refreshes transparently. Scoped: never returns another
 * workspace's token even if the global `LIMIT 1` is the freshest row.
 */
export async function getValidSheetsToken(
  workspaceId: string,
): Promise<{ token: string; scopes: string[]; email: string } | null> {
  if (!workspaceId) throw new Error('getValidSheetsToken: workspaceId is required');
  const result = await sql`
    SELECT email, access_token_encrypted, refresh_token_encrypted, token_expiry, scopes
    FROM google_auth_tokens
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const expiry = new Date(row.token_expiry as string);
  const scopes: string[] = (row.scopes as string[]) || [];
  let token: string;
  if (expiry.getTime() > Date.now() + 5 * 60 * 1000) {
    token = decrypt(row.access_token_encrypted as string);
  } else {
    if (!row.refresh_token_encrypted) return null;
    try {
      const refreshed = await refreshAccessToken(row.refresh_token_encrypted as string);
      const newAccessEnc = encrypt(refreshed.access_token);
      const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
      await sql`
        UPDATE google_auth_tokens
        SET access_token_encrypted = ${newAccessEnc}, token_expiry = ${newExpiry}::timestamptz, updated_at = NOW()
        WHERE workspace_id = ${workspaceId}::uuid AND email = ${row.email as string}
      `;
      token = refreshed.access_token;
    } catch {
      return null;
    }
  }
  return { token, scopes, email: row.email as string };
}

/** Get connected Google account info for a workspace, without fetching a token. */
export async function getSheetsAccountInfo(
  workspaceId: string,
): Promise<{ email: string; scopes: string[] } | null> {
  if (!workspaceId) throw new Error('getSheetsAccountInfo: workspaceId is required');
  try {
    const result = await sql`
      SELECT email, scopes FROM google_auth_tokens
      WHERE workspace_id = ${workspaceId}::uuid
      ORDER BY updated_at DESC LIMIT 1
    `;
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return { email: row.email as string, scopes: (row.scopes as string[]) || [] };
  } catch {
    return null;
  }
}

/** Disconnect every Google account for the given workspace. */
export async function deleteSheetsTokens(workspaceId: string): Promise<void> {
  if (!workspaceId) throw new Error('deleteSheetsTokens: workspaceId is required');
  await sql`DELETE FROM google_auth_tokens WHERE workspace_id = ${workspaceId}::uuid`;
}

/**
 * Revoke OAuth tokens and remove from database.
 */
export async function revokeOAuth(channelDbId: string): Promise<void> {
  const result = await sql`
    SELECT access_token_encrypted FROM oauth_tokens
    WHERE channel_id = ${channelDbId}::uuid AND provider = 'google'
  `;

  if (result.rows.length) {
    try {
      const token = decrypt(result.rows[0].access_token_encrypted as string);
      await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(token)}`,
      });
    } catch { /* best effort */ }
  }

  await sql`DELETE FROM oauth_tokens WHERE channel_id = ${channelDbId}::uuid AND provider = 'google'`;
  await sql`UPDATE channels SET oauth_connected = false WHERE id = ${channelDbId}::uuid`;
}
