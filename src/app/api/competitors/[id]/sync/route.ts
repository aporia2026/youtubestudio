import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';
import { fetchChannelVideosRich, fetchChannelData, fetchVideoComments, parseDurationSeconds } from '@/lib/youtube';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

export const maxDuration = 180;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { limited } = checkRateLimit(`sync:${getClientIP(req)}`, 5, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  try {
    await ensureCompetitorSchema();

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

    // Fetch up to 200 videos with rich fields
    const videos = await fetchChannelVideosRich(comp.channel_id, 200);

    // Compute median for outlier score
    const viewCounts = videos.map(v => v.viewCount).sort((a, b) => a - b);
    const medianViews = viewCounts.length > 0 ? viewCounts[Math.floor(viewCounts.length / 2)] : 0;

    // Fetch comments for the top 5 videos by views (for sentiment signal)
    const byViews = [...videos].sort((a, b) => b.viewCount - a.viewCount);
    const topForComments = byViews.slice(0, 5);
    const commentsMap = new Map<string, { text: string; likeCount: number }[]>();
    await Promise.all(topForComments.map(async v => {
      const c = await fetchVideoComments(v.id, 20);
      commentsMap.set(v.id, c.map(x => ({ text: x.text.slice(0, 400), likeCount: x.likeCount })));
    }));

    let newCount = 0;
    for (const video of videos) {
      const outlierScoreRaw = medianViews > 0 ? video.viewCount / medianViews : 0;
      // Cap to fit NUMERIC(14,2). Anything beyond 1e10x median is meaningless anyway.
      const outlierScore = Math.min(outlierScoreRaw, 9_999_999_999);
      const engagementRateRaw = video.viewCount > 0 ? (video.likeCount + (video.commentCount || 0)) / video.viewCount : 0;
      // Cap to fit NUMERIC(8,4) — engagement rate cannot exceed a small multiple in practice
      const engagementRate = Math.min(engagementRateRaw, 999.9999);
      const os = Math.round(outlierScore * 100) / 100;
      const er = Math.round(engagementRate * 10000) / 10000;
      const durSec = parseDurationSeconds(video.duration);
      const topComments = commentsMap.get(video.id) || [];

      const result = await sql`
        INSERT INTO competitor_videos (
          competitor_id, video_id, title, published_at,
          view_count, like_count, comment_count, duration,
          thumbnail_url, outlier_score, engagement_rate, synced_at,
          description, tags, category_id, duration_seconds, top_comments, topic_categories
        )
        VALUES (
          ${id}, ${video.id}, ${video.title}, ${video.publishedAt},
          ${video.viewCount}, ${video.likeCount}, ${video.commentCount || 0}, ${video.duration},
          ${video.thumbnailUrl}, ${os}, ${er}, NOW(),
          ${(video.description || '').slice(0, 5000)},
          ${JSON.stringify(video.tags || [])},
          ${video.categoryId || ''},
          ${durSec},
          ${JSON.stringify(topComments)},
          ${JSON.stringify(video.topicCategories || [])}
        )
        ON CONFLICT (video_id) DO UPDATE SET
          view_count = ${video.viewCount},
          like_count = ${video.likeCount},
          comment_count = ${video.commentCount || 0},
          outlier_score = ${os},
          engagement_rate = ${er},
          description = ${(video.description || '').slice(0, 5000)},
          tags = ${JSON.stringify(video.tags || [])},
          category_id = ${video.categoryId || ''},
          duration_seconds = ${durSec},
          top_comments = CASE WHEN ${JSON.stringify(topComments)}::jsonb <> '[]'::jsonb
                              THEN ${JSON.stringify(topComments)}::jsonb
                              ELSE competitor_videos.top_comments END,
          topic_categories = ${JSON.stringify(video.topicCategories || [])},
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
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: `Sync failed: ${detail}` }, { status: 500 });
  }
}
