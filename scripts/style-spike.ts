/**
 * Phase 0 — Doodle style blind-rank spike runner.
 *
 * Plan: `_plans/2026-05-21-phase-0-spike-prompts.md`.
 *
 * What this does:
 *   1. Reads 5 doodle reference images from
 *      `public/style-refs/Doodle-explainer/` and uploads them to the
 *      R2 images bucket. Returns the long-lived presigned GET URLs
 *      so Kie.ai workers can fetch them (R2 public URL preferred when
 *      configured; otherwise 7-day presigned GET).
 *   2. For each of the 10 curated scene prompts × 4 cloud i2i models =
 *      40 generations, submits a Kie.ai task, polls until success,
 *      downloads the result, and saves it to disk under
 *      `_plans/2026-05-21-phase-0-spike-results/outputs/<model>/<id>.jpg`.
 *   3. Writes a metadata JSON with the prompt, model used, ref URLs,
 *      and timing for every cell so the result is auditable.
 *   4. Renders an HTML grid for blind ranking — columns anonymised as
 *      A/B/C/D, click to enlarge, "Reveal" button uncovers the mapping
 *      after the user has made their picks.
 *
 * Idempotency: skips any (model, prompt) cell whose output file already
 * exists on disk. So a partial run can be resumed by re-running the
 * script without re-spending on completed cells.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/style-spike.ts
 *
 * Cost: ~$2 for the full 40-cell grid at typical Kie i2i pricing.
 * Tail-spend control: a single failed cell logs and continues; the
 * script never re-submits a cell whose output already exists on disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildImageRefKey,
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '../src/lib/r2';
import { createKieTask, pollKieResult } from '../src/lib/kie-poll';

// ─── Configuration ──────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REFS_DIR = path.join(PROJECT_ROOT, 'public', 'style-refs', 'Doodle-explainer');
const RESULTS_DIR = path.join(PROJECT_ROOT, '_plans', '2026-05-21-phase-0-spike-results');
const OUTPUTS_DIR = path.join(RESULTS_DIR, 'outputs');
const METADATA_PATH = path.join(RESULTS_DIR, 'metadata.json');
const GRID_PATH = path.join(RESULTS_DIR, 'grid.html');

// Ordered: position 0 is the strongest anchor. Used by Ideogram Remix
// (single ref only) and as the lead image for all other models.
const REF_FILENAMES = [
  'stick-figure-magnifying-glass-phone.png',
  'stick-figure-hacker-laptop.png',
  'stick-figure-tracked-by-location.png',
  'stick-figure-hacker-deceives-guard.png',
  'stick-figure-soldiers-running.png',
] as const;

interface SpikePrompt {
  id: string;
  label: string;
  prompt: string;
}

// Curated from the cybersecurity production doc. See
// `_plans/2026-05-21-phase-0-spike-prompts.md` for the rationale on
// each one and why these 10 span the style's failure modes.
const PROMPTS: readonly SpikePrompt[] = [
  {
    id: 'p01',
    label: 'Character study, emotion',
    prompt: 'Close-up of a stick figure with a curious face gently pressing a small button labeled TEST, followed by a huge red warning burst exploding outward; figure leans back in alarm.',
  },
  {
    id: 'p02',
    label: 'Workstation + abstract prop',
    prompt: 'A stick figure operator at a desk looking at a green-text terminal window; beside them a labeled box "FINGERD" splits open and a dictionary of common passwords floats upward.',
  },
  {
    id: 'p03',
    label: 'Two figures, manipulation',
    prompt: 'Two stick figures: one in a sneaky pose handing a fake paper message to the other who sits at an old computer; arrows lead from the message to the second figure\'s head.',
  },
  {
    id: 'p04',
    label: 'Wide chaos infographic',
    prompt: 'Wide scene: a row of computer terminals bent over with smoke puffs and red overload symbols; a giant "$10 MILLION" cleanup bill rising in the center; an alarm bell ringing above a sleeping internet globe just waking up with wide eyes.',
  },
  {
    id: 'p05',
    label: 'Geopolitical world map',
    prompt: 'A wide simple world map with California on the left and a country on the right, each with a teenage stick figure at a computer; bright intrusion lines connect both into a central US military network shield with a trophy floating above it.',
  },
  {
    id: 'p06',
    label: 'Industrial scene with cartoon worm',
    // Rephrased 2026-05-21 — the original "centrifuges" + "1100 Hz crash"
    // tripped Kie's content filter on Flux 2 Pro and timed out GPT Image 2.
    // Same compositional test (mechanical machinery + cartoon worm + warning
    // text) with neutral vocabulary.
    prompt: 'Wide industrial scene: tall spinning machines in a factory, some breaking apart with red sparks; a control panel beside them being pierced by a cartoon computer worm character; a small "OVERLOAD" warning sign flashing red.',
  },
  {
    id: 'p07',
    label: 'Split-screen emotional + technical',
    prompt: 'Split screen — on the left: a sad hospital waiting area with a patient on a stretcher, distressed medical staff, a ticking clock; on the right: a globe surrounded by laptops receiving bright update arrows from above.',
  },
  {
    id: 'p08',
    label: 'Big-number motion-graphics',
    prompt: 'Infographic: a computer monitor at center showing a red skull ransomware warning; bright infection lines spreading across a simple world map to many countries; counters reading "200,000 MACHINES" and "150 COUNTRIES"; a giant "$4 BILLION" burst on the right.',
  },
  {
    id: 'p09',
    label: 'Symbolic supply chain',
    prompt: 'Symbolic scene: a long supply chain made of linked software boxes, trucks, ships, and office servers snapping apart in the middle; behind a fake ransom note a hidden military-style figure peers out with a sly grin.',
  },
  {
    id: 'p10',
    label: 'Viewer-facing finale',
    prompt: 'Closing scene: a single stick figure viewer at center with a red target reticle hovering over their head; three large safety icons in the foreground — a clockwise UPDATE arrow, a BACKUP cloud, and a QUESTION-MARK EMAIL.',
  },
];

interface ModelSpec {
  /** Folder name under outputs/. */
  slug: string;
  /** Human label for the grid reveal section. */
  label: string;
  /** Exact Kie model string per docs.kie.ai 2026-05-21 verification. */
  kieModel: string;
  /** Field name that carries the array (or single) reference URL. */
  refsMode: 'input_urls' | 'image_input' | 'image_url';
  /** Max refs this model accepts. Ideogram Remix = 1; others = 8. */
  maxRefs: number;
  /** Per-model input field overrides — these vary by Kie model family
   *  and were verified one-by-one on docs.kie.ai. */
  extraInput: Record<string, unknown>;
}

const MODELS: readonly ModelSpec[] = [
  {
    slug: 'flux2-pro-i2i',
    label: 'Flux 2 Pro i2i',
    kieModel: 'flux-2/pro-image-to-image',
    refsMode: 'input_urls',
    maxRefs: 8,
    extraInput: { aspect_ratio: '16:9', resolution: '1K' },
  },
  {
    slug: 'gpt-image-2-i2i',
    label: 'GPT Image 2 i2i',
    kieModel: 'gpt-image-2-image-to-image',
    refsMode: 'input_urls',
    maxRefs: 16,
    extraInput: { aspect_ratio: '16:9', resolution: '1K' },
  },
  {
    slug: 'nano-banana-pro-i2i',
    label: 'NanoBanana Pro',
    kieModel: 'nano-banana-pro',
    refsMode: 'image_input',
    maxRefs: 8,
    // Minimal-only: the docs list `output_format` and `resolution` as
    // accepted but Kie's NanoBanana endpoint actually 500s when either
    // is sent (verified empirically 2026-05-21 via
    // scripts/style-spike-debug.ts). aspect_ratio alone works fine.
    extraInput: { aspect_ratio: '16:9' },
  },
  // Ideogram v3 Remix removed 2026-05-21 — taskId returns successfully
  // but polling fails with "internal error, please try again later" on
  // every call regardless of payload (verified with minimal {prompt,
  // image_url}). Kie-side processing outage today. Even if it worked,
  // single-ref-only made it a weak fit for the 5–8 ref system.
  // Re-add when Kie's Ideogram pipeline recovers, OR consider
  // ideogram/v3-edit / character-reference as alternative endpoints.
];

// ─── Types for metadata ─────────────────────────────────────────────────

interface CellResult {
  promptId: string;
  modelSlug: string;
  status: 'success' | 'failure' | 'skipped-cached';
  outputPath?: string;
  durationMs?: number;
  errorMessage?: string;
  kieTaskId?: string;
}

interface RunMetadata {
  startedAt: string;
  finishedAt?: string;
  refUrls: string[];
  prompts: readonly SpikePrompt[];
  models: readonly { slug: string; label: string; kieModel: string }[];
  cells: CellResult[];
}

// ─── R2 upload of refs ──────────────────────────────────────────────────

/**
 * Upload all 5 refs to R2 and return long-lived URLs Kie can fetch.
 * Skips upload when the public URL is already configured for the
 * bucket (R2_IMAGES_PUBLIC_URL set) — in that case we just compute
 * the public path. Otherwise we use a 7-day presigned GET, which is
 * the default of `getDownloadUrlForBucket` and well past any Kie
 * queue duration.
 */
async function uploadRefsToR2(): Promise<string[]> {
  const bucket = getImagesBucket();
  const urls: string[] = [];

  for (let i = 0; i < REF_FILENAMES.length; i++) {
    const filename = REF_FILENAMES[i];
    const localPath = path.join(REFS_DIR, filename);
    if (!fs.existsSync(localPath)) {
      throw new Error(`Missing ref image: ${localPath}`);
    }
    const buffer = fs.readFileSync(localPath);
    const r2Key = buildImageRefKey('spike-doodle-explainer', filename);
    process.stdout.write(`  [${i + 1}/${REF_FILENAMES.length}] uploading ${filename} → ${r2Key} ... `);
    await uploadToBucket(bucket, r2Key, buffer, 'image/png');
    const url = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
    urls.push(url);
    console.log('ok');
  }
  return urls;
}

// ─── Per-model input shape ──────────────────────────────────────────────

function buildI2IInput(model: ModelSpec, prompt: string, refUrls: string[]): Record<string, unknown> {
  const refs = refUrls.slice(0, model.maxRefs);
  const base: Record<string, unknown> = { prompt, ...model.extraInput };
  if (model.refsMode === 'image_url') {
    // Single-ref models — Ideogram Remix takes one URL, not an array.
    base.image_url = refs[0];
  } else {
    base[model.refsMode] = refs;
  }
  return base;
}

// ─── One cell: submit, poll, download, save ─────────────────────────────

async function generateOne(
  apiKey: string,
  model: ModelSpec,
  prompt: SpikePrompt,
  refUrls: string[],
): Promise<CellResult> {
  const outDir = path.join(OUTPUTS_DIR, model.slug);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${prompt.id}.jpg`);

  // Idempotency: a completed cell stays completed across re-runs.
  if (fs.existsSync(outPath)) {
    return { promptId: prompt.id, modelSlug: model.slug, status: 'skipped-cached', outputPath: outPath };
  }

  const started = Date.now();
  try {
    const input = buildI2IInput(model, prompt.prompt, refUrls);
    const taskId = await createKieTask(apiKey, model.kieModel, input);
    const resultUrl = await pollKieResult(taskId, apiKey);

    // Download the result bytes and persist them locally so the grid
    // doesn't depend on Kie URLs continuing to resolve.
    const res = await fetch(resultUrl);
    if (!res.ok) throw new Error(`Result download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outPath, buffer);

    return {
      promptId: prompt.id,
      modelSlug: model.slug,
      status: 'success',
      outputPath: outPath,
      durationMs: Date.now() - started,
      kieTaskId: taskId,
    };
  } catch (err) {
    return {
      promptId: prompt.id,
      modelSlug: model.slug,
      status: 'failure',
      durationMs: Date.now() - started,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Blind-rank HTML grid ───────────────────────────────────────────────

function renderGridHtml(meta: RunMetadata): string {
  // Stable A/B/C/D mapping to model slugs. Randomized on every render
  // so the spreadsheet from one run doesn't leak the mapping into a
  // later re-render of the same dataset. The reveal table at the
  // bottom of the page surfaces the mapping on demand.
  const shuffled = [...meta.models].sort(() => Math.random() - 0.5);
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const slugToLetter = new Map<string, string>();
  shuffled.forEach((m, i) => slugToLetter.set(m.slug, letters[i]));

  const cellsByPromptModel = new Map<string, CellResult>();
  for (const c of meta.cells) {
    cellsByPromptModel.set(`${c.promptId}|${c.modelSlug}`, c);
  }

  const headerCells = shuffled
    .map((m) => `<th><span class="col-letter">${slugToLetter.get(m.slug)}</span></th>`)
    .join('');

  const rows = PROMPTS.map((p) => {
    const cells = shuffled
      .map((m) => {
        const cell = cellsByPromptModel.get(`${p.id}|${m.slug}`);
        if (!cell || cell.status === 'failure') {
          return `<td class="cell failure"><div class="err">${escapeHtml(cell?.errorMessage || 'no result')}</div></td>`;
        }
        // Relative path so the HTML opens directly in a browser from disk.
        const relPath = path.relative(RESULTS_DIR, cell.outputPath!).replace(/\\/g, '/');
        return `<td class="cell"><a href="${relPath}" target="_blank"><img src="${relPath}" alt="${p.id} ${slugToLetter.get(m.slug)}"></a></td>`;
      })
      .join('');
    return `<tr>
      <th class="row-label"><div class="pid">${p.id}</div><div class="plabel">${escapeHtml(p.label)}</div><div class="ptext">${escapeHtml(p.prompt)}</div></th>
      ${cells}
    </tr>`;
  }).join('\n');

  const revealRows = shuffled
    .map((m) => `<tr><td>${slugToLetter.get(m.slug)}</td><td>${escapeHtml(m.label)}</td><td><code>${escapeHtml(m.kieModel)}</code></td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Doodle style spike — blind rank</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #111; background: #fafafa; }
  h1 { margin: 0 0 8px; }
  p.lede { color: #555; margin-top: 0; max-width: 800px; }
  table { border-collapse: separate; border-spacing: 8px; width: 100%; }
  th.row-label { text-align: left; vertical-align: top; width: 240px; padding: 12px 8px; background: #fff; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  th.row-label .pid { font-weight: 700; font-size: 13px; color: #888; }
  th.row-label .plabel { font-weight: 600; margin-top: 4px; }
  th.row-label .ptext { font-size: 12px; color: #555; margin-top: 6px; line-height: 1.4; }
  th { text-align: center; padding: 8px; }
  .col-letter { display: inline-block; width: 32px; height: 32px; line-height: 32px; border-radius: 50%; background: #111; color: #fff; font-weight: 700; }
  td.cell { padding: 0; vertical-align: top; }
  td.cell img { width: 100%; max-width: 360px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.1); display: block; }
  td.cell.failure { background: #fff5f5; border: 1px dashed #f00; border-radius: 8px; padding: 12px; color: #a00; font-size: 12px; }
  td.cell.failure .err { white-space: pre-wrap; }
  details { margin-top: 32px; background: #fff; border-radius: 8px; padding: 12px 16px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  summary { font-weight: 600; cursor: pointer; }
  table.reveal { width: auto; border-spacing: 0; margin-top: 12px; }
  table.reveal td { padding: 6px 12px; border-bottom: 1px solid #eee; }
  .meta { color: #888; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<h1>Doodle style spike — blind rank</h1>
<p class="lede">Rate each output cell on (1) style match — does this look like the same artist drew it as the 5 reference doodles, (2) composition — readable and motion-graphics-friendly, (3) brief fidelity — did the model render what the prompt described. Click any image to enlarge. Reveal which model is which only after you've made your picks.</p>
<p class="meta">Started: ${meta.startedAt}${meta.finishedAt ? ` · Finished: ${meta.finishedAt}` : ''} · ${meta.cells.filter(c => c.status === 'success').length}/${meta.cells.length} cells succeeded</p>

<table>
  <thead><tr><th class="row-label">Prompt</th>${headerCells}</tr></thead>
  <tbody>
${rows}
  </tbody>
</table>

<details>
  <summary>Reveal model mapping</summary>
  <table class="reveal">
    <thead><tr><td><b>Column</b></td><td><b>Model</b></td><td><b>Kie endpoint</b></td></tr></thead>
    <tbody>${revealRows}</tbody>
  </table>
</details>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY missing — set it in .env.local');

  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

  // Load prior metadata when resuming a partial run.
  const meta: RunMetadata = fs.existsSync(METADATA_PATH)
    ? JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'))
    : {
        startedAt: new Date().toISOString(),
        refUrls: [],
        prompts: PROMPTS,
        models: MODELS.map(({ slug, label, kieModel }) => ({ slug, label, kieModel })),
        cells: [],
      };
  // On resume, refresh model + prompt lists from the current script
  // constants so removing a model or rewording a prompt actually
  // surfaces in the next grid render (the renderer iterates
  // meta.models for columns and PROMPTS for rows). Cached cells stay
  // attached to their (promptId, modelSlug) keys and resolve to the
  // same outputs unless the slug changed.
  meta.models = MODELS.map(({ slug, label, kieModel }) => ({ slug, label, kieModel }));
  meta.prompts = PROMPTS;

  console.log('Uploading 5 doodle refs to R2 ...');
  if (meta.refUrls.length === REF_FILENAMES.length) {
    console.log('  (using cached ref URLs from prior run)');
  } else {
    meta.refUrls = await uploadRefsToR2();
    fs.writeFileSync(METADATA_PATH, JSON.stringify(meta, null, 2));
  }

  console.log(`\nRunning ${PROMPTS.length} prompts × ${MODELS.length} models = ${PROMPTS.length * MODELS.length} cells.`);

  for (const model of MODELS) {
    console.log(`\n── ${model.label} (${model.kieModel}) ──`);
    for (const prompt of PROMPTS) {
      process.stdout.write(`  ${prompt.id} ${prompt.label} ... `);
      const result = await generateOne(apiKey, model, prompt, meta.refUrls);
      // Replace existing entry if any (resumed runs).
      const idx = meta.cells.findIndex(c => c.promptId === prompt.id && c.modelSlug === model.slug);
      if (idx >= 0) meta.cells[idx] = result;
      else meta.cells.push(result);
      fs.writeFileSync(METADATA_PATH, JSON.stringify(meta, null, 2));
      if (result.status === 'success') {
        console.log(`ok (${(result.durationMs! / 1000).toFixed(1)}s)`);
      } else if (result.status === 'skipped-cached') {
        console.log('cached');
      } else {
        console.log(`FAIL — ${result.errorMessage?.slice(0, 140)}`);
      }
    }
  }

  meta.finishedAt = new Date().toISOString();
  fs.writeFileSync(METADATA_PATH, JSON.stringify(meta, null, 2));
  fs.writeFileSync(GRID_PATH, renderGridHtml(meta));

  const successes = meta.cells.filter(c => c.status === 'success').length;
  const failures = meta.cells.filter(c => c.status === 'failure').length;
  console.log(`\nDone. ${successes} ok, ${failures} failed, ${meta.cells.length - successes - failures} cached.`);
  console.log(`Grid: ${GRID_PATH}`);
  console.log(`Metadata: ${METADATA_PATH}`);
}

main().catch((err) => {
  console.error('Spike runner failed:', err);
  process.exit(1);
});
