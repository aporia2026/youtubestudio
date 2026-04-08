// YouTube Data API integration
// Infrastructure ready — add API credentials in .env to activate

export interface YouTubeVideoData {
  id: string;
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: string;
  thumbnailUrl: string;
  tags: string[];
}

export interface YouTubeChannelData {
  id: string;
  title: string;
  description: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
  thumbnailUrl: string;
  customUrl: string;
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export async function fetchYouTubeVideoData(url: string, overrideApiKey?: string): Promise<YouTubeVideoData | null> {
  const apiKey = overrideApiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    // Return mock data structure when no API key
    const videoId = extractVideoId(url);
    if (!videoId) return null;
    return {
      id: videoId,
      title: 'YouTube video (add API key to fetch details)',
      description: 'Add YOUTUBE_API_KEY to your environment variables to automatically fetch video details.',
      channelTitle: 'Unknown',
      publishedAt: new Date().toISOString(),
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      duration: 'PT0S',
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      tags: [],
    };
  }

  const videoId = extractVideoId(url);
  if (!videoId) return null;

  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`
    );
    const data = await response.json();
    if (!data.items?.length) return null;

    const item = data.items[0];
    return {
      id: item.id,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      viewCount: parseInt(item.statistics.viewCount || '0'),
      likeCount: parseInt(item.statistics.likeCount || '0'),
      commentCount: parseInt(item.statistics.commentCount || '0'),
      duration: item.contentDetails.duration,
      thumbnailUrl: item.snippet.thumbnails?.maxres?.url || item.snippet.thumbnails?.high?.url || '',
      tags: item.snippet.tags || [],
    };
  } catch (error) {
    console.error('YouTube API error:', error);
    return null;
  }
}

export async function fetchChannelData(channelIdOrUrl: string, overrideApiKey?: string): Promise<YouTubeChannelData | null> {
  const apiKey = overrideApiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  let channelId = channelIdOrUrl;

  // Handle @handle format — use forHandle for exact match
  if (channelIdOrUrl.includes('@') || channelIdOrUrl.includes('youtube.com')) {
    const handleMatch = channelIdOrUrl.match(/@([^/&?]+)/);
    if (handleMatch) {
      try {
        const handleRes = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=@${handleMatch[1]}&key=${apiKey}`
        );
        const handleData = await handleRes.json();
        if (handleData.items?.length) {
          const item = handleData.items[0];
          return {
            id: item.id,
            title: item.snippet.title,
            description: item.snippet.description,
            subscriberCount: parseInt(item.statistics.subscriberCount || '0'),
            videoCount: parseInt(item.statistics.videoCount || '0'),
            viewCount: parseInt(item.statistics.viewCount || '0'),
            thumbnailUrl: item.snippet.thumbnails?.high?.url || '',
            customUrl: item.snippet.customUrl || '',
          };
        }
      } catch { return null; }
    }
  }

  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`
    );
    const data = await response.json();
    if (!data.items?.length) return null;

    const item = data.items[0];
    return {
      id: item.id,
      title: item.snippet.title,
      description: item.snippet.description,
      subscriberCount: parseInt(item.statistics.subscriberCount || '0'),
      videoCount: parseInt(item.statistics.videoCount || '0'),
      viewCount: parseInt(item.statistics.viewCount || '0'),
      thumbnailUrl: item.snippet.thumbnails?.high?.url || '',
      customUrl: item.snippet.customUrl || '',
    };
  } catch (error) {
    console.error('YouTube channel fetch error:', error);
    return null;
  }
}

export async function fetchChannelVideos(channelId: string, maxResults = 50, overrideApiKey?: string): Promise<YouTubeVideoData[]> {
  const apiKey = overrideApiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  try {
    // Get uploads playlist
    const channelRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${apiKey}`
    );
    const channelData = await channelRes.json();
    const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return [];

    // Get playlist items
    const playlistRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${apiKey}`
    );
    const playlistData = await playlistRes.json();
    const videoIds = playlistData.items?.map((item: { contentDetails: { videoId: string } }) => item.contentDetails.videoId) || [];

    if (!videoIds.length) return [];

    // Get video details
    const videosRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`
    );
    const videosData = await videosRes.json();

    return (videosData.items || []).map((item: {
      id: string;
      snippet: {
        title: string;
        description: string;
        channelTitle: string;
        publishedAt: string;
        thumbnails: { maxres?: { url: string }; high?: { url: string } };
        tags?: string[];
      };
      statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
      contentDetails: { duration: string };
    }) => ({
      id: item.id,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      viewCount: parseInt(item.statistics.viewCount || '0'),
      likeCount: parseInt(item.statistics.likeCount || '0'),
      commentCount: parseInt(item.statistics.commentCount || '0'),
      duration: item.contentDetails.duration,
      thumbnailUrl: item.snippet.thumbnails?.maxres?.url || item.snippet.thumbnails?.high?.url || '',
      tags: item.snippet.tags || [],
    }));
  } catch (error) {
    console.error('YouTube channel videos fetch error:', error);
    return [];
  }
}

// --- OAuth-based functions ---

/**
 * Fetch the authenticated user's channel data using an OAuth access token.
 */
export async function fetchMyChannelOAuth(accessToken: string): Promise<YouTubeChannelData | null> {
  try {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items?.[0];
    if (!item) return null;
    return {
      id: item.id,
      title: item.snippet.title,
      description: item.snippet.description,
      subscriberCount: parseInt(item.statistics.subscriberCount || '0'),
      videoCount: parseInt(item.statistics.videoCount || '0'),
      viewCount: parseInt(item.statistics.viewCount || '0'),
      thumbnailUrl: item.snippet.thumbnails?.high?.url || '',
      customUrl: item.snippet.customUrl || '',
    };
  } catch (err) {
    console.error('OAuth channel fetch error:', err);
    return null;
  }
}

/**
 * List the authenticated user's videos using an OAuth access token.
 */
export async function listMyVideosOAuth(accessToken: string, maxResults = 50): Promise<YouTubeVideoData[]> {
  try {
    // Get uploads playlist
    const channelRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!channelRes.ok) return [];
    const channelData = await channelRes.json();
    const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return [];

    // Get playlist items
    const playlistRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!playlistRes.ok) return [];
    const playlistData = await playlistRes.json();
    const videoIds = playlistData.items?.map((item: { contentDetails: { videoId: string } }) => item.contentDetails.videoId) || [];
    if (!videoIds.length) return [];

    // Get video details
    const videosRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds.join(',')}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!videosRes.ok) return [];
    const videosData = await videosRes.json();

    return (videosData.items || []).map((item: {
      id: string;
      snippet: {
        title: string; description: string; channelTitle: string; publishedAt: string;
        thumbnails: { maxres?: { url: string }; high?: { url: string } }; tags?: string[];
      };
      statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
      contentDetails: { duration: string };
    }) => ({
      id: item.id,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      viewCount: parseInt(item.statistics.viewCount || '0'),
      likeCount: parseInt(item.statistics.likeCount || '0'),
      commentCount: parseInt(item.statistics.commentCount || '0'),
      duration: item.contentDetails.duration,
      thumbnailUrl: item.snippet.thumbnails?.maxres?.url || item.snippet.thumbnails?.high?.url || '',
      tags: item.snippet.tags || [],
    }));
  } catch (err) {
    console.error('OAuth videos fetch error:', err);
    return [];
  }
}

/**
 * Upload a thumbnail to a YouTube video using an OAuth access token.
 */
export async function uploadThumbnailOAuth(
  accessToken: string,
  videoId: string,
  imageBuffer: Buffer,
  mimeType: string,
): Promise<{ success: boolean; thumbnailUrl?: string; error?: string }> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': mimeType,
          'Content-Length': imageBuffer.length.toString(),
        },
        body: new Uint8Array(imageBuffer),
      },
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: 'Upload failed' } }));
      return { success: false, error: err.error?.message || `Upload failed (${res.status})` };
    }

    const data = await res.json();
    return {
      success: true,
      thumbnailUrl: data.items?.[0]?.high?.url || data.items?.[0]?.default?.url,
    };
  } catch (err) {
    console.error('Thumbnail upload error:', err);
    return { success: false, error: err instanceof Error ? err.message : 'Upload failed' };
  }
}

export { extractVideoId };
