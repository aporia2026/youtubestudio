/**
 * Probe an audio buffer for its actual playback duration in seconds.
 *
 * Why: the TTS providers (ElevenLabs, Google) report an ESTIMATED
 * duration based on character count, not the real audio length. For
 * ElevenLabs Roger reading a 100-word security script the estimate
 * lands ~2-3 seconds off — enough that the renderer cuts the voiceover
 * off mid-word. This helper bridges the gap by feeding the audio bytes
 * through ffmpeg and parsing the real `Duration:` it prints.
 *
 * Implementation: spawn `ffmpeg -i pipe:0 -f null -`. ffmpeg reads the
 * audio from stdin, decodes the header, prints the duration to stderr,
 * exits. We never need ffprobe (which isn't installed).
 *
 * See `_plans/2026-06-04-shorts-images-must-be-9-16.md` for context —
 * this is one of the issues that surfaced during the same QA pass.
 */
import { spawn } from 'child_process';
import { logger } from './logger';
import { getFfmpegPath } from './ffmpeg-renderer/ffmpeg-bin';

/** Hard cap on how long ffmpeg can run while probing. A short mp3 reads
 *  its header in < 100ms; the cap exists so a malformed buffer can't
 *  hang the voiceover route. */
const PROBE_TIMEOUT_MS = 5000;

/** Parse ffmpeg's `Duration: HH:MM:SS.MS` line out of its stderr. */
export function parseFfmpegDurationFromStderr(stderr: string): number | null {
  // ffmpeg's "Duration: 00:00:39.12, start: ..." — we capture H, M, S.ms.
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Probe an audio buffer (any container ffmpeg can read — mp3, wav, m4a,
 * ogg, etc.) for its actual duration in seconds.
 *
 * Returns `null` when ffmpeg can't read the file or doesn't print a
 * Duration line. The caller should fall back to the TTS estimate in
 * that case — better a slightly-wrong number than no number at all.
 *
 * Never throws — failures log and return null. The cron + voiceover
 * route shouldn't fail just because the duration probe couldn't parse
 * its input.
 */
export async function probeAudioDurationSeconds(buffer: Buffer): Promise<number | null> {
  if (buffer.byteLength === 0) {
    logger.warn('[audio-duration-probe] empty buffer');
    return null;
  }
  const ffmpegPath = getFfmpegPath();
  return new Promise<number | null>((resolve) => {
    let stderr = '';
    let settled = false;
    const settle = (v: number | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const child = spawn(
      ffmpegPath,
      // -hide_banner trims the ffmpeg version preamble. -i pipe:0 reads
      // from stdin. -f null - writes nothing — we only want the
      // metadata ffmpeg prints to stderr while opening the input.
      ['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-'],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      logger.warn('[audio-duration-probe] timeout', { ms: PROBE_TIMEOUT_MS });
      settle(null);
    }, PROBE_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.warn('[audio-duration-probe] spawn errored', {
        detail: err instanceof Error ? err.message : String(err),
      });
      settle(null);
    });

    child.on('close', () => {
      clearTimeout(timeout);
      const seconds = parseFfmpegDurationFromStderr(stderr);
      if (seconds === null) {
        logger.warn('[audio-duration-probe] could not parse Duration', {
          stderr_preview: stderr.slice(0, 240),
        });
        settle(null);
        return;
      }
      logger.info('[audio-duration-probe] ok', { seconds });
      settle(seconds);
    });

    // Pipe the buffer in, then close stdin so ffmpeg exits.
    child.stdin.on('error', () => {
      // EPIPE can fire when ffmpeg closes stdin early on a bad header.
      // Ignored — the 'close' handler still resolves with whatever it
      // managed to parse.
    });
    child.stdin.end(buffer);
  });
}
