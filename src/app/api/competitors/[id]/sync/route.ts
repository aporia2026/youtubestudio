import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchChannelVideos, fetchChannelData } from '@/lib/youtube';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { limited } = checkRateLimit(`sync:${getClientIP(req)}`, 5, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  try {
    // Get competitor channel
    const channel = await sql`SELECT * FROM competitor_channels WHERE id = ${id}`;
    if (channel.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const comp = channel.rows[0];

    // Update channel stats
    const freshData = await fetchChannelData(comp.channel_id);
    if (freshData) {
      await sql`
        UPDATE competitor_channels SET
          subscriber_count = ${freshData.subscriberCount},
          video_count = ${freshData.videoCount},
          view_count = ${freshData.viewCount},
          thumbnail_url = ${freshData.thumbnailUrl || comp.thumbnail_url},
          updated_at = NOW()
        WHERE id = ${id}
      `;
    }

    // Fetch recent videos
    const videos = await fetchChannelVideos(comp.channel_id, 50);

    // Compute median views for outlier detection
    const viewCounts = videos.map(v => v.viewCount).sort((a, b) => a - b);
    const medianViews = viewCounts.length > 0
      ? viewCounts[Math.floor(viewCounts.length / 2)]
      : 0;

    // Upsert videos using ON CONFLICT (single query per video, no SELECT needed)
    let newCount = 0;
    for (const video of videos) {
      const outlierScore = medianViews > 0 ? video.viewCount / medianViews : 0;
      const engagementRate = video.viewCount > 0 ? (video.likeCount + (video.commentCount || 0)) / video.viewCount : 0;
      const os = Math.round(outlierScore * 100) / 100;
      const er = Math.round(engagementRate * 10000) / 10000;

      const result = await sql`
        INSERT INTO competitor_videos (
          competitor_id, video_id, title, published_at,
          view_count, like_count, comment_count, duration,
          thumbnail_url, outlier_score, engagement_rate, synced_at
        )
        VALUES (
          ${id}, ${video.id}, ${video.title}, ${video.publishedAt},
          ${video.viewCount}, ${video.likeCount}, ${video.commentCount || 0}, ${video.duration},
          ${video.thumbnailUrl}, ${os}, ${er}, NOW()
        )
        ON CONFLICT (video_id) DO UPDATE SET
          view_count = ${video.viewCount},
          like_count = ${video.likeCount},
          comment_count = ${video.commentCount || 0},
          outlier_score = ${os},
          engagement_rate = ${er},
          synced_at = NOW()
        RETURNING (xmax = 0) as is_new
      `;
      if (result.rows[0]?.is_new) newCount++;
    }

    return NextResponse.json({
      synced: videos.length,
      new: newCount,
      medianViews,
      subscriberCount: freshData?.subscriberCount || comp.subscriber_count,
    });
  } catch (err) {
    console.error('Competitor sync error:', err);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
