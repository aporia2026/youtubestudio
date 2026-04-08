import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { verifyState, exchangeCodeForTokens, storeTokens } from '@/lib/google-oauth';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const error = req.nextUrl.searchParams.get('error');

  // User denied consent
  if (error) {
    return NextResponse.redirect(new URL('/channel?oauth=denied', req.url));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL('/channel?oauth=error', req.url));
  }

  try {
    // Verify state JWT to get channel DB id
    const { channelDbId } = await verifyState(state);

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);

    // Fetch the authenticated user's YouTube channel info
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
          // Update the channel record with real YouTube data
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

      // Get the user's email from the userinfo endpoint
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
      console.error('Failed to fetch YouTube channel data after OAuth:', err);
    }

    // Store encrypted tokens
    await storeTokens(channelDbId, tokens, googleEmail);

    return NextResponse.redirect(new URL('/channel?oauth=success', req.url));
  } catch (err: unknown) {
    console.error('OAuth callback error:', err);
    return NextResponse.redirect(new URL('/channel?oauth=error', req.url));
  }
}
