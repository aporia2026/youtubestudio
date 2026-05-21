/**
 * One-shot diagnostic for the two Kie models that returned 500 / internal
 * error on every cell during the full spike run (NanoBanana Pro,
 * Ideogram v3 Remix).
 *
 * Hypothesis: the optional fields I passed (output_format, resolution,
 * strength, image_size) trip Kie's request validator even though the
 * docs list them as accepted. Strip everything to the docs-required
 * minimum, fire one call each, see what comes back.
 *
 * Reuses the ref URLs from the prior spike run's metadata.json so we
 * don't re-upload (saves a round-trip but mostly to keep the test on
 * the exact same input the production spike used). Cost ≈ $0.10.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/style-spike-debug.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createKieTask, pollKieResult } from '../src/lib/kie-poll';

const METADATA_PATH = path.resolve(
  __dirname,
  '..',
  '_plans',
  '2026-05-21-phase-0-spike-results',
  'metadata.json',
);

const TEST_PROMPT =
  'A single stick figure waving hello on a plain white background, simple round head, dot eyes, thick black ink outlines.';

interface MinimalTest {
  label: string;
  model: string;
  input: Record<string, unknown>;
}

async function main(): Promise<void> {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY missing');

  if (!fs.existsSync(METADATA_PATH)) {
    throw new Error(`Spike metadata not found at ${METADATA_PATH}. Run scripts/style-spike.ts first.`);
  }
  const meta = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8')) as { refUrls: string[] };
  if (!meta.refUrls?.length) throw new Error('No cached ref URLs in metadata.json');

  const firstRef = meta.refUrls[0];
  console.log(`Using ref URL: ${firstRef.slice(0, 120)}...`);
  console.log();

  // Minimal payloads — only the fields the docs list as REQUIRED.
  // Comparing against the previous run, the only diff is the stripped
  // optional fields (output_format, resolution, strength, image_size).
  // If these minimal versions also fail, the model is genuinely
  // broken at Kie today and we drop it from contention.
  const tests: MinimalTest[] = [
    {
      label: 'NanoBanana Pro — minimal',
      model: 'nano-banana-pro',
      input: {
        prompt: TEST_PROMPT,
        image_input: [firstRef],
      },
    },
    {
      label: 'NanoBanana Pro — minimal + aspect_ratio',
      model: 'nano-banana-pro',
      input: {
        prompt: TEST_PROMPT,
        image_input: [firstRef],
        aspect_ratio: '16:9',
      },
    },
    {
      label: 'Ideogram v3 Remix — minimal',
      model: 'ideogram/v3-remix',
      input: {
        prompt: TEST_PROMPT,
        image_url: firstRef,
      },
    },
  ];

  for (const test of tests) {
    console.log(`── ${test.label} ──`);
    console.log(`  model: ${test.model}`);
    console.log(`  input: ${JSON.stringify(test.input).slice(0, 200)}...`);
    const t0 = Date.now();
    try {
      const taskId = await createKieTask(apiKey, test.model, test.input);
      console.log(`  ✓ taskId: ${taskId}`);
      const url = await pollKieResult(taskId, apiKey);
      console.log(`  ✓ result: ${url.slice(0, 120)}...`);
      console.log(`  duration: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      console.log(`  ✗ FAIL: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error('Debug script failed:', err);
  process.exit(1);
});
