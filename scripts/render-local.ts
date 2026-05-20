/**
 * Local Remotion render — bypass Vercel entirely.
 *
 * Why this exists: when the Vercel-hosted render produces broken
 * output (stills-only despite valid videoUrls in the config), running
 * Remotion locally on the user's machine is the definitive test. If
 * the local render works, the bug is Vercel-specific (memory, /tmp,
 * function timeout, network). If the local render reproduces the bug,
 * the bug is in our composition code and is fixable.
 *
 * Usage:
 *   1. Open the production-doc page in your browser, click Render to MP4.
 *      Even if the render produces a broken MP4, the diagnostic log
 *      stashed the config on `window.__lastRenderConfig`.
 *   2. In DevTools console:
 *        copy(JSON.stringify(window.__lastRenderConfig, null, 2))
 *      Paste the result into a local file:
 *        scripts/.last-render-config.json
 *   3. Run from project root:
 *        npx tsx scripts/render-local.ts
 *      OR specify a different config file:
 *        npx tsx scripts/render-local.ts path/to/config.json
 *
 * Output:
 *   - out/render-local-<timestamp>.mp4
 *
 * Requirements:
 *   - Node 18+
 *   - ffmpeg installed on PATH (Remotion handles this internally but
 *     the binaries it ships sometimes have issues on Windows; install
 *     ffmpeg system-wide if you hit a codec error)
 *   - All env vars from .env.local for any media URL that needs auth
 *     (voiceover proxy + broll proxy require POSTGRES_URL_NON_POOLING
 *     so the proxy routes can look up R2 keys)
 *
 * 2026-05-20: written during the render-config-drop debugging session
 * after Vercel-side fixes (4902e9b, cbb7b33) didn't restore animations.
 */
import path from 'path';
import fs from 'fs/promises';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { remotionWebpackOverride } from '../src/lib/remotion-bundler';

const DEFAULT_CONFIG_PATH = path.join('scripts', '.last-render-config.json');

async function main() {
  const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;
  const absoluteConfigPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);

  process.stdout.write(`Reading config: ${path.relative(process.cwd(), absoluteConfigPath)}\n`);
  let configRaw: string;
  try {
    configRaw = await fs.readFile(absoluteConfigPath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `Could not read config file at ${absoluteConfigPath}.\n` +
      `Export it from DevTools:\n` +
      `  copy(JSON.stringify(window.__lastRenderConfig, null, 2))\n` +
      `Then save to ${DEFAULT_CONFIG_PATH}.\n` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  let config: unknown;
  try {
    config = JSON.parse(configRaw);
  } catch (err) {
    process.stderr.write(`Config file is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  if (!config || typeof config !== 'object' || !Array.isArray((config as { shots?: unknown }).shots)) {
    process.stderr.write(`Config file is missing 'shots' array.\n`);
    process.exit(1);
  }
  const shotCount = (config as { shots: unknown[] }).shots.length;
  process.stdout.write(`Config has ${shotCount} shots.\n`);

  // ─── Absolutize relative URLs ───────────────────────────────────────────
  //
  // The production-doc page captures window.__lastRenderConfig AFTER the
  // proxy-URL rewrite, so per-shot videoUrls look like
  // `/api/broll/<id>/video` and voiceoverUrl like
  // `/api/voiceovers/<uuid>/audio`. Remotion can't fetch a relative path
  // — it has no origin to resolve against. Rewrite to localhost so the
  // local dev server (which YOU need to have running on port 3000)
  // serves the proxy and voiceover audio.
  //
  // Override the origin via LOCAL_RENDER_BASE_URL env var if your dev
  // server lives elsewhere.
  const baseUrl = process.env.LOCAL_RENDER_BASE_URL ?? 'http://localhost:3000';
  function absolutize(url: string | undefined): string | undefined {
    if (!url) return url;
    if (url.startsWith('/')) return baseUrl.replace(/\/$/, '') + url;
    return url;
  }
  type Shot = { videoUrl?: string; imageUrl?: string };
  type Cfg = { voiceoverUrl?: string; musicUrl?: string; shots: Shot[] };
  const cfg = config as Cfg;
  let rewriteCount = 0;
  if (cfg.voiceoverUrl?.startsWith('/')) {
    cfg.voiceoverUrl = absolutize(cfg.voiceoverUrl);
    rewriteCount++;
  }
  if (cfg.musicUrl?.startsWith('/')) {
    cfg.musicUrl = absolutize(cfg.musicUrl);
    rewriteCount++;
  }
  for (const shot of cfg.shots) {
    if (shot.videoUrl?.startsWith('/')) {
      shot.videoUrl = absolutize(shot.videoUrl);
      rewriteCount++;
    }
    if (shot.imageUrl?.startsWith('/')) {
      shot.imageUrl = absolutize(shot.imageUrl);
      rewriteCount++;
    }
  }
  process.stdout.write(`Absolutized ${rewriteCount} relative URLs against ${baseUrl}.\n`);
  process.stdout.write(`Make sure 'npm run dev' is running on that origin BEFORE continuing.\n`);

  // ─── Bundle ──────────────────────────────────────────────────────────────
  process.stdout.write(`Bundling Remotion composition…\n`);
  const rootEntry = path.join(process.cwd(), 'src', 'remotion', 'Root.tsx');
  const bundled = await bundle({
    entryPoint: rootEntry,
    webpackOverride: remotionWebpackOverride,
    onProgress: (p) => {
      if (Math.floor(p) % 25 === 0) {
        process.stdout.write(`  bundle ${Math.floor(p)}%\n`);
      }
    },
  });
  process.stdout.write(`  bundle complete: ${bundled}\n`);

  // ─── Select composition ──────────────────────────────────────────────────
  process.stdout.write(`Selecting composition YouTubeVideo…\n`);
  const composition = await selectComposition({
    serveUrl: bundled,
    id: 'YouTubeVideo',
    inputProps: { config },
  });
  process.stdout.write(`  composition: ${composition.width}\xd7${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} frames\n`);

  // ─── Render ─────────────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'out');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `render-local-${timestamp}.mp4`);
  process.stdout.write(`Rendering to ${path.relative(process.cwd(), outPath)}…\n`);

  let lastPct = -1;
  let browserErrorCount = 0;
  const browserErrors: string[] = [];

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: 'h264',
    outputLocation: outPath,
    inputProps: { config },
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        process.stdout.write(`  render ${pct}%\n`);
        lastPct = pct;
      }
    },
    onBrowserLog: (log) => {
      if (log.type === 'error' || log.type === 'warning') {
        browserErrorCount++;
        if (browserErrors.length < 100) {
          browserErrors.push(`[${log.type}] ${log.text}`.slice(0, 600));
        }
      }
    },
  });

  // ─── Report ─────────────────────────────────────────────────────────────
  const stats = await fs.stat(outPath);
  const mb = (stats.size / 1024 / 1024).toFixed(1);
  process.stdout.write(`\nRender complete.\n`);
  process.stdout.write(`  Output:        ${path.relative(process.cwd(), outPath)}\n`);
  process.stdout.write(`  Size:          ${mb} MB\n`);
  process.stdout.write(`  Browser errors: ${browserErrorCount}\n`);
  if (browserErrorCount > 0) {
    const sample = browserErrors.slice(0, 5);
    process.stdout.write(`  First few browser errors (sample of ${sample.length}):\n`);
    for (const line of sample) {
      process.stdout.write(`    - ${line}\n`);
    }
    if (browserErrorCount > 5) {
      process.stdout.write(`    ... (${browserErrorCount - 5} more — see Remotion log for full output)\n`);
    }
  }
  process.stdout.write(`\nOpen the MP4 and check:\n`);
  process.stdout.write(`  - Do video clips play (vs. stills only)?\n`);
  process.stdout.write(`  - Are there fades between shots (should not, if scene_fade_enabled was false)?\n`);
  process.stdout.write(`  - Does file size look like a video-rich render (~5–10 Mbps → ~300–600 MB for 8 min)\n`);
  process.stdout.write(`    or a stills-only render (~3 Mbps → ~150–200 MB)?\n`);
}

main().catch((err) => {
  process.stderr.write(`Local render failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`Stack:\n${err.stack}\n`);
  }
  process.exit(1);
});
