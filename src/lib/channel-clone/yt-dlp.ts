/**
 * yt-dlp wrapper for the channel-clone intake — runs inside a Vercel
 * Sandbox microVM, not as a local child process.
 *
 * Plan: `_plans/2026-06-06-channel-clone-vercel-sandbox.md`.
 *
 * Why a sandbox: yt-dlp is a Python tool that doesn't ship with the
 * Vercel function runtime. Spawning it as a local subprocess only
 * works under `npm run dev` on a developer machine that happens to
 * have it installed; production was a hard error until this rewrite.
 *
 * Security:
 *   - URLs MUST be pre-validated by `validateYoutubeUrl` upstream.
 *   - Commands are passed via argv array — no shell parsing, no
 *     hostile-URL injection vector.
 *   - `--no-config` keeps personal yt-dlp configs from influencing
 *     behaviour even if a dev had one on disk; in-sandbox there is
 *     no such config but the flag is cheap insurance.
 *   - Stderr is captured for logs but never echoed to the user.
 */

import type { Sandbox } from '@vercel/sandbox';
import { logger } from '@/lib/logger';
import { runInSandbox } from './sandbox-runtime';
import type { JobLogger } from './job-logger';

/** Hard timeout for the yt-dlp process. 5 min is generous for a
 *  480p ~11-min download under sandbox network. Longer means
 *  something's wrong (rate-limit, geo-block, etc.). */
const YT_DLP_TIMEOUT_MS = 5 * 60 * 1000;

/** Force yt-dlp to use the `android_vr` player client.
 *
 *  Per the yt-dlp wiki + recent (2026) maintainer guidance:
 *  - `web` / `web_safari` require a PO Token (BotGuard attestation)
 *    for streams. Without one YouTube returns degraded responses
 *    ("No title found in player responses").
 *  - `android` requires PO Token AND triggers the "Sign in to
 *    confirm you're not a bot" gate from cloud IPs.
 *  - `tv_embedded` was deprecated in yt-dlp ("Skipping unsupported
 *    client" warning).
 *  - `android_vr` does NOT require a PO Token and does NOT use the
 *    n-sig JS challenge — making it the only client that works
 *    cleanly without (a) a Proof-of-Origin sidecar, (b) residential
 *    proxies, or (c) a JavaScript runtime in the sandbox.
 *
 *  When YouTube eventually hardens android_vr too, the next move is
 *  storyboards (no video bytes downloaded) + a managed transcript
 *  API. See `_plans/2026-06-06-channel-clone-vercel-sandbox.md`
 *  appendix for the full landscape. */
const YT_DLP_EXTRACTOR_ARGS = 'youtube:player_client=android_vr';


export interface YtDlpVideoMetadata {
  videoId: string;
  videoUrl: string;
  title: string;
  uploader: string | null;
  channelUrl: string | null;
  uploadDate: string | null;
  durationSec: number;
  viewCount: number | null;
}

export interface YtDlpDownloadResult {
  metadata: YtDlpVideoMetadata;
  /** Path to the merged video file INSIDE the sandbox filesystem. */
  videoSandboxPath: string;
  /** Path to the cleaned transcript file INSIDE the sandbox (SRT),
   *  or null when no auto-captions were available. */
  transcriptSandboxPath: string | null;
}

/** Fetch the latest N long-form videos from a channel's URL inside
 *  the sandbox. Doesn't download the videos themselves — that's a
 *  second pass.
 *
 *  `cookiesPath` is the absolute path to a Netscape-format cookies
 *  file inside the sandbox (see sandbox-runtime.ts). yt-dlp uses it
 *  via `--cookies` to authenticate against YouTube — required to
 *  bypass the "Sign in to confirm you're not a bot" gate that hits
 *  any unauthenticated request from a cloud IP. */
export async function listChannelVideos(
  sandbox: Sandbox,
  cookiesPath: string,
  canonicalChannelUrl: string,
  options: { maxVideos: number } = { maxVideos: 5 },
  log?: JobLogger,
): Promise<YtDlpVideoMetadata[]> {
  log?.info('yt-dlp', 'list channel videos', { url: canonicalChannelUrl, max: options.maxVideos });
  logger.info('[channel-clone yt-dlp] list-videos start', {
    url: canonicalChannelUrl,
    max: options.maxVideos,
  });
  // `--flat-playlist` returns entries quickly (no per-video probe),
  // `--print` gives JSONL so we can parse line-by-line. We filter
  // Shorts by skipping `youtube.com/shorts/` entries client-side.
  const args = [
    '--no-config',
    '--cookies', cookiesPath,
    '--extractor-args', YT_DLP_EXTRACTOR_ARGS,
    '--flat-playlist',
    '--playlist-end', String(options.maxVideos * 2), // overshoot to filter shorts
    '--print', '%(id)s|||%(url)s|||%(title)s|||%(uploader)s|||%(channel_url)s|||%(duration)s',
    canonicalChannelUrl,
  ];
  const { stdout, stderr, exitCode } = await runInSandbox(sandbox, {
    cmd: 'yt-dlp',
    args,
    timeoutMs: YT_DLP_TIMEOUT_MS,
  });
  if (exitCode !== 0) {
    throw new Error(`yt-dlp exited with code ${exitCode}: ${stderr.slice(-2000).trim()}`);
  }
  const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const metas: YtDlpVideoMetadata[] = [];
  for (const line of lines) {
    const parts = line.split('|||');
    if (parts.length < 6) continue;
    const [id, url, title, uploader, channelUrl, durationRaw] = parts;
    if (!id || id.length !== 11) continue;
    const durationSec = Number(durationRaw);
    if (!Number.isFinite(durationSec) || durationSec < 60) continue; // skip Shorts + bumpers
    metas.push({
      videoId: id,
      videoUrl: url || `https://www.youtube.com/watch?v=${id}`,
      title: title || '(no title)',
      uploader: uploader === 'NA' ? null : uploader,
      channelUrl: channelUrl === 'NA' ? null : channelUrl,
      uploadDate: null,
      durationSec: Math.round(durationSec),
      viewCount: null,
    });
    if (metas.length >= options.maxVideos) break;
  }
  log?.info('yt-dlp', 'list channel videos done', { count: metas.length });
  logger.info('[channel-clone yt-dlp] list-videos done', {
    url: canonicalChannelUrl,
    count: metas.length,
  });
  return metas;
}

/** Download a single video at 480p plus auto-captions to the supplied
 *  sandbox directory. Returns sandbox-relative paths the caller will
 *  read back via sandbox.readFileToBuffer.
 *
 *  `ffmpegPath` is the absolute path to the ffmpeg binary inside the
 *  sandbox. yt-dlp needs it via `--ffmpeg-location` to merge the
 *  separate audio + video streams the `bv*+ba` format selector
 *  pulls down. Without it yt-dlp errors with "ffmpeg not found"
 *  the moment it tries to mux. */
export async function downloadVideo(
  sandbox: Sandbox,
  ffmpegPath: string,
  cookiesPath: string,
  canonicalVideoUrl: string,
  outDir: string,
  log?: JobLogger,
): Promise<YtDlpDownloadResult> {
  log?.info('yt-dlp', 'download start', { url: canonicalVideoUrl });
  logger.info('[channel-clone yt-dlp] download start', { url: canonicalVideoUrl, outDir });
  // 480p ceiling keeps file size manageable (~15-30 MB for an
  // 11-min explainer). Convert auto-subs to SRT for the cleaner.
  const args = [
    '--no-config',
    '--cookies', cookiesPath,
    '--extractor-args', YT_DLP_EXTRACTOR_ARGS,
    '--ffmpeg-location', ffmpegPath,
    '--write-auto-subs',
    '--sub-langs', 'en.*,en',
    '--sub-format', 'vtt',
    '--convert-subs', 'srt',
    '-f', 'bv*[height<=480]+ba/b[height<=480]',
    '-o', `${outDir}/%(id)s.%(ext)s`,
    '--print', 'after_move:%(id)s|||%(filepath)s|||%(title)s|||%(uploader)s|||%(channel_url)s|||%(upload_date)s|||%(duration)s|||%(view_count)s',
    canonicalVideoUrl,
  ];
  const { stdout, stderr, exitCode } = await runInSandbox(sandbox, {
    cmd: 'yt-dlp',
    args,
    timeoutMs: YT_DLP_TIMEOUT_MS,
  });
  if (exitCode !== 0) {
    throw new Error(`yt-dlp exited with code ${exitCode}: ${stderr.slice(-2000).trim()}`);
  }
  const out = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  // The --print line we asked for surfaces on stdout after the
  // download completes; everything else (progress) goes to stderr.
  const printedLine = out.find((l) => l.includes('|||')) ?? '';
  const parts = printedLine.split('|||');
  if (parts.length < 8) {
    throw new Error(`yt-dlp download succeeded but did not surface metadata: ${printedLine || '(empty)'}`);
  }
  const [id, filepath, title, uploader, channelUrl, uploadDate, durationRaw, viewCountRaw] = parts;
  const durationSec = Number(durationRaw);
  const viewCount = Number(viewCountRaw);
  // The transcript path mirrors the video filename, with .en.srt
  // (or .en-orig.srt) as the suffix. Probe both — yt-dlp picks
  // whichever variant the upload had.
  const transcriptCandidates = [
    `${outDir}/${id}.en.srt`,
    `${outDir}/${id}.en-orig.srt`,
  ];
  let transcriptSandboxPath: string | null = null;
  for (const candidate of transcriptCandidates) {
    // readFileToBuffer returns null on missing — we don't need the
    // contents here, just whether the file exists.
    // eslint-disable-next-line no-await-in-loop -- two-attempt fallback
    const buf = await sandbox.readFileToBuffer({ path: candidate }).catch(() => null);
    if (buf !== null) {
      transcriptSandboxPath = candidate;
      break;
    }
  }
  log?.info('yt-dlp', 'download done', {
    videoId: id,
    durationSec: Math.round(durationSec),
    transcript: transcriptSandboxPath ? 'yes' : 'none',
  });
  logger.info('[channel-clone yt-dlp] download done', {
    videoId: id,
    videoSandboxPath: filepath,
    transcriptSandboxPath,
    durationSec: Math.round(durationSec),
  });
  return {
    metadata: {
      videoId: id,
      videoUrl: canonicalVideoUrl,
      title: title || '(no title)',
      uploader: uploader === 'NA' ? null : uploader,
      channelUrl: channelUrl === 'NA' ? null : channelUrl,
      uploadDate: uploadDate === 'NA' ? null : uploadDate,
      durationSec: Math.round(durationSec),
      viewCount: Number.isFinite(viewCount) ? viewCount : null,
    },
    videoSandboxPath: filepath,
    transcriptSandboxPath,
  };
}
