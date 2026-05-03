// YouTube Data API integration
// Infrastructure ready — add API credentials in .env to activate
import { logger } from '@/lib/logger';

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
    logger.error('YouTube API error', { detail: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function fetchChannelData(channelIdOrUrl: string, overrideApiKey?: string): Promise<YouTubeChannelData | null> {
  const apiKey = overrideApiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  const channelId = channelIdOrUrl;

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
    logger.error('YouTube channel fetch error', { detail: error instanceof Error ? error.message : String(error) });
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
    logger.error('YouTube channel videos fetch error', { detail: error instanceof Error ? error.message : String(error) });
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
    logger.error('OAuth channel fetch error', { detail: err instanceof Error ? err.message : String(err) });
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
    logger.error('OAuth videos fetch error', { detail: err instanceof Error ? err.message : String(err) });
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
      thumbnailUrl: data.items?.[0]?.high?.url || data.items?.[0]?.medium?.url || data.items?.[0]?.default?.url || data.high?.url || data.default?.url,
    };
  } catch (err) {
    logger.error('Thumbnail upload error', { detail: err instanceof Error ? err.message : String(err) });
    return { success: false, error: err instanceof Error ? err.message : 'Upload failed' };
  }
}

export { extractVideoId };

// ============================================================
// Extended fetching for competitor analysis — rich fields, pagination, comments
// ============================================================

export interface YouTubeVideoRich extends YouTubeVideoData {
  categoryId: string;
  defaultAudioLanguage?: string;
  topicCategories?: string[];
}

/**
 * Fetch up to `maxResults` videos from a channel with full snippet data.
 * Paginates playlistItems (50 per page) and batches video details (50 per request).
 */
export async function fetchChannelVideosRich(
  channelId: string,
  maxResults = 200,
  overrideApiKey?: string,
): Promise<YouTubeVideoRich[]> {
  const apiKey = overrideApiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  try {
    const channelRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${apiKey}`,
    );
    const channelData = await channelRes.json();
    const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return [];

    const videoIds: string[] = [];
    let pageToken: string | undefined;
    while (videoIds.length < maxResults) {
      const pageSize = Math.min(50, maxResults - videoIds.length);
      const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
      url.searchParams.set('part', 'contentDetails');
      url.searchParams.set('playlistId', uploadsPlaylistId);
      url.searchParams.set('maxResults', String(pageSize));
      url.searchParams.set('key', apiKey);
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url.toString());
      if (!res.ok) break;
      const data = await res.json();
      const batch = (data.items || []).map((it: { contentDetails: { videoId: string } }) => it.contentDetails.videoId);
      videoIds.push(...batch);
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    if (!videoIds.length) return [];

    // Batch video details in groups of 50
    const videos: YouTubeVideoRich[] = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,topicDetails&id=${chunk.join(',')}&key=${apiKey}`,
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of data.items || []) {
        videos.push({
          id: item.id,
          title: item.snippet.title,
          description: item.snippet.description || '',
          channelTitle: item.snippet.channelTitle,
          publishedAt: item.snippet.publishedAt,
          viewCount: parseInt(item.statistics?.viewCount || '0'),
          likeCount: parseInt(item.statistics?.likeCount || '0'),
          commentCount: parseInt(item.statistics?.commentCount || '0'),
          duration: item.contentDetails?.duration || 'PT0S',
          thumbnailUrl: item.snippet.thumbnails?.maxres?.url || item.snippet.thumbnails?.high?.url || '',
          tags: item.snippet.tags || [],
          categoryId: item.snippet.categoryId || '',
          defaultAudioLanguage: item.snippet.defaultAudioLanguage,
          topicCategories: item.topicDetails?.topicCategories || [],
        });
      }
    }
    return videos;
  } catch (err) {
    logger.error('fetchChannelVideosRich error', { detail: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export interface YouTubeComment {
  text: string;
  authorName: string;
  likeCount: number;
  publishedAt: string;
}

/** Fetch top comments (by relevance) for a single video. */
export async function fetchVideoComments(
  videoId: string,
  maxResults = 20,
  overrideApiKey?: string,
): Promise<YouTubeComment[]> {
  const apiKey = overrideApiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=${maxResults}&order=relevance&key=${apiKey}`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map((it: {
      snippet: { topLevelComment: { snippet: { textDisplay: string; authorDisplayName: string; likeCount: number; publishedAt: string } } };
    }) => ({
      text: it.snippet.topLevelComment.snippet.textDisplay,
      authorName: it.snippet.topLevelComment.snippet.authorDisplayName,
      likeCount: it.snippet.topLevelComment.snippet.likeCount,
      publishedAt: it.snippet.topLevelComment.snippet.publishedAt,
    }));
  } catch {
    return [];
  }
}

// YouTube category ID → human label (for categoryId 1-44, US region)
export const YT_CATEGORY_MAP: Record<string, string> = {
  '1': 'Film & Animation', '2': 'Autos & Vehicles', '10': 'Music', '15': 'Pets & Animals',
  '17': 'Sports', '19': 'Travel & Events', '20': 'Gaming', '22': 'People & Blogs',
  '23': 'Comedy', '24': 'Entertainment', '25': 'News & Politics', '26': 'Howto & Style',
  '27': 'Education', '28': 'Science & Technology', '29': 'Nonprofits & Activism',
};

// ============================================================
// URL classification helpers
// ============================================================

export type ParsedYouTubeUrl =
  | { kind: 'video'; videoId: string }
  | { kind: 'channel-handle'; handle: string }
  | { kind: 'channel-id'; channelId: string }
  | { kind: 'unknown' };

/**
 * Classify a raw YouTube URL. Supports watch/embed/shorts/youtu.be, @handle,
 * /channel/UCxxx, /c/custom, /user/legacy.
 */
export function parseYouTubeUrl(raw: string): ParsedYouTubeUrl {
  const url = raw.trim();
  // Video URL?
  const vid = extractVideoId(url);
  if (vid) return { kind: 'video', videoId: vid };
  // Handle? e.g. youtube.com/@FinestExplainerr or just @FinestExplainerr
  const handleMatch = url.match(/(?:youtube\.com\/)?@([A-Za-z0-9._-]{3,30})(?:[/?#]|$)/);
  if (handleMatch) return { kind: 'channel-handle', handle: handleMatch[1] };
  // Direct channel ID
  const idMatch = url.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,})/);
  if (idMatch) return { kind: 'channel-id', channelId: idMatch[1] };
  // /c/custom-name or /user/legacy-name — we can resolve via channels?forUsername or search
  const legacyMatch = url.match(/youtube\.com\/(?:c|user)\/([A-Za-z0-9._-]+)/);
  if (legacyMatch) return { kind: 'channel-handle', handle: legacyMatch[1] };
  return { kind: 'unknown' };
}

// ============================================================
// Channel Naming support — handle availability + ref video fetch
// ============================================================

/**
 * Handles that YouTube reserves or we should never suggest. Not exhaustive —
 * YouTube's real reserved set is internal. This catches the obvious ones.
 */
const RESERVED_HANDLES = new Set([
  'youtube', 'youtubekids', 'youtubestudio', 'youtubemusic', 'ytcreators', 'ytofficial',
  'google', 'googleofficial', 'googlecloud', 'googleplay',
  'admin', 'administrator', 'support', 'help', 'staff', 'mod', 'moderator', 'official',
  'null', 'undefined', 'anonymous', 'deleted', 'banned',
  'api', 'test', 'testing', 'example', 'demo',
]);

/** Simple in-memory cache (per lambda instance) to avoid re-checking the same handle. */
const handleCheckCache = new Map<string, { result: Awaited<ReturnType<typeof doHandleCheck>>; ts: number }>();
const HANDLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function doHandleCheck(
  handle: string,
  apiKey: string,
): Promise<{ available: boolean; takenBy?: { id: string; title: string; thumbnail?: string }; error?: string; note?: string }> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=@${handle}&key=${apiKey}`,
    );
    if (!res.ok) {
      return { available: false, error: `YouTube API ${res.status}` };
    }
    const data = await res.json();
    if (!data.items || data.items.length === 0) {
      return {
        available: true,
        note: 'Not found via forHandle — likely free, but verify by visiting youtube.com/@handle before relying on it. YouTube may still reserve recently-created or brand-protected handles.',
      };
    }
    const item = data.items[0];
    return {
      available: false,
      takenBy: {
        id: item.id,
        title: item.snippet?.title || 'Unknown',
        thumbnail: item.snippet?.thumbnails?.default?.url,
      },
    };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : 'lookup failed' };
  }
}

/**
 * Check if a YouTube @handle is available. "Available" is best-effort — YouTube's
 * forHandle endpoint does not reliably return every reserved/pending handle. We
 * filter obvious reserved words up front, cache results for 24h, and annotate
 * the response with a `note` reminding users to verify manually.
 */
export async function checkHandleAvailable(
  handleRaw: string,
  overrideApiKey?: string,
): Promise<{ available: boolean; takenBy?: { id: string; title: string; thumbnail?: string }; error?: string; note?: string }> {
  const apiKey = overrideApiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return { available: false, error: 'YOUTUBE_API_KEY not configured' };

  const handle = handleRaw.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(handle)) {
    return { available: false, error: 'Invalid handle format (3-30 chars, a-z, 0-9, _ - .)' };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { available: false, error: 'Reserved — YouTube/Google reserves this handle' };
  }

  // Cache lookup
  const cached = handleCheckCache.get(handle);
  if (cached && Date.now() - cached.ts < HANDLE_CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await doHandleCheck(handle, apiKey);
  handleCheckCache.set(handle, { result, ts: Date.now() });
  return result;
}

/** Batch availability check with concurrency limit. */
export async function checkHandlesBatch(
  handles: string[],
  overrideApiKey?: string,
  concurrency = 5,
): Promise<Record<string, { available: boolean; takenBy?: { id: string; title: string; thumbnail?: string }; error?: string; note?: string }>> {
  const results: Record<string, Awaited<ReturnType<typeof checkHandleAvailable>>> = {};
  const queue = [...handles];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const h = queue.shift()!;
      results[h] = await checkHandleAvailable(h, overrideApiKey);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Fetch title/description/tags for a single video (by URL or ID) — used as naming reference. */
export async function fetchVideoMetadata(
  urlOrId: string,
  overrideApiKey?: string,
): Promise<{ title: string; description: string; channelTitle: string; tags: string[] } | null> {
  const apiKey = overrideApiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;
  const id = extractVideoId(urlOrId) || urlOrId;
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(id)}&key=${apiKey}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items?.[0];
    if (!item) return null;
    return {
      title: item.snippet.title || '',
      description: (item.snippet.description || '').slice(0, 1000),
      channelTitle: item.snippet.channelTitle || '',
      tags: item.snippet.tags || [],
    };
  } catch {
    return null;
  }
}

/** Parse ISO 8601 duration string to seconds. */
export function parseDurationSeconds(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (parseInt(h || '0') * 3600) + (parseInt(m || '0') * 60) + parseInt(s || '0');
}
