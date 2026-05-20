/**
 * Resolve the path to the platform's ffmpeg / ffprobe binary.
 *
 * Uses `@ffmpeg-installer/ffmpeg` which ships full ffmpeg binaries
 * per-platform. Remotion's bundled ffmpeg is a stripped-down build
 * (no zoompan, no most filters) — fine for Remotion's own use but
 * insufficient for the rich filter graphs the FFmpeg-native renderer
 * needs. Adding a second binary trades ~50 MB of node_modules for a
 * working filter pipeline.
 *
 * Phase 1 of `_plans/2026-05-20-ffmpeg-native-renderer.md`.
 *
 * Vercel deployment note: function size limits matter. The ffmpeg
 * binary is ~50 MB unzipped per-platform; Vercel's bundler only
 * ships the linux build, so the deployed function pays ~50 MB. With
 * Enterprise plan headroom that's still safely inside the size cap.
 * Reviewed in Phase 7 of the plan when cutover lands.
 */
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

let cachedFfmpeg: string | null = null;

export function getFfmpegPath(): string {
  if (cachedFfmpeg) return cachedFfmpeg;
  cachedFfmpeg = ffmpegInstaller.path;
  return cachedFfmpeg;
}

/**
 * Resolve ffprobe — needed to introspect intermediate scene MP4s
 * during testing. Phase 2 will use it for the playback-rate
 * calculation when fitting a clip to a scene. v1 doesn't ship a
 * separate ffprobe installer; falls back to the same binary's
 * sibling `ffprobe` (most installers ship both side-by-side).
 */
export function getFfprobePath(): string {
  // @ffmpeg-installer/ffmpeg ships only ffmpeg; install
  // @ffprobe-installer/ffprobe alongside in Phase 2 when we need it.
  // Until then this throws to make the missing dependency loud rather
  // than hiding behind a runtime error in obscure paths.
  throw new Error(
    'ffprobe not installed yet. Add @ffprobe-installer/ffprobe in Phase 2 ' +
    'when clip-duration introspection is needed.',
  );
}
