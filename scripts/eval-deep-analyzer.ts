/**
 * Driver for the deep YouTube video analyzer fidelity eval (Phase 0
 * of `_plans/2026-05-18-youtube-deep-analyzer.md`). Calls the same
 * Gemini wrapper the live `/analyze` route uses — bypasses the API
 * route only so we don't have to fabricate a session — and writes
 * raw + parsed analyzer output to `_plans/eval-runs/<run>/` for
 * scoring against the golden tables in
 * `_plans/2026-05-18-youtube-deep-analyzer-eval.md`.
 *
 * Usage:
 *   npm run eval:deep-analyzer
 *
 * Inputs (env or .env.local — `tsx --env-file-if-exists=.env.local`
 * is wired in the npm script):
 *
 *   EVAL_MODEL_ID          Optional override for the analyzer model.
 *                          Defaults to `kie-gemini-2.5-pro` because
 *                          the local env has `KIE_API_KEY` set but
 *                          `GOOGLE_AI_API_KEY` empty. Pass
 *                          `gemini-2.5-pro` when running against an
 *                          env with a direct Google key.
 *
 *   EVAL_ONLY              Optional slug filter. When set to one of
 *                          `a-veritasium-rainbow`,
 *                          `b-casey-make-it-count`,
 *                          `c-kurzgesagt-the-egg`, only that single
 *                          reference is analyzed. Useful when iter-
 *                          ating after a prompt change to avoid re-
 *                          spending on the references that already
 *                          passed.
 *
 * Output: one subdirectory per run under `_plans/eval-runs/` named
 * after the current ISO date, containing per-reference `*-raw.txt`,
 * `*-parsed.json` (when the JSON parsed and matched the schema), or
 * `*-error.txt` / `*-parse-error.txt` / `*-schema-mismatch.json`
 * (when not). A final `summary.json` captures the per-reference
 * elapsed time, model used, style-pack count, and any failure
 * reason.
 *
 * Cost: one full run with the three locked anchors is roughly
 * $1.50-$2.00 at current Kie.ai Gemini 2.5 Pro pricing (~36.5 min
 * of input video, 8-30K output tokens per video). Re-runs after
 * prompt iteration are the same cost. The eval doc has the cost
 * note next to the ship gate.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeYouTubeVideo } from '../src/lib/ai';
import { buildAnalyzerPrompt } from '../src/lib/analyzer/prompt';
import { validateAnalyzedVideo, type AnalyzedVideo } from '../src/lib/analyzer/types';
import { canonicalYoutubeUrl, extractYoutubeVideoId } from '../src/lib/analyzer/url';
import { parseLlmJson } from '../src/lib/parse-llm-json';

interface Reference {
  slug: string;
  url: string;
  title: string;
  channel: string;
  archetype: string;
}

const REFERENCES: readonly Reference[] = [
  {
    slug: 'a-veritasium-rainbow',
    url: 'https://www.youtube.com/watch?v=24GfgNtnjXc',
    title: 'Why No Two People See the Same Rainbow',
    channel: 'Veritasium',
    archetype: 'Explainer with cinematic B-roll',
  },
  {
    slug: 'b-casey-make-it-count',
    url: 'https://www.youtube.com/watch?v=WxfZkMm3wcg',
    title: 'Make It Count',
    channel: 'Casey Neistat',
    archetype: 'Fast-cut handheld vlog',
  },
  {
    slug: 'c-kurzgesagt-the-egg',
    url: 'https://www.youtube.com/watch?v=h6fcK_fRYaI',
    title: 'The Egg - A Short Story',
    channel: 'Kurzgesagt – In a Nutshell',
    archetype: 'Animated explainer',
  },
];

const MODEL_ID = process.env.EVAL_MODEL_ID?.trim() || 'kie-gemini-2.5-pro';
const ONLY_SLUG = process.env.EVAL_ONLY?.trim() || null;

interface PerRefSummary {
  slug: string;
  archetype: string;
  url: string;
  status: 'ok' | 'gemini-error' | 'parse-error' | 'schema-mismatch';
  elapsedMs: number;
  rawLength: number;
  stylePackCount: number | null;
  failureReason: string | null;
}

async function main(): Promise<void> {
  const scriptDir = resolveScriptDir();
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(scriptDir, '..', '_plans', 'eval-runs', `2026-05-18-deep-analyzer__${runStamp}`);
  mkdirSync(outDir, { recursive: true });

  const targets = ONLY_SLUG ? REFERENCES.filter((r) => r.slug === ONLY_SLUG) : REFERENCES;
  if (ONLY_SLUG && targets.length === 0) {
    console.error('[eval-deep-analyzer fatal] EVAL_ONLY did not match any reference slug', {
      requested: ONLY_SLUG,
      available: REFERENCES.map((r) => r.slug),
    });
    process.exit(2);
  }

  console.info('[eval-deep-analyzer start]', {
    modelId: MODEL_ID,
    outDir,
    targets: targets.map((t) => t.slug),
  });

  const summary: PerRefSummary[] = [];

  for (const ref of targets) {
    const videoId = extractYoutubeVideoId(ref.url);
    if (!videoId) {
      console.error('[eval-deep-analyzer bad-url]', { slug: ref.slug, url: ref.url });
      summary.push({
        slug: ref.slug,
        archetype: ref.archetype,
        url: ref.url,
        status: 'gemini-error',
        elapsedMs: 0,
        rawLength: 0,
        stylePackCount: null,
        failureReason: 'extractYoutubeVideoId returned null',
      });
      continue;
    }
    const canonical = canonicalYoutubeUrl(videoId);

    const { system, user } = buildAnalyzerPrompt({
      videoTitle: ref.title,
      channelTitle: ref.channel,
      videoUrl: canonical,
    });

    console.info('[eval-deep-analyzer call]', { slug: ref.slug, model: MODEL_ID, url: canonical });
    const startedAt = Date.now();

    let raw: string;
    try {
      raw = await analyzeYouTubeVideo({
        modelId: MODEL_ID,
        youtubeUrl: canonical,
        prompt: user,
        systemPrompt: system,
        maxTokens: 32_000,
        temperature: 0.3,
      });
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      const detail = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack ?? detail : detail;
      console.error('[eval-deep-analyzer gemini-error]', { slug: ref.slug, elapsedMs, detail });
      writeFileSync(join(outDir, `${ref.slug}-error.txt`), stack);
      summary.push({
        slug: ref.slug,
        archetype: ref.archetype,
        url: canonical,
        status: 'gemini-error',
        elapsedMs,
        rawLength: 0,
        stylePackCount: null,
        failureReason: detail,
      });
      continue;
    }
    const elapsedMs = Date.now() - startedAt;
    writeFileSync(join(outDir, `${ref.slug}-raw.txt`), raw);
    console.info('[eval-deep-analyzer raw-written]', {
      slug: ref.slug,
      elapsedMs,
      rawLength: raw.length,
    });

    let parsed: unknown;
    try {
      parsed = parseLlmJson(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[eval-deep-analyzer parse-error]', { slug: ref.slug, detail });
      writeFileSync(join(outDir, `${ref.slug}-parse-error.txt`), detail);
      summary.push({
        slug: ref.slug,
        archetype: ref.archetype,
        url: canonical,
        status: 'parse-error',
        elapsedMs,
        rawLength: raw.length,
        stylePackCount: null,
        failureReason: detail,
      });
      continue;
    }

    const validation = validateAnalyzedVideo(parsed);
    if (!validation.ok) {
      console.error('[eval-deep-analyzer schema-mismatch]', { slug: ref.slug, reason: validation.reason });
      writeFileSync(join(outDir, `${ref.slug}-schema-mismatch.json`), JSON.stringify(parsed, null, 2));
      writeFileSync(join(outDir, `${ref.slug}-schema-reason.txt`), validation.reason);
      summary.push({
        slug: ref.slug,
        archetype: ref.archetype,
        url: canonical,
        status: 'schema-mismatch',
        elapsedMs,
        rawLength: raw.length,
        stylePackCount: null,
        failureReason: `validateAnalyzedVideo: ${validation.reason}`,
      });
      continue;
    }

    const ok: AnalyzedVideo = validation.value;
    writeFileSync(join(outDir, `${ref.slug}-parsed.json`), JSON.stringify(ok, null, 2));
    console.info('[eval-deep-analyzer parsed]', {
      slug: ref.slug,
      stylePacks: ok.style_packs.length,
      sceneCount: ok.scenes.length,
    });
    summary.push({
      slug: ref.slug,
      archetype: ref.archetype,
      url: canonical,
      status: 'ok',
      elapsedMs,
      rawLength: raw.length,
      stylePackCount: ok.style_packs.length,
      failureReason: null,
    });
  }

  writeFileSync(
    join(outDir, 'summary.json'),
    JSON.stringify(
      { modelId: MODEL_ID, completedAt: new Date().toISOString(), references: summary },
      null,
      2,
    ),
  );
  console.info('[eval-deep-analyzer done]', { outDir, summary });
}

function resolveScriptDir(): string {
  return resolve(fileURLToPath(import.meta.url), '..');
}

main().catch((err) => {
  console.error('[eval-deep-analyzer fatal]', err);
  process.exit(1);
});
