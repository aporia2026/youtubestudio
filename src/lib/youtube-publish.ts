/**
 * Push-to-YouTube helpers for snippet (title / description / tags) and
 * thumbnail updates via the Data API v3.
 *
 * Title / description live on `youtube.videos.update` and require the
 * `youtube` or `youtube.force-ssl` OAuth scope. The API insists on a
 * full snippet PATCH including `categoryId` (otherwise it 400s with
 * "Required field categoryId is missing"), so we fetch the current
 * snippet first when the caller didn't supply one.
 *
 * Thumbnail upload is delegated to `uploadThumbnailOAuth` in
 * `src/lib/youtube.ts` — no point reimplementing the multipart wire.
 *
 * Quota cost (May 2026):
 *   videos.update            50 units
 *   thumbnails.set           50 units
 * Default daily quota is 10,000 units, so a typical A/B swap (one of
 * each) is 0.1% of the budget — manual swap rate isn't a concern.
 */
import { uploadThumbnailOAuth } from './youtube';

const VIDEOS_BASE = 'https://www.googleapis.com/youtube/v3/videos';

export interface VideoSnippetUpdate {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
}

export interface UpdateSnippetResult {
  success: boolean;
  title?: string;
  description?: string;
  error?: string;
}

interface RemoteSnippet {
  title: string;
  description: string;
  tags?: string[];
  categoryId: string;
  defaultLanguage?: string;
}

/** Fetch the current snippet so we can build a complete PATCH body. */
async function fetchCurrentSnippet(
  accessToken: string,
  videoId: string,
): Promise<RemoteSnippet | null> {
  const res = await fetch(
    `${VIDEOS_BASE}?part=snippet&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { items?: Array<{ snippet?: Partial<RemoteSnippet> }> };
  const snippet = data.items?.[0]?.snippet;
  if (!snippet || typeof snippet.title !== 'string' || typeof snippet.categoryId !== 'string') {
    return null;
  }
  return {
    title: snippet.title,
    description: snippet.description ?? '',
    tags: snippet.tags ?? [],
    categoryId: snippet.categoryId,
    defaultLanguage: snippet.defaultLanguage,
  };
}

/**
 * Update a YouTube video's title / description / tags via OAuth. The
 * caller doesn't have to know the categoryId — we fetch the current
 * snippet on-the-fly when it's missing.
 */
export async function updateYoutubeVideoSnippet(args: {
  accessToken: string;
  videoId: string;
  patch: VideoSnippetUpdate;
}): Promise<UpdateSnippetResult> {
  const { accessToken, videoId, patch } = args;

  const titleTrimmed = patch.title?.trim();
  if (titleTrimmed !== undefined && titleTrimmed.length === 0) {
    return { success: false, error: 'title cannot be blank' };
  }
  if (titleTrimmed && titleTrimmed.length > 100) {
    return { success: false, error: 'title exceeds YouTube 100-character limit' };
  }
  if (patch.description !== undefined && patch.description.length > 5000) {
    return { success: false, error: 'description exceeds YouTube 5000-character limit' };
  }

  let categoryId = patch.categoryId;
  let title = titleTrimmed;
  let description = patch.description;
  let tags = patch.tags;

  if (!categoryId || title === undefined || description === undefined) {
    const current = await fetchCurrentSnippet(accessToken, videoId);
    if (!current) {
      return { success: false, error: 'Could not load current video snippet from YouTube' };
    }
    categoryId = categoryId ?? current.categoryId;
    if (title === undefined) title = current.title;
    if (description === undefined) description = current.description;
    if (tags === undefined) tags = current.tags;
  }

  const body = {
    id: videoId,
    snippet: {
      title,
      description,
      categoryId,
      ...(tags ? { tags } : {}),
    },
  };

  const res = await fetch(`${VIDEOS_BASE}?part=snippet`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg =
      (errBody as { error?: { message?: string } })?.error?.message || `Update failed (${res.status})`;
    return { success: false, error: msg };
  }

  const data = (await res.json()) as { snippet?: { title?: string; description?: string } };
  return {
    success: true,
    title: data.snippet?.title,
    description: data.snippet?.description,
  };
}

export interface PushVariantArgs {
  accessToken: string;
  videoId: string;
  title?: string;
  description?: string;
  /** Pre-fetched thumbnail bytes. The caller is responsible for downloading
   *  whatever URL the variant points at (Vercel Blob, Kie, etc.) so the
   *  push-to-YouTube layer stays storage-agnostic. */
  thumbnail?: { buffer: Buffer; mimeType: string };
}

export interface PushVariantResult {
  snippet: UpdateSnippetResult | null;
  thumbnail: { success: boolean; thumbnailUrl?: string; error?: string } | null;
}

/**
 * Push a complete A/B variant to YouTube — title (+ optional description)
 * and thumbnail in one call. Either side is independently optional so the
 * caller can do a thumbnail-only or title-only swap.
 *
 * The two YouTube calls are issued sequentially (snippet first) so a
 * snippet-update failure short-circuits before we burn the thumbnail
 * quota. A thumbnail failure does NOT roll back the snippet — the
 * partial state is reported back so the caller can surface it.
 */
export async function pushVariantToYoutube(args: PushVariantArgs): Promise<PushVariantResult> {
  const result: PushVariantResult = { snippet: null, thumbnail: null };

  if (args.title !== undefined || args.description !== undefined) {
    result.snippet = await updateYoutubeVideoSnippet({
      accessToken: args.accessToken,
      videoId: args.videoId,
      patch: { title: args.title, description: args.description },
    });
    if (!result.snippet.success) return result;
  }

  if (args.thumbnail) {
    result.thumbnail = await uploadThumbnailOAuth(
      args.accessToken,
      args.videoId,
      args.thumbnail.buffer,
      args.thumbnail.mimeType,
    );
  }

  return result;
}

/**
 * Download a thumbnail URL and return it as a Buffer + mime type, ready
 * to feed into `pushVariantToYoutube`. Validates the size against
 * YouTube's 2 MB hard limit. Returns null on fetch failure so the
 * caller can choose to skip the thumbnail leg of the swap.
 */
export async function downloadThumbnailForUpload(
  url: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const MAX_SIZE = 2 * 1024 * 1024;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    const arr = await res.arrayBuffer();
    if (arr.byteLength > MAX_SIZE) return null;
    return { buffer: Buffer.from(arr), mimeType: contentType };
  } catch {
    return null;
  }
}
