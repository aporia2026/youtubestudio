/**
 * One-off smoke test for the Flux Kontext wiring.
 *
 *   npx tsx scripts/test-flux-kontext.ts
 *
 * Reads KIE_API_KEY from .env.local, fires a real edit against a
 * public test image, polls to completion, and prints the result URL
 * + timing. Exits non-zero on any error. Costs the price of one
 * flux-kontext-pro edit per run, so don't loop on it.
 */
import { config } from 'dotenv';
import {
  createFluxKontextTask,
  pollFluxKontextResult,
} from '../src/lib/kie-poll';

config({ path: '.env.local' });

const TEST_IMAGE =
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800&h=600&fit=crop';
const PROMPT = 'Convert the photograph to a soft sepia tone, keep composition.';

async function main() {
  const key = process.env.KIE_API_KEY;
  if (!key) {
    console.error('KIE_API_KEY missing from .env.local');
    process.exit(1);
  }
  console.log('[test] firing flux-kontext-pro create against', TEST_IMAGE);
  const t0 = Date.now();
  let taskId: string;
  try {
    taskId = await createFluxKontextTask(key, {
      prompt: PROMPT,
      inputImage: TEST_IMAGE,
      model: 'flux-kontext-pro',
      aspectRatio: '4:3',
      outputFormat: 'png',
    });
  } catch (err) {
    console.error('[test] createFluxKontextTask threw:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
  console.log('[test] taskId =', taskId, '(after', Date.now() - t0, 'ms)');

  try {
    const url = await pollFluxKontextResult(taskId, key);
    console.log('[test] resultImageUrl =', url);
    console.log('[test] total elapsed =', Date.now() - t0, 'ms');
    process.exit(0);
  } catch (err) {
    console.error('[test] pollFluxKontextResult threw:', err instanceof Error ? err.message : err);
    process.exit(3);
  }
}

void main();
