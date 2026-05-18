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
 *   EVAL_STABILITY_RUNS    Optional integer in [1, 5]. When > 1, each
 *                          reference is analyzed that many times in
 *                          sequence and pairwise compareAnalyses diffs
 *                          are written to <slug>-stability.json. Use
 *                          to spot pack-count / scene-count drift
 *                          across re-runs of the same input. Costs
 *                          scale linearly. Defaults to 1.
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
import { compareAnalyses, summarizeDiff, type AnalysisDiff } from '../src/lib/analyzer/compare';
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
// Stability mode — when > 1, each reference is analyzed STABILITY_RUNS
// times in sequence and the pairwise compareAnalyses diffs are written
// to <slug>-stability.json. Used to spot pack-count / scene-count
// drift across re-runs of the same input. Costs scale linearly.
const STABILITY_RUNS = Math.max(1, Math.min(5, Number(process.env.EVAL_STABILITY_RUNS || '1')));

interface PerRefSummary {
  slug: string;
  archetype: string;
  url: string;
  status: 'ok' | 'gemini-error' | 'parse-error' | 'schema-mismatch';
  elapsedMs: number;
  rawLength: number;
  stylePackCount: number | null;
  failureReason: string | null;
  stabilityRun: number; // 1-indexed; 1 for the only run when STABILITY_RUNS=1
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
    stabilityRuns: STABILITY_RUNS,
  });

  const summary: PerRefSummary[] = [];

  for (const ref of targets) {
    const runs: AnalyzedVideo[] = [];
    for (let runIdx = 1; runIdx <= STABILITY_RUNS; runIdx++) {
      const video = await analyzeOneRun({ ref, runIdx, outDir, summary });
      if (video) runs.push(video);
    }

    // Pairwise stability diffs — only emitted when running 2+ analyses
    // of the same input. Adjacent-pair diff (run1 vs run2, run2 vs
    // run3, ...) gives a quick read on whether successive runs are
    // structurally agreeing.
    if (STABILITY_RUNS > 1 && runs.length >= 2) {
      const stabilityReport: Array<{ pair: string; headline: string; diff: AnalysisDiff }> = [];
      for (let i = 0; i < runs.length - 1; i++) {
        const diff = compareAnalyses(runs[i], runs[i + 1]);
        const headline = summarizeDiff(diff);
        stabilityReport.push({ pair: `run${i + 1} vs run${i + 2}`, headline, diff });
        console.info('[eval-deep-analyzer stability]', { slug: ref.slug, pair: `run${i + 1} vs run${i + 2}`, headline });
      }
      writeFileSync(
        join(outDir, `${ref.slug}-stability.json`),
        JSON.stringify(stabilityReport, null, 2),
      );
    }
  }

  writeFileSync(
    join(outDir, 'summary.json'),
    JSON.stringify(
      {
        modelId: MODEL_ID,
        stabilityRuns: STABILITY_RUNS,
        completedAt: new Date().toISOString(),
        references: summary,
      },
      null,
      2,
    ),
  );
  console.info('[eval-deep-analyzer done]', { outDir, summary });
}

/**
 * Run the analyzer once for a given reference, write all artefacts to
 * outDir, and push a PerRefSummary entry. Returns the parsed
 * AnalyzedVideo on success, null on any failure. Filenames carry a
 * `-runN` suffix when STABILITY_RUNS > 1; otherwise they keep the
 * legacy unsuffixed form so single-run output stays compatible with
 * prior tooling.
 */
async function analyzeOneRun({
  ref,
  runIdx,
  outDir,
  summary,
}: {
  ref: Reference;
  runIdx: number;
  outDir: string;
  summary: PerRefSummary[];
}): Promise<AnalyzedVideo | null> {
  const fileSuffix = STABILITY_RUNS > 1 ? `-run${runIdx}` : '';

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
      stabilityRun: runIdx,
    });
    return null;
  }
  const canonical = canonicalYoutubeUrl(videoId);

  const { system, user } = buildAnalyzerPrompt({
    videoTitle: ref.title,
    channelTitle: ref.channel,
    videoUrl: canonical,
  });

  console.info('[eval-deep-analyzer call]', { slug: ref.slug, runIdx, model: MODEL_ID, url: canonical });
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
    console.error('[eval-deep-analyzer gemini-error]', { slug: ref.slug, runIdx, elapsedMs, detail });
    writeFileSync(join(outDir, `${ref.slug}${fileSuffix}-error.txt`), stack);
    summary.push({
      slug: ref.slug,
      archetype: ref.archetype,
      url: canonical,
      status: 'gemini-error',
      elapsedMs,
      rawLength: 0,
      stylePackCount: null,
      failureReason: detail,
      stabilityRun: runIdx,
    });
    return null;
  }
  const elapsedMs = Date.now() - startedAt;
  writeFileSync(join(outDir, `${ref.slug}${fileSuffix}-raw.txt`), raw);
  console.info('[eval-deep-analyzer raw-written]', { slug: ref.slug, runIdx, elapsedMs, rawLength: raw.length });

  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[eval-deep-analyzer parse-error]', { slug: ref.slug, runIdx, detail });
    writeFileSync(join(outDir, `${ref.slug}${fileSuffix}-parse-error.txt`), detail);
    summary.push({
      slug: ref.slug,
      archetype: ref.archetype,
      url: canonical,
      status: 'parse-error',
      elapsedMs,
      rawLength: raw.length,
      stylePackCount: null,
      failureReason: detail,
      stabilityRun: runIdx,
    });
    return null;
  }

  const validation = validateAnalyzedVideo(parsed);
  if (!validation.ok) {
    console.error('[eval-deep-analyzer schema-mismatch]', { slug: ref.slug, runIdx, reason: validation.reason });
    writeFileSync(join(outDir, `${ref.slug}${fileSuffix}-schema-mismatch.json`), JSON.stringify(parsed, null, 2));
    writeFileSync(join(outDir, `${ref.slug}${fileSuffix}-schema-reason.txt`), validation.reason);
    summary.push({
      slug: ref.slug,
      archetype: ref.archetype,
      url: canonical,
      status: 'schema-mismatch',
      elapsedMs,
      rawLength: raw.length,
      stylePackCount: null,
      failureReason: `validateAnalyzedVideo: ${validation.reason}`,
      stabilityRun: runIdx,
    });
    return null;
  }

  const ok: AnalyzedVideo = validation.value;
  writeFileSync(join(outDir, `${ref.slug}${fileSuffix}-parsed.json`), JSON.stringify(ok, null, 2));
  console.info('[eval-deep-analyzer parsed]', {
    slug: ref.slug,
    runIdx,
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
    stabilityRun: runIdx,
  });
  return ok;
}

function resolveScriptDir(): string {
  return resolve(fileURLToPath(import.meta.url), '..');
}

main().catch((err) => {
  console.error('[eval-deep-analyzer fatal]', err);
  process.exit(1);
});
