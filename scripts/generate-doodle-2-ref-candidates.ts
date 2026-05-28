/**
 * One-shot generator for 4 candidate refs in the doodle_explainer_2 style.
 *
 * Per the plan _plans/2026-05-28-doodle-2-authenticity-round.md, the four
 * refs map to the four style pillars: face close-up, full-body action pose,
 * yellow typography, framed real-photo composition. Subjects are deliberately
 * generic so the model has no specific content to copy when the catalog is
 * later replaced with these.
 *
 * Uses Atlas GPT Image 2 t2i at low quality, 2K native — verified $0.009
 * flat per image (atlas-cloud-images.ts). Total cost: ~$0.036.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/generate-doodle-2-ref-candidates.ts
 *
 * Outputs land in public/style-refs/Doodle-explainer-2-candidates/ — a
 * sibling of the live folder so nothing in production is touched until
 * the user approves the candidates.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateAtlasT2I } from '../src/lib/atlas-cloud-images';

const OUT_DIR = path.resolve(__dirname, '..', 'public', 'style-refs', 'Doodle-explainer-2-candidates');

// Shared style scaffolding — copied verbatim from the doodle_explainer_2
// ai_image_suffix in src/lib/production-doc-styles.ts so the candidates
// land in the same visual family as the live style.
const STYLE_SCAFFOLD =
  'Hand-drawn cartoon doodle in the Paint Explainer YouTube style — pure white background, ' +
  'thick uneven black ink outlines (intentional wobble, not vector-clean), flat fills only, ' +
  'no shading, no texture, no 3D rendering, no anime, no manga, no photorealism. ' +
  'Stick-figure character anatomy: heads are slightly imperfect circles with thin black outline, ' +
  'eyes are small dots or small ovals, eyebrows are short curved strokes, mouths are simple lines ' +
  'or small O shapes. Body is a single-stroke thin line down to feet. Arms END IN A LINE TIP — ' +
  'no anatomical hand, no fingers, no palm, no fist. Lines are wobbly and freehand-feeling, ' +
  'not clean vector. Generous negative space around the subject.';

interface Candidate {
  filename: string;
  prompt: string;
}

const CANDIDATES: Candidate[] = [
  {
    filename: 'ref-01-face-closeup.jpg',
    prompt:
      `${STYLE_SCAFFOLD} ` +
      'Subject: a single doodle character head and shoulders centered on white. ' +
      'Slightly imperfect circular head, two small dot eyes, slightly raised eyebrows, ' +
      'a small open-mouth O of mild surprise. No props, no background details, no hat, ' +
      'no hair styling, no glasses, no clothing detail visible. Plain neutral character. ' +
      'Centered composition with generous white space around. NO text in the image.',
  },
  {
    filename: 'ref-02-full-body-action.jpg',
    prompt:
      `${STYLE_SCAFFOLD} ` +
      'Subject: a single doodle stick figure standing on the left side of the frame, ' +
      'one arm raised pointing forward to the right, the other arm relaxed at the side. ' +
      'Arms end in line tips with NO HANDS visible — no fingers, no palms, no nubs. ' +
      'Body is a single thin line from head to feet. Neutral round head with two small dot eyes ' +
      'and a flat-line mouth. No clothing detail. No props. No background. Lots of empty white ' +
      'space to the right of the figure. NO text in the image.',
  },
  {
    filename: 'ref-03-yellow-typography.jpg',
    prompt:
      `${STYLE_SCAFFOLD} ` +
      'Subject: a single comic-bold typography word reading "Highlight" centered on a pure white ' +
      'background. The letters are filled with bright saturated yellow (#FFD700-ish) and have ' +
      'thick uneven black ink outlines around every letter, matching the hand-drawn doodle style. ' +
      'No character, no scene, no props, no other text, no decorative elements. Just the single ' +
      'word "Highlight" floating on white with empty space around it.',
  },
  {
    filename: 'ref-04-framed-realphoto.jpg',
    prompt:
      `${STYLE_SCAFFOLD} ` +
      'Subject: a real photograph of a serene forest with sunlight filtering through tall trees, ' +
      'inset inside a thin black rounded-rectangle frame (about 8px corner radius) drawn in the ' +
      'wobbly doodle ink style. The framed photo sits in the LEFT HALF of the composition; the ' +
      'right half is empty white space. The photo itself is realistic, NOT stylized. The frame ' +
      'around it is in the doodle style. No character, no caption, no other elements. NO text in ' +
      'the image.',
  },
];

async function generateOne(candidate: Candidate): Promise<{ filename: string; ok: boolean; err?: string }> {
  const target = path.join(OUT_DIR, candidate.filename);
  if (fs.existsSync(target)) {
    console.info(`[doodle-2 ref-gen] SKIP ${candidate.filename} — already exists`);
    return { filename: candidate.filename, ok: true };
  }

  console.info(`[doodle-2 ref-gen] START ${candidate.filename} (prompt ${candidate.prompt.length} chars)`);
  const t0 = Date.now();

  try {
    const result = await generateAtlasT2I({
      prompt: candidate.prompt,
      size: '2560x1440',
      quality: 'low',
    });

    console.info(`[doodle-2 ref-gen] GEN ${candidate.filename} took ${Date.now() - t0}ms url=${result.url}`);

    const imgResp = await fetch(result.url);
    if (!imgResp.ok) {
      throw new Error(`download failed ${imgResp.status} ${imgResp.statusText}`);
    }
    const buf = Buffer.from(await imgResp.arrayBuffer());
    fs.writeFileSync(target, buf);

    console.info(`[doodle-2 ref-gen] SAVE ${candidate.filename} ${buf.length} bytes -> ${target}`);
    return { filename: candidate.filename, ok: true };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error(`[doodle-2 ref-gen] FAIL ${candidate.filename} after ${Date.now() - t0}ms: ${err}`);
    return { filename: candidate.filename, ok: false, err };
  }
}

async function main(): Promise<void> {
  if (!process.env.ATLAS_CLOUD_API_KEY) {
    throw new Error('ATLAS_CLOUD_API_KEY missing. Did you forget --env-file-if-exists=.env.local?');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.info(`[doodle-2 ref-gen] starting ${CANDIDATES.length} candidates in parallel -> ${OUT_DIR}`);

  const results = await Promise.all(CANDIDATES.map(generateOne));

  console.info('\n=== Results ===');
  for (const r of results) {
    console.info(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.filename}${r.err ? ` — ${r.err}` : ''}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[doodle-2 ref-gen] fatal:', e);
  process.exit(1);
});
