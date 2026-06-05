/**
 * yt-dlp subprocess wrapper for the channel-clone intake.
 *
 * yt-dlp is the only reliable way to fetch sample videos + auto-
 * captions from a competitor channel without paying for an API. It
 * doesn't ship with Vercel functions and downloading a 480p 11-min
 * video can take 20-60s — well over the function-time budget for a
 * single tick. Intake therefore runs LOCAL ONLY: in dev mode on the
 * developer's machine (Node child process), guarded with a hard
 * throw in production.
 *
 * Security (rule 13):
 *   - URLs MUST be pre-validated by `validateYoutubeUrl` upstream.
 *   - Spawned via `child_process.spawn` with `shell: false` (default
 *     for argv-array form) so a hostile URL can't inject shell
 *     metacharacters even if validation is bypassed.
 *   - Output paths use the per-job temp directory provided by the
 *     caller; we never let yt-dlp resolve paths from user input.
 *   - We pass `--no-config` so the dev's personal yt-dlp config
 *     can't influence behaviour (e.g. silent post-processors).
 *   - Stderr is captured for logging but never echoed to the user.
 *
 * Provenance: the binary used is whichever `yt-dlp` resolves on the
 * dev's PATH, or — when missing — `python -m yt_dlp` against the
 * system `python`. The latter is the most common install path on
 * Windows after `pip install yt-dlp`.
 */

import { spawn } from 'child_process';
import { logger } from '@/lib/logger';

/** Hard timeout for the yt-dlp process. 5 min is generous for a
 *  720p 11-min download under sane bandwidth; longer than this and
 *  something's wrong. */
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
  /** Absolute path to the merged video file on disk. */
  videoLocalPath: string;
  /** Absolute path to the cleaned transcript file on disk (SRT),
   *  or null when no auto-captions were available. */
  transcriptLocalPath: string | null;
}

/** Throws when the calling environment is not a dev Node process.
 *  Intake stages call this at the top of their handler so a deploy
 *  surfaces a clean error instead of trying to run a binary that
 *  isn't there. */
export function assertIntakeAvailable(): void {
  if (process.env.NODE_ENV === 'production' && !process.env.CHANNEL_CLONE_ALLOW_PROD_INTAKE) {
    throw new Error(
      'channel-clone intake is dev-only: yt-dlp + ffmpeg require local subprocess access. Set CHANNEL_CLONE_ALLOW_PROD_INTAKE=1 only if you have provisioned the binaries in the runtime.',
    );
  }
}

/** Best-effort detect of yt-dlp invocation. Tries `yt-dlp` on PATH;
 *  if missing, falls back to `python -m yt_dlp` which is how it's
 *  installed via pip. Cached after first probe. */
let cachedInvoker: { command: string; baseArgs: string[] } | null = null;
async function detectYtDlpInvoker(): Promise<{ command: string; baseArgs: string[] }> {
  if (cachedInvoker) return cachedInvoker;
  // Probe `yt-dlp --version` first.
  const ytDlpDirect = await tryProbe('yt-dlp', ['--version']);
  if (ytDlpDirect) {
    cachedInvoker = { command: 'yt-dlp', baseArgs: [] };
    return cachedInvoker;
  }
  // Fall back to `python -m yt_dlp --version`.
  const pythonModule = await tryProbe('python', ['-m', 'yt_dlp', '--version']);
  if (pythonModule) {
    cachedInvoker = { command: 'python', baseArgs: ['-m', 'yt_dlp'] };
    return cachedInvoker;
  }
  throw new Error(
    'yt-dlp not found. Install via `pip install yt-dlp` (the Python-module path is auto-detected) or add `yt-dlp` to PATH.',
  );
}

async function tryProbe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const proc = spawn(cmd, args, { stdio: 'ignore', timeout: 5000 });
      proc.once('error', () => resolve(false));
      proc.once('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** Spawn yt-dlp, return when the process exits. Buffers stdout+stderr
 *  in memory; for the metadata probe that's bounded (a single JSON
 *  blob), for the download path stdout is `-q` so it stays small. */
function runYtDlp(args: string[], invoker: { command: string; baseArgs: string[] }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const fullArgs = [...invoker.baseArgs, ...args];
    const proc = spawn(invoker.command, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: YT_DLP_TIMEOUT_MS,
      // Explicit: never spawn through a shell. Default for argv-array
      // form, but stated for the audit trail.
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    proc.once('error', (err) => reject(err));
    proc.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(-500).trim()}`));
      }
    });
  });
}

/** Fetch the latest N long-form videos from a channel's URL and
 *  return their metadata (id, url, title, duration). Doesn't
 *  download the videos themselves — that's a second pass. */
export async function listChannelVideos(
  canonicalChannelUrl: string,
  options: { maxVideos: number } = { maxVideos: 5 },
): Promise<YtDlpVideoMetadata[]> {
  assertIntakeAvailable();
  const invoker = await detectYtDlpInvoker();
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
  const { stdout } = await runYtDlp(args, invoker);
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

/** Download a single video at 480p plus auto-captions to the
 *  supplied directory. Returns absolute paths on success. */
export async function downloadVideo(
  canonicalVideoUrl: string,
  outDir: string,
): Promise<YtDlpDownloadResult> {
  assertIntakeAvailable();
  const invoker = await detectYtDlpInvoker();
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
  const { stdout } = await runYtDlp(args, invoker);
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
  const fs = await import('fs/promises');
  let transcriptLocalPath: string | null = null;
  for (const candidate of transcriptCandidates) {
    try {
      await fs.access(candidate);
      transcriptLocalPath = candidate;
      break;
    } catch {
      // not present — try the next
    }
  }
  logger.info('[channel-clone yt-dlp] download done', {
    videoId: id,
    videoLocalPath: filepath,
    transcriptLocalPath,
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
    videoLocalPath: filepath,
    transcriptLocalPath,
  };
}
