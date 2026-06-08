import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listMyPlaylists, addVideoToPlaylists } from '@/lib/youtube-playlists';

describe('listMyPlaylists', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('flattens a single page', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [
            { id: 'PL_A', snippet: { title: 'Alpha' }, contentDetails: { itemCount: 5 } },
            { id: 'PL_B', snippet: { title: 'Beta' }, contentDetails: { itemCount: 12 } },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await listMyPlaylists('token');
    expect(result).toEqual([
      { id: 'PL_A', title: 'Alpha', itemCount: 5 },
      { id: 'PL_B', title: 'Beta', itemCount: 12 },
    ]);

    globalThis.fetch = origFetch;
  });

  it('paginates with nextPageToken', async () => {
    let pageCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      pageCount += 1;
      const u = url.toString();
      if (pageCount === 1) {
        expect(u).not.toContain('pageToken=');
        return new Response(
          JSON.stringify({
            nextPageToken: 'TOK2',
            items: [{ id: 'PL_1', snippet: { title: 'P1' }, contentDetails: { itemCount: 1 } }],
          }),
          { status: 200 },
        );
      }
      expect(u).toContain('pageToken=TOK2');
      return new Response(
        JSON.stringify({
          items: [{ id: 'PL_2', snippet: { title: 'P2' }, contentDetails: { itemCount: 2 } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await listMyPlaylists('token');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('PL_1');
    expect(result[1].id).toBe('PL_2');

    globalThis.fetch = origFetch;
  });

  it('falls back to "(untitled)" for items missing snippet.title', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ items: [{ id: 'PL_X', contentDetails: {} }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await listMyPlaylists('token');
    expect(result[0]).toEqual({ id: 'PL_X', title: '(untitled)', itemCount: null });

    globalThis.fetch = origFetch;
  });

  it('throws on non-OK response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;

    await expect(listMyPlaylists('token')).rejects.toThrow(/playlists.list failed \(403\)/);

    globalThis.fetch = origFetch;
  });
});

describe('addVideoToPlaylists', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty array when no playlists provided (no API call)', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const result = await addVideoToPlaylists({ accessToken: 't', videoId: 'V', playlistIds: [] });
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();

    globalThis.fetch = origFetch;
  });

  it('returns success for each playlist on a 200 response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'newPlaylistItem' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await addVideoToPlaylists({
      accessToken: 't',
      videoId: 'V',
      playlistIds: ['PL_1', 'PL_2'],
    });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.success)).toBe(true);
    expect(result.map((r) => r.playlistId)).toEqual(['PL_1', 'PL_2']);

    globalThis.fetch = origFetch;
  });

  it('handles partial failure — one playlist 403s while the other succeeds', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit | undefined) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        snippet?: { playlistId?: string };
      };
      if (body.snippet?.playlistId === 'PL_BAD') {
        return new Response(
          JSON.stringify({ error: { message: 'Playlist not found.' } }),
          { status: 404 },
        );
      }
      return new Response(JSON.stringify({ id: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await addVideoToPlaylists({
      accessToken: 't',
      videoId: 'V',
      playlistIds: ['PL_GOOD', 'PL_BAD'],
    });

    const good = result.find((r) => r.playlistId === 'PL_GOOD');
    const bad = result.find((r) => r.playlistId === 'PL_BAD');
    expect(good?.success).toBe(true);
    expect(bad?.success).toBe(false);
    expect(bad?.error).toContain('Playlist not found');

    globalThis.fetch = origFetch;
  });
});
