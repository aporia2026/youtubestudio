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

/** Hard timeout for the yt-dlp process. 5 min is generous for a
 *  480p ~11-min download under sandbox network. Longer means
 *  something's wrong (rate-limit, geo-block, etc.). */
const YT_DLP_TIMEOUT_MS = 5 * 60 * 1000;

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
 *  second pass. */
export async function listChannelVideos(
  sandbox: Sandbox,
  canonicalChannelUrl: string,
  options: { maxVideos: number } = { maxVideos: 5 },
): Promise<YtDlpVideoMetadata[]> {
  logger.info('[channel-clone yt-dlp] list-videos start', {
    url: canonicalChannelUrl,
    max: options.maxVideos,
  });
  // `--flat-playlist` returns entries quickly (no per-video probe),
  // `--print` gives JSONL so we can parse line-by-line. We filter
  // Shorts by skipping `youtube.com/shorts/` entries client-side.
  const args = [
    '--no-config',
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
    throw new Error(`yt-dlp exited with code ${exitCode}: ${stderr.slice(-500).trim()}`);
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
  logger.info('[channel-clone yt-dlp] list-videos done', {
    url: canonicalChannelUrl,
    count: metas.length,
  });
  return metas;
}

/** Download a single video at 480p plus auto-captions to the supplied
 *  sandbox directory. Returns sandbox-relative paths the caller will
 *  read back via sandbox.readFileToBuffer. */
export async function downloadVideo(
  sandbox: Sandbox,
  canonicalVideoUrl: string,
  outDir: string,
): Promise<YtDlpDownloadResult> {
  logger.info('[channel-clone yt-dlp] download start', { url: canonicalVideoUrl, outDir });
  // 480p ceiling keeps file size manageable (~15-30 MB for an
  // 11-min explainer). Convert auto-subs to SRT for the cleaner.
  const args = [
    '--no-config',
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
    throw new Error(`yt-dlp exited with code ${exitCode}: ${stderr.slice(-500).trim()}`);
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
