/**
 * Smoke test: does Atlas Edit (openai/gpt-image-2/edit) preserve character
 * identity reliably enough to use it as a character-consistency mechanism
 * for the doodle_explainer_2 character_id cache feature?
 *
 * Plan: _plans/2026-05-28-doodle-2-character-cache.md (R5 / open question #1)
 *
 * What this does:
 *   1. Generate ONE canonical "George Sodder" stick-figure via Atlas t2i.
 *      This stands in for the cache entry that would land on the first
 *      row mentioning the character.
 *   2. Call Atlas Edit TWICE using that image as input, with two
 *      different scene prompts ("now fleeing a burning house", "now
 *      sitting with a photograph"). The edit prompt wrapper is the
 *      same one Phase 1 will use in production
 *      (buildCharacterContinuationEditPrompt format).
 *   3. Save all three images to _plans/2026-05-28-atlas-edit-smoke/.
 *
 * Then we eyeball whether George's identity (face shape, hair, body
 * proportions, clothing) carries across the three images. If yes →
 * Phase 1 is worth building. If no → kill the architecture and write
 * a degraded "character bible" plan.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/smoke-atlas-edit-character-continuity.ts
 *
 * Cost: ~$0.02 (1 × t2i at $0.009 + 2 × edit at ~$0.011 each).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateAtlasI2I, generateAtlasEdit } from '../src/lib/atlas-cloud-images';
import { mirrorBuiltInRefToR2 } from '../src/lib/production-doc-styles-refs';
import { getBuiltInStyle } from '../src/lib/production-doc-styles';

const OUT_DIR = path.resolve(__dirname, '..', '_plans', '2026-05-28-atlas-edit-smoke');

// Canonical "George Sodder" — the kind of base image that would land in
// the doodle_explainer_2 character cache on the first row mentioning the
// character. Uses Atlas i2i with the 4 doodle_explainer_2 style refs so
// the canonical lands in the correct aesthetic (wobbly hand-drawn doodle,
// no-hand rule, thick black ink outlines). The Edit step then preserves
// whatever aesthetic the canonical has.
const CANONICAL_PROMPT =
  'A single doodle stick figure of George Sodder, a 1940s American working-class father, ' +
  'standing centered on a pure white background. ' +
  'Slightly imperfect round head with two small dot eyes, short curved eyebrows, and a small flat-line mouth (neutral expression). ' +
  'Short dark brown hair sketched with a few simple ink strokes. ' +
  'Wearing a white button-up shirt with rolled sleeves and thin dark gray suspenders, ' +
  'and dark brown high-waisted trousers. ' +
  'Single-line stick body and limbs, with arms ENDING IN LINE TIPS — no hands, no fingers visible. ' +
  'Generous empty white space all around the figure. NO text anywhere.';

// Edit-prompt wrapper — matches the format proposed in
// buildCharacterContinuationEditPrompt() in the plan. Production version
// will be a small helper that takes the row's ai_image_prompt and wraps
// it; here we inline the wrapper for clarity.
function wrapEdit(scenePrompt: string): string {
  return (
    `Modify this image to show the SAME character in this new scene: ${scenePrompt}. ` +
    `CRITICAL: keep the character's face, hair, body proportions, clothing (white shirt, suspenders, dark trousers), ` +
    `and overall identity EXACTLY identical to the input image. ` +
    `Only change the pose, setting, expression, and other scene elements per the new scene description above. ` +
    `Maintain the hand-drawn doodle style with thick uneven black ink outlines and flat color fills.`
  );
}

const EDIT_SCENES: Array<{ filename: string; scene: string }> = [
  {
    filename: '02-george-fleeing-fire.jpg',
    scene:
      'running through deep snow at night, both arms raised in panic, wide-open eyes and open-O mouth, ' +
      'a 1940s wooden two-story farmhouse burning behind him with bright orange flames in the upper-floor windows and gray smoke billowing into the night sky, ' +
      'a few snow-covered evergreen trees on either side, his footprints visible in the snow behind him',
  },
  {
    filename: '03-george-with-photograph.jpg',
    scene:
      'sitting at a wooden kitchen table in a dimly lit 1940s farmhouse interior, ' +
      'holding a small framed black-and-white photograph in both hands (one nub-hand per CRITICAL exception — needed to grip the frame), ' +
      'downcast eyes with a single small tear and a flat sad expression, ' +
      'a warm-yellow oil lamp on the table beside him casting soft light, ' +
      'pale gray wood-plank wall in the background',
  },
];

async function downloadAndSave(url: string, target: string): Promise<number> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download failed ${resp.status} ${resp.statusText}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(target, buf);
  return buf.length;
}

async function main(): Promise<void> {
  if (!process.env.ATLAS_CLOUD_API_KEY) {
    throw new Error('ATLAS_CLOUD_API_KEY missing. Did you forget --env-file-if-exists=.env.local?');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.info('[smoke-atlas-edit] starting');
  console.info('[smoke-atlas-edit] output dir:', OUT_DIR);

  // ─── 0) Mirror the 4 doodle_explainer_2 style refs to R2 ───────────────
  // Atlas i2i wants HTTP-fetchable URLs for refs; mirrorBuiltInRefToR2
  // uploads the bundled file (in public/style-refs/...) to R2 and
  // returns a presigned GET URL. Reuses the in-process cache so a
  // re-run within the same process skips re-upload.
  const style = getBuiltInStyle('doodle_explainer_2');
  if (!style?.built_in_refs?.length) throw new Error('doodle_explainer_2 has no built-in refs');
  console.info('[smoke-atlas-edit] STEP 0 — mirroring', style.built_in_refs.length, 'style refs to R2');
  const refUrls = await Promise.all(
    style.built_in_refs.map((ref) =>
      mirrorBuiltInRefToR2({
        styleId: 'doodle_explainer_2',
        filename: ref.filename,
        mimeType: ref.mime_type,
      }),
    ),
  );
  for (const u of refUrls) console.info('  ref:', u.slice(0, 80) + '...');

  // ─── 1) Canonical character via Atlas i2i + the 4 style refs ───────────
  console.info('\n[smoke-atlas-edit] STEP 1 — canonical George (Atlas i2i with', refUrls.length, 'style refs)');
  const t0 = Date.now();
  const i2i = await generateAtlasI2I({
    prompt: CANONICAL_PROMPT,
    images: refUrls,
    size: '2560x1440',
    quality: 'low',
  });
  console.info(`[smoke-atlas-edit] i2i took ${Date.now() - t0}ms, url=${i2i.url}`);

  const canonicalTarget = path.join(OUT_DIR, '01-canonical-george.jpg');
  const canonicalBytes = await downloadAndSave(i2i.url, canonicalTarget);
  console.info(`[smoke-atlas-edit] saved ${canonicalBytes} bytes -> ${canonicalTarget}`);

  // ─── 2) Two character-continuation edits ───────────────────────────────
  // Run in parallel — Atlas accepts concurrent edit calls and the smoke
  // test is the user's blocking work.
  const editResults = await Promise.all(
    EDIT_SCENES.map(async ({ filename, scene }) => {
      const editPrompt = wrapEdit(scene);
      console.info(`\n[smoke-atlas-edit] STEP 2 — ${filename} (Atlas Edit, prompt ${editPrompt.length} chars)`);
      const tEdit = Date.now();
      try {
        const result = await generateAtlasEdit({
          prompt: editPrompt,
          images: [i2i.url],
          size: '2560x1440',
          quality: 'low',
        });
        console.info(`[smoke-atlas-edit] ${filename} edit took ${Date.now() - tEdit}ms, url=${result.url}`);
        const target = path.join(OUT_DIR, filename);
        const bytes = await downloadAndSave(result.url, target);
        console.info(`[smoke-atlas-edit] saved ${bytes} bytes -> ${target}`);
        return { filename, ok: true } as const;
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        console.error(`[smoke-atlas-edit] ${filename} FAIL after ${Date.now() - tEdit}ms: ${err}`);
        return { filename, ok: false, err } as const;
      }
    }),
  );

  console.info('\n=== RESULTS ===');
  console.info('  canonical:', '01-canonical-george.jpg');
  for (const r of editResults) {
    console.info(`  edit:     `, r.filename, r.ok ? 'OK' : `FAIL — ${r.err}`);
  }
  console.info('\nView all three side-by-side in:', OUT_DIR);

  const anyFail = editResults.some((r) => !r.ok);
  if (anyFail) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[smoke-atlas-edit] FATAL:', e);
  process.exit(1);
});
