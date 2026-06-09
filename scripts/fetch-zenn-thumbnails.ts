/**
 * Downloads YouTube thumbnails from a given channel handle into
 * `public/style-refs/<style-folder>/_raw/` for hand-curation into the
 * thumbnail style ref bundle.
 *
 * Default target: @Zenn0009 → public/style-refs/Paint-explainer-thumbnails/_raw/
 *
 * No auth required — uses the public RSS feed
 * (`https://www.youtube.com/feeds/videos.xml?channel_id=...`) which returns
 * the latest ~15 videos per channel. For a deeper backlog the user would
 * need the YouTube Data API; the RSS surface is enough for a starter
 * ref bundle.
 *
 * Usage:
 *   npx tsx scripts/fetch-zenn-thumbnails.ts
 *   npx tsx scripts/fetch-zenn-thumbnails.ts <handle> <style-folder>
 *   npx tsx scripts/fetch-zenn-thumbnails.ts Zenn0009 Paint-explainer-thumbnails
 *
 * After running:
 *   1. Open public/style-refs/Paint-explainer-thumbnails/_raw/ and review
 *      the downloaded JPGs.
 *   2. Move the 4-6 strongest exemplars up to the parent folder
 *      (public/style-refs/Paint-explainer-thumbnails/).
 *   3. Move stylistic outliers to a sibling folder
 *      `_review-not-paint-thumbs/` per the project convention.
 *
 * Plan: _plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEFAULT_HANDLE = 'Zenn0009';
const DEFAULT_STYLE_FOLDER = 'Paint-explainer-thumbnails';
/** Hard cap — keeps the script from accidentally dumping a thousand
 *  files into the working tree if the RSS feed grows. */
const MAX_DOWNLOADS = 30;

interface VideoEntry {
  id: string;
  title: string;
}

async function main() {
  const args = process.argv.slice(2);
  const handle = (args[0] || DEFAULT_HANDLE).replace(/^@/, '');
  const styleFolder = args[1] || DEFAULT_STYLE_FOLDER;

  console.info(`[fetch-zenn-thumbnails] handle=${handle} styleFolder=${styleFolder}`);

  const channelId = await resolveChannelIdFromHandle(handle);
  console.info(`[fetch-zenn-thumbnails] resolved channelId=${channelId}`);

  const videos = await fetchVideoListFromRss(channelId);
  console.info(`[fetch-zenn-thumbnails] RSS returned ${videos.length} videos`);

  const targets = videos.slice(0, MAX_DOWNLOADS);
  if (targets.length === 0) {
    console.error('[fetch-zenn-thumbnails] no videos found — channel may have no public uploads, or the handle is wrong');
    process.exit(1);
  }

  const outDir = resolve(process.cwd(), 'public', 'style-refs', styleFolder, '_raw');
  await mkdir(outDir, { recursive: true });
  console.info(`[fetch-zenn-thumbnails] writing to ${outDir}`);

  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const v = targets[i];
    const slug = slugify(v.title).slice(0, 60) || 'untitled';
    const filename = `${String(i + 1).padStart(2, '0')}-${slug}-${v.id}.jpg`;
    const outPath = join(outDir, filename);

    if (await fileExists(outPath)) {
      console.info(`[fetch-zenn-thumbnails] skip (already exists): ${filename}`);
      skipCount += 1;
      continue;
    }

    const bytes = await downloadThumbnail(v.id);
    if (!bytes) {
      console.warn(`[fetch-zenn-thumbnails] FAIL: ${v.id} (${v.title})`);
      failCount += 1;
      continue;
    }
    await writeFile(outPath, bytes);
    console.info(`[fetch-zenn-thumbnails] saved (${bytes.byteLength.toLocaleString()} bytes): ${filename}`);
    okCount += 1;
  }

  console.info(`[fetch-zenn-thumbnails] done — saved=${okCount} skipped=${skipCount} failed=${failCount}`);
  console.info('');
  console.info('Next steps:');
  console.info(`  1. Open ${outDir} and review the downloaded JPGs.`);
  console.info(`  2. Move 4-6 strongest exemplars up to public/style-refs/${styleFolder}/`);
  console.info('  3. Move stylistic outliers to _review-not-paint-thumbs/ alongside _raw/');
}

/**
 * Resolves a YouTube handle (`@Zenn0009`) to its canonical channel id
 * (`UC...`). RSS feeds only accept channel ids, not handles, so this
 * detour is required.
 *
 * Implementation: fetch the channel page and grep the embedded
 * `"channelId":"UC..."` field that YouTube ships in every channel page's
 * initial-data payload. Brittle if YouTube changes the markup but cheap
 * enough that any breakage is easy to spot and patch.
 */
async function resolveChannelIdFromHandle(handle: string): Promise<string> {
  const url = `https://www.youtube.com/@${encodeURIComponent(handle)}`;
  const res = await fetch(url, {
    headers: {
      // YouTube refuses requests without a UA that looks like a browser.
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
  });
  if (!res.ok) {
    throw new Error(`channel page HTTP ${res.status} for handle ${handle}`);
  }
  const html = await res.text();
  const match = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
  if (!match) {
    const alt = html.match(/channel\/(UC[a-zA-Z0-9_-]{22})/);
    if (alt) return alt[1];
    throw new Error(`could not extract channelId from handle ${handle} (page markup may have changed)`);
  }
  return match[1];
}

async function fetchVideoListFromRss(channelId: string): Promise<VideoEntry[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`RSS HTTP ${res.status} for channel ${channelId}`);
  }
  const xml = await res.text();
  return parseRssEntries(xml);
}

/**
 * Minimal RSS parser tuned to YouTube's `<entry>` shape. Avoids pulling
 * in an XML library for a 1-shot dev script. Looks for paired
 * `<yt:videoId>` and `<title>` inside each `<entry>`.
 */
export function parseRssEntries(xml: string): VideoEntry[] {
  const entries: VideoEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const body = m[1];
    const idMatch = body.match(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/);
    const titleMatch = body.match(/<title>([\s\S]*?)<\/title>/);
    if (idMatch && titleMatch) {
      entries.push({
        id: idMatch[1],
        title: decodeXmlEntities(titleMatch[1].trim()),
      });
    }
  }
  return entries;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Downloads the best-available thumbnail for a video id. Tries
 * `maxresdefault.jpg` first (1280×720) and falls back to
 * `hqdefault.jpg` (480×360) when the channel didn't upload a
 * high-res. Some older videos don't have maxres available even
 * if uploaded recently — the fallback covers that.
 */
async function downloadThumbnail(videoId: string): Promise<Buffer | null> {
  for (const variant of ['maxresdefault', 'hqdefault']) {
    const url = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${variant}.jpg`;
    const res = await fetch(url);
    if (res.ok) {
      const ab = await res.arrayBuffer();
      // YouTube returns a small placeholder when the requested resolution
      // doesn't exist for the video. Reject anything smaller than 2KB to
      // skip those placeholders.
      if (ab.byteLength > 2048) {
        return Buffer.from(ab);
      }
    }
  }
  return null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('[fetch-zenn-thumbnails] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
