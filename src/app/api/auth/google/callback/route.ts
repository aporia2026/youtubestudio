import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { sql } from '@/lib/db';
import { ensureGoogleAuthSchema } from '@/lib/db';
import {
  verifyStatePayload,
  exchangeCodeForTokens,
  storeTokens,
  storeSheetsTokens,
} from '@/lib/google-oauth';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL('/settings?google=denied', req.url));
  }
  if (!code || !state) {
    return NextResponse.redirect(new URL('/settings?google=error', req.url));
  }

  try {
    const payload = await verifyStatePayload(state);

    if (payload.flow === 'sheets') {
      // ── Sheets-only flow ───────────────────────────────────────────────────
      // workspaceId comes from the state JWT, not the session cookie. The
      // initiating /api/auth/google-sheets request bound the caller's
      // workspace into a signed, 10-minute-TTL state — see
      // getAuthorizationUrlForSheets — so we don't need to trust the
      // browser cookie on the way back from Google.
      const workspaceId = payload.workspaceId;
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        return NextResponse.redirect(new URL('/settings?google=error', req.url));
      }

      const tokens = await exchangeCodeForTokens(code);
      await ensureGoogleAuthSchema();

      let email = 'default';
      try {
        const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (userinfoRes.ok) {
          const userinfo = await userinfoRes.json();
          if (userinfo.email) email = userinfo.email;
        }
      } catch { /* email is optional */ }

      await storeSheetsTokens(workspaceId, tokens, email);
      return NextResponse.redirect(new URL('/settings?google=success', req.url));
    }

    // ── Existing YouTube channel flow ──────────────────────────────────────
    const channelDbId = payload.channelDbId as string;
    const tokens = await exchangeCodeForTokens(code);

    let googleEmail: string | undefined;
    try {
      const channelRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );
      if (channelRes.ok) {
        const channelData = await channelRes.json();
        const item = channelData.items?.[0];
        if (item) {
          await sql`
            UPDATE channels SET
              channel_id = ${item.id},
              name = ${item.snippet.title},
              handle = ${item.snippet.customUrl || null},
              description = ${item.snippet.description || null},
              subscriber_count = ${parseInt(item.statistics.subscriberCount || '0')},
              video_count = ${parseInt(item.statistics.videoCount || '0')},
              thumbnail_url = ${item.snippet.thumbnails?.high?.url || null},
              last_synced_at = NOW()
            WHERE id = ${channelDbId}::uuid
          `;
        }
      }

      const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (userinfoRes.ok) {
        const userinfo = await userinfoRes.json();
        googleEmail = userinfo.email;
        if (googleEmail) {
          await sql`UPDATE channels SET account_email = ${googleEmail} WHERE id = ${channelDbId}::uuid AND account_email IS NULL`;
        }
      }
    } catch (err) {
      logger.error('Failed to fetch YouTube channel data after OAuth', { detail: err instanceof Error ? err.message : String(err) });
    }

    await storeTokens(channelDbId, tokens, googleEmail);
    return NextResponse.redirect(new URL('/channel?oauth=success', req.url));
  } catch (err: unknown) {
    logger.error('OAuth callback error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.redirect(new URL('/settings?google=error', req.url));
  }
}
