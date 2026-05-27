/**
 * One-shot fixer for the doodle_explainer_2 reference images.
 *
 * Why this exists:
 *   The 14 refs bundled under public/style-refs/Doodle-explainer-2/ were
 *   extracted directly from a WannaCry-themed YouTube video. Every ref
 *   has subject-specific text baked at the top ("Wannacry", "Stuxnet",
 *   "Russian Sleep Experiment", etc.) and several carry subject-coded
 *   motifs (padlock-on-screen, red skull-and-crossbones, deleted-files
 *   red X). The nano-banana-2-i2i model faithfully reproduces those
 *   elements in every output, polluting unrelated production-doc rows
 *   with WannaCry artifacts. See
 *   _plans/2026-05-27-doodle-explainer-2-ref-bleed-fix.md.
 *
 * What it does:
 *   For each ref classified as `erase-text` or `edit-motif`, uploads
 *   the file to R2 under a temp prefix, calls Atlas Edit
 *   (openai/gpt-image-2/edit) with a per-ref prompt, downloads the
 *   result, and overwrites the original file under
 *   public/style-refs/Doodle-explainer-2/. Drops are left alone — the
 *   user removes them manually after this script reports them.
 *
 *   Idempotent. Re-running edits the already-edited refs again. Use git
 *   as the safety net for restoring a bad edit (the original files are
 *   tracked).
 *
 * Cost: ~$0.011 per Atlas Edit call. 11 calls → ~$0.12. Token billing
 *   varies; the script logs actual per-call cost from the response.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/fix-doodle-explainer-2-refs.ts
 *
 *   Add --dry-run to print the work plan without making any API calls.
 *   Add --only <num> (e.g. --only 5) to process a single ref by number.
 */
import fs from 'fs/promises';
import path from 'path';
import { generateAtlasEdit } from '../src/lib/atlas-cloud-images';
import {
  deleteImagesObject,
  getImagesBucket,
  getImagesDownloadUrl,
  uploadToBucket,
} from '../src/lib/r2';

type RefAction = 'erase-text' | 'edit-motif' | 'drop';

interface RefSpec {
  num: number;
  filename: string;
  action: RefAction;
  /** Prompt sent to Atlas Edit. Undefined for `drop`. */
  prompt?: string;
}

/** The 14 refs, classified per the plan. Keep in numeric order matching
 *  the filenames on disk so the logs read naturally. */
const REFS: RefSpec[] = [
  {
    num: 1,
    filename: '01-composite-cartoon-book-with-framed-real-photo.jpg',
    action: 'erase-text',
    prompt:
      'Remove the bold black "Russian Sleep Experiment" text from the top of the image. Also remove the "creepypasta wiki" watermark from the bottom-right corner of the red-blob inset image. Keep everything else exactly as-is: the cartoon doodle book on the left, the red-blob inset on the right with the orange curved arrow between them, the pure white background. Hand-drawn doodle style with thick uneven black outlines must be preserved.',
  },
  {
    num: 2,
    filename: '02-pure-illustration-cartoon-building-pale-blue.jpg',
    action: 'erase-text',
    prompt:
      'Remove the bold black "Russian Sleep Experiment" text from the top of the image. Keep everything else exactly as-is: the cartoon doodle building with pale blue accents at the rooflines and windows, the pure white background. Hand-drawn doodle style with thick uneven black outlines must be preserved.',
  },
  {
    num: 3,
    filename: '03-lone-stick-figure-frowning.jpg',
    action: 'erase-text',
    prompt:
      'Remove the bold black "Stairs in the Woods" text from the top of the image. Keep everything else exactly as-is: the lone stick figure with a frowning face and crossed arms in the lower-left, the pure white background. Hand-drawn doodle style with thick uneven black outlines must be preserved.',
  },
  {
    num: 4,
    filename: '04-stick-figure-raised-arm-no-hand-angry.jpg',
    action: 'erase-text',
    prompt:
      'Remove the bold black "Wannacry" text from the top of the image. Keep everything else exactly as-is: the angry-looking stick-figure head with arms raised (no anatomical hands, just line tips), the pure white background. Hand-drawn doodle style with thick uneven black outlines must be preserved.',
  },
  {
    num: 5,
    filename: '05-color-composition-globe-with-computer-callouts.jpg',
    action: 'edit-motif',
    prompt:
      'Two changes. First: remove the bold black "Wannacry" text from the top of the image. Second: in each of the four small computer-monitor icons inside the round speech-bubble callouts around the globe, replace the padlock-with-yellow-shape icon on the monitor screen with an empty monitor screen (no padlock, no warning symbol, just a blank screen). Keep the globe with blue oceans and green continents in the center, the four round white callouts in the corners with their thin-line tails pointing to the globe, the doodle hand-drawn style, and the pure white background.',
  },
  {
    num: 6,
    filename: '06-object-network-laptops-arrows.jpg',
    action: 'edit-motif',
    prompt:
      'Two changes. First: remove the bold black "Wannacry" text from the top of the image. Second: on the center laptop\'s screen, replace the red skull-and-crossbones icon with a blank screen (nothing on the screen). Keep the four outer laptops at the four corners, the four pale-blue arrows pointing from the center laptop outward to each outer laptop, the pure white background, and the doodle hand-drawn style with thick black outlines.',
  },
  {
    num: 7,
    filename: '07-icon-composition-tv-with-deleted-files-x.jpg',
    action: 'drop',
  },
  {
    num: 8,
    filename: '08-framed-real-photo-inside-cartoon-tv.jpg',
    action: 'drop',
  },
  {
    num: 9,
    filename: '09-yellow-bubble-text-standalone-within-hours.jpg',
    action: 'edit-motif',
    prompt:
      'Two changes. First: remove the bold black "Wannacry" text from the top of the image. Second: replace the yellow bubble-letter text "Within hours" in the middle of the frame with the words "Example text" rendered in the EXACT SAME chunky yellow-fill bubble-letter style with a thin black outline, same size, same position. The replacement must look identical in style to the original yellow bubble — only the words change. Keep the pure white background. No other changes.',
  },
  {
    num: 10,
    filename: '10-stick-figure-raised-arm-no-hand-calm.jpg',
    action: 'erase-text',
    prompt:
      'Remove the bold black "Wannacry" text from the top of the image. Keep everything else exactly as-is: the calm-looking stick-figure head with one arm raised (no anatomical hand, just a line tip), the pure white background. Hand-drawn doodle style with thick uneven black outlines must be preserved.',
  },
  {
    num: 11,
    filename: '11-yellow-text-overlaid-on-globe-scene.jpg',
    action: 'drop',
  },
  {
    num: 12,
    filename: '12-stick-figure-single-red-accent.jpg',
    action: 'erase-text',
    prompt:
      'Remove the bold black "Stuxnet" text from the top of the image. Keep everything else exactly as-is: the stick figure with the saturated-red skull-shaped head on the left side of the frame, the body in black outline, the pure white background. Hand-drawn doodle style with thick uneven black outlines must be preserved.',
  },
  {
    num: 13,
    filename: '13-framed-real-photo-pure-centrifuges.jpg',
    action: 'edit-motif',
    prompt:
      'Two changes. First: remove the bold black "Stuxnet" text from the top of the image. Second: inside the thick-black-bordered rectangular frame on the left half of the image (currently containing a photograph of metallic nuclear centrifuges), replace the photo with a generic real photograph of a snow-capped mountain landscape at sunrise — no people, no buildings, no machinery, just nature. Keep the thick black hand-drawn border around the framed photo, the empty pure white background outside the frame on the right side, and the doodle hand-drawn outer style.',
  },
  {
    num: 14,
    filename: '14-close-up-character-face.jpg',
    action: 'erase-text',
    prompt:
      'Remove the bold black "Goggle.com" text from the top of the image. Keep everything else exactly as-is: the close-up doodle stick-figure face with the surprised oval-eyes expression and the small open mouth, the pure white background. Hand-drawn doodle style with thick uneven black outlines must be preserved.',
  },
];

const REFS_DIR = path.join(process.cwd(), 'public', 'style-refs', 'Doodle-explainer-2');

interface PerRefOutcome {
  num: number;
  filename: string;
  action: RefAction;
  status: 'edited' | 'drop-notice' | 'skipped' | 'failed';
  detail?: string;
  costUsdNote?: string;
}

function parseArgs(): { dryRun: boolean; only: number | null } {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 && args[onlyIdx + 1] ? Number.parseInt(args[onlyIdx + 1] ?? '', 10) : null;
  if (only !== null && Number.isNaN(only)) {
    throw new Error('--only requires an integer (1..14)');
  }
  return { dryRun, only };
}

async function processRef(ref: RefSpec, dryRun: boolean): Promise<PerRefOutcome> {
  if (ref.action === 'drop') {
    console.info('[fix-refs drop-notice]', {
      num: ref.num,
      filename: ref.filename,
      note: 'subject-coded beyond text removal — delete manually after script finishes',
    });
    return { num: ref.num, filename: ref.filename, action: ref.action, status: 'drop-notice' };
  }

  const localPath = path.join(REFS_DIR, ref.filename);

  if (dryRun) {
    console.info('[fix-refs plan]', {
      num: ref.num,
      filename: ref.filename,
      action: ref.action,
      prompt_chars: ref.prompt?.length ?? 0,
    });
    return { num: ref.num, filename: ref.filename, action: ref.action, status: 'skipped', detail: 'dry-run' };
  }

  if (!ref.prompt) {
    return { num: ref.num, filename: ref.filename, action: ref.action, status: 'failed', detail: 'no prompt configured' };
  }

  const tempKey = `tmp-doodle-ref-edits/${Date.now()}-${ref.num.toString().padStart(2, '0')}-${ref.filename}`;
  const bucket = getImagesBucket();

  try {
    console.info('[fix-refs upload start]', { num: ref.num, filename: ref.filename, bucket, key: tempKey });
    const buffer = await fs.readFile(localPath);
    await uploadToBucket(bucket, tempKey, buffer, 'image/jpeg');
    const sourceUrl = await getImagesDownloadUrl(tempKey);
    console.info('[fix-refs upload done]', { num: ref.num, url_len: sourceUrl.length });

    console.info('[fix-refs atlas-edit start]', {
      num: ref.num,
      action: ref.action,
      prompt_chars: ref.prompt.length,
      size: '1536x1024',
    });
    const editResult = await generateAtlasEdit({
      prompt: ref.prompt,
      images: [sourceUrl],
      size: '1536x1024',
      quality: 'medium',
    });
    console.info('[fix-refs atlas-edit done]', {
      num: ref.num,
      prediction_id: editResult.predictionId,
      predict_ms: editResult.predictTimeMs,
      tokens: editResult.tokens,
    });

    console.info('[fix-refs download start]', { num: ref.num, url_len: editResult.url.length });
    const res = await fetch(editResult.url);
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }
    const outBuffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(localPath, outBuffer);
    console.info('[fix-refs download done]', { num: ref.num, bytes: outBuffer.length, written_to: localPath });

    return {
      num: ref.num,
      filename: ref.filename,
      action: ref.action,
      status: 'edited',
      detail: `predict_ms=${editResult.predictTimeMs ?? '?'} bytes=${outBuffer.length}`,
      costUsdNote: `tokens: in=${editResult.tokens?.input ?? '?'} out=${editResult.tokens?.output ?? '?'} img=${editResult.tokens?.image ?? '?'}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[fix-refs error]', { num: ref.num, filename: ref.filename, detail: msg.slice(0, 240) });
    return { num: ref.num, filename: ref.filename, action: ref.action, status: 'failed', detail: msg.slice(0, 240) };
  } finally {
    try {
      await deleteImagesObject(tempKey);
      console.info('[fix-refs cleanup done]', { num: ref.num, key: tempKey });
    } catch (cleanupErr) {
      const detail = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn('[fix-refs cleanup failed]', { num: ref.num, key: tempKey, detail: detail.slice(0, 200) });
    }
  }
}

async function main(): Promise<void> {
  const { dryRun, only } = parseArgs();
  const work = only === null ? REFS : REFS.filter((r) => r.num === only);
  if (work.length === 0) {
    console.error('[fix-refs done] nothing to do — check --only argument');
    process.exit(2);
  }

  console.info('[fix-refs start]', {
    dry_run: dryRun,
    only,
    total_refs: work.length,
    drops: work.filter((r) => r.action === 'drop').length,
    edits: work.filter((r) => r.action !== 'drop').length,
  });

  const outcomes: PerRefOutcome[] = [];
  for (const ref of work) {
    const outcome = await processRef(ref, dryRun);
    outcomes.push(outcome);
  }

  const editedCount = outcomes.filter((o) => o.status === 'edited').length;
  const dropCount = outcomes.filter((o) => o.status === 'drop-notice').length;
  const failedCount = outcomes.filter((o) => o.status === 'failed').length;
  const skippedCount = outcomes.filter((o) => o.status === 'skipped').length;

  console.info('[fix-refs done]', {
    edited: editedCount,
    drop_notices: dropCount,
    failed: failedCount,
    skipped: skippedCount,
    next_step: dropCount > 0 ? 'rm public/style-refs/Doodle-explainer-2/{07-,08-,11-}*.jpg' : 'review edits, commit if good',
  });

  if (failedCount > 0) {
    console.error('[fix-refs done] some refs failed — see logs above; retry with --only <num>');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[fix-refs fatal]', err instanceof Error ? err.stack : err);
  process.exit(1);
});
