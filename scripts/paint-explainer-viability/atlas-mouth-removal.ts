/**
 * Paint Explainer v1 viability test — Atlas Edit step.
 *
 * Removes the open red mouth from public/style-refs/Doodle-explainer-2/
 * 14-close-up-character-face.jpg, producing a "mouth-removed" base PNG
 * we can overlay procedural mouth states on top of in Remotion/ffmpeg.
 *
 * This is a one-shot script. It costs ~$0.011 in Atlas tokens and writes
 * exactly one file:
 *   hiccup-analysis/paint-explainer-viability/14-mouth-removed.png
 *
 * Modelled directly on scripts/fix-doodle-explainer-2-refs.ts.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/paint-explainer-viability/atlas-mouth-removal.ts
 */
import fs from 'fs/promises';
import path from 'path';
import { generateAtlasEdit } from '../../src/lib/atlas-cloud-images';
import {
  deleteImagesObject,
  getImagesBucket,
  getImagesDownloadUrl,
  uploadToBucket,
} from '../../src/lib/r2';

const SOURCE_PATH = path.join(
  process.cwd(),
  'public',
  'style-refs',
  'Doodle-explainer-2',
  '14-close-up-character-face.jpg',
);

const OUTPUT_DIR = path.join(process.cwd(), 'hiccup-analysis', 'paint-explainer-viability');
const OUTPUT_PATH = path.join(OUTPUT_DIR, '14-mouth-removed.png');

const EDIT_PROMPT =
  'Remove the small open mouth (red interior, black outline) from the doodle character\'s face. ' +
  'The area where the mouth was must become plain face — no mouth shape, no scar, no marker, no shadow, no smudge. ' +
  'Keep absolutely everything else IDENTICAL to the input image: the round head outline, both oval-shaped eyes with their pupils, both angled eyebrows above the eyes, the small visible neck and shoulder lines below the head, the position of the head in the frame, the pure white background. ' +
  'Preserve the exact hand-drawn doodle style with thick uneven black outlines. ' +
  'Do not redraw any line that is not the mouth. The output must look like the input with the mouth carefully erased and the face beneath it left blank.';

async function main(): Promise<void> {
  console.info('[paint-explainer viability start]', {
    source: SOURCE_PATH,
    output: OUTPUT_PATH,
    prompt_chars: EDIT_PROMPT.length,
  });

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const buffer = await fs.readFile(SOURCE_PATH);
  console.info('[paint-explainer viability source read]', { bytes: buffer.length });

  const tempKey = `tmp-paint-explainer-viability/${Date.now()}-14-source.jpg`;
  const bucket = getImagesBucket();

  try {
    console.info('[paint-explainer viability upload start]', { bucket, key: tempKey });
    await uploadToBucket(bucket, tempKey, buffer, 'image/jpeg');
    const sourceUrl = await getImagesDownloadUrl(tempKey);
    console.info('[paint-explainer viability upload done]', { url_len: sourceUrl.length });

    console.info('[paint-explainer viability atlas-edit start]', {
      size: '1536x1024',
      quality: 'medium',
    });
    const editResult = await generateAtlasEdit({
      prompt: EDIT_PROMPT,
      images: [sourceUrl],
      size: '1536x1024',
      quality: 'medium',
    });
    console.info('[paint-explainer viability atlas-edit done]', {
      prediction_id: editResult.predictionId,
      predict_ms: editResult.predictTimeMs,
      tokens: editResult.tokens,
      url_len: editResult.url.length,
    });

    console.info('[paint-explainer viability download start]');
    const res = await fetch(editResult.url);
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }
    const outBuffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(OUTPUT_PATH, outBuffer);
    console.info('[paint-explainer viability download done]', {
      bytes: outBuffer.length,
      written_to: OUTPUT_PATH,
    });
  } finally {
    try {
      await deleteImagesObject(tempKey);
      console.info('[paint-explainer viability cleanup done]', { key: tempKey });
    } catch (cleanupErr) {
      const detail = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn('[paint-explainer viability cleanup failed]', { key: tempKey, detail: detail.slice(0, 200) });
    }
  }

  console.info('[paint-explainer viability done]');
}

main().catch((err) => {
  console.error('[paint-explainer viability fatal]', err instanceof Error ? err.stack : err);
  process.exit(1);
});
