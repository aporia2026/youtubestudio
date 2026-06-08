/**
 * Playlist read + add for the bulk-batch upload flow.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Two operations:
 *   - `listMyPlaylists` — paginated list of the authenticated user's
 *     playlists (used by the batch setup form + per-short review
 *     queue to populate the multi-select picker).
 *   - `addVideoToPlaylists` — attach an uploaded video to one or
 *     more playlists. One API call per playlist (the API does not
 *     support batched attachment), so failures are per-playlist.
 *
 * Quota (verified 2026-06-08 against
 * https://developers.google.com/youtube/v3/determine_quota_cost):
 *   playlists.list             1 unit
 *   playlistItems.insert      50 units
 * Cheap relative to videos.insert (100 units).
 */

const PLAYLISTS_LIST_BASE = 'https://www.googleapis.com/youtube/v3/playlists';
const PLAYLIST_ITEMS_BASE = 'https://www.googleapis.com/youtube/v3/playlistItems';

/** Slim shape the picker needs — id + title is enough; the API
 *  returns much more (description, thumbnails, item count) but the
 *  dropdown does not surface those. */
export interface YoutubePlaylist {
  id: string;
  title: string;
  itemCount: number | null;
}

/** Outcome for a single playlist attachment. The uploader records
 *  the array verbatim so the review queue can show which playlist
 *  attachments failed (e.g. private playlist owned by another
 *  account) without rolling back the upload itself. */
export interface PlaylistAttachmentResult {
  playlistId: string;
  success: boolean;
  error: string | null;
}

/**
 * List every playlist owned by the authenticated user (the OAuth
 * `mine=true` parameter does this). Paginates internally — the API
 * caps `maxResults` at 50 per page; typical channels have well under
 * 100 playlists so two pages is plenty, but the loop handles
 * arbitrary counts.
 */
export async function listMyPlaylists(accessToken: string): Promise<YoutubePlaylist[]> {
  const out: YoutubePlaylist[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      mine: 'true',
      maxResults: '50',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${PLAYLISTS_LIST_BASE}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`playlists.list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as {
      nextPageToken?: string;
      items?: Array<{
        id: string;
        snippet?: { title?: string };
        contentDetails?: { itemCount?: number };
      }>;
    };

    for (const item of payload.items ?? []) {
      out.push({
        id: item.id,
        title: item.snippet?.title ?? '(untitled)',
        itemCount: item.contentDetails?.itemCount ?? null,
      });
    }

    pageToken = payload.nextPageToken;
  } while (pageToken);

  return out;
}

/**
 * Attach a video to N playlists. Issues N parallel
 * `playlistItems.insert` calls; partial failure is reported per-playlist
 * so the caller can persist the successful subset on the short row and
 * surface the failures in the UI.
 */
export async function addVideoToPlaylists(args: {
  accessToken: string;
  videoId: string;
  playlistIds: readonly string[];
}): Promise<PlaylistAttachmentResult[]> {
  const { accessToken, videoId, playlistIds } = args;

  if (playlistIds.length === 0) {
    return [];
  }

  console.info('[shorts-upload playlist-add]', {
    video_id: videoId,
    playlist_count: playlistIds.length,
  });

  const settled = await Promise.allSettled(
    playlistIds.map(async (playlistId): Promise<PlaylistAttachmentResult> => {
      const body = {
        snippet: {
          playlistId,
          resourceId: { kind: 'youtube#video', videoId },
        },
      };

      const res = await fetch(`${PLAYLIST_ITEMS_BASE}?part=snippet`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        return { playlistId, success: true, error: null };
      }

      let detail = '';
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        detail = errBody.error?.message ?? `HTTP ${res.status}`;
      } catch {
        detail = `HTTP ${res.status}`;
      }
      return { playlistId, success: false, error: detail };
    }),
  );

  // Promise.allSettled never rejects; map rejections (unlikely — we
  // didn't throw above) to error results so the return type is uniform.
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { playlistId: playlistIds[i], success: false, error: String(r.reason) };
  });
}
