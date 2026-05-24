/**
 * One-shot seeder — turns the built-in "Doodle Explainer" descriptor
 * into an editable v2 saved style with refs already attached.
 *
 * Why this exists:
 *   The built-in "Doodle Explainer" lives in code (BUILT_IN_STYLES).
 *   It carries a descriptor + mixing rules but cannot have refs —
 *   refs are a DB-only concept on saved styles. The v2 i2i path
 *   (NanoBanana Pro / Flux 2 Pro i2i / Qwen-Image-Edit-2509) only
 *   fires when a saved style with at least one validated ref is the
 *   active style. This seeder bridges that gap by writing a saved
 *   style + uploading the curated PNGs from
 *   `public/style-refs/Doodle-explainer/` to R2 + inserting
 *   `style_reference_images` rows pointing at them.
 *
 * Idempotent: a re-run with the same `--name` short-circuits if a
 * style with that name already exists in the target workspace.
 * Override with `--force-rename` to bypass and use a `(2)` suffix.
 *
 * Visibility: defaults to workspace-wide (`owner_id = NULL`) so every
 * collaborator sees it. Pass `--owner <uid>` to make it private to
 * one user (the same gating that the StyleManagerDialog draft flow
 * uses).
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local \
 *     scripts/seed-doodle-explainer-style.ts \
 *     --workspace <workspace-uuid>
 *
 * To target prod, prefix with the prod DB env:
 *   POSTGRES_URL=$(vercel env pull --environment=production ...) \
 *     npx tsx scripts/seed-doodle-explainer-style.ts --workspace <ws>
 */
import fs from 'fs';
import path from 'path';
import { sql } from '@vercel/postgres';
import {
  getImagesBucket,
  uploadToBucket,
} from '../src/lib/r2';
import { BUILT_IN_STYLES } from '../src/lib/production-doc-styles';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REFS_DIR = path.join(PROJECT_ROOT, 'public', 'style-refs', 'Doodle-explainer');

// Same ordering as the Phase 0 spike — position 0 is the strongest
// anchor that single-ref models (and the lead image for multi-ref
// models) bias toward. Keep magnifying-glass first because it carries
// the cleanest exemplar of the line weight + colour palette.
const REF_FILENAMES = [
  'stick-figure-magnifying-glass-phone.png',
  'stick-figure-hacker-laptop.png',
  'stick-figure-tracked-by-location.png',
  'stick-figure-hacker-deceives-guard.png',
  'stick-figure-soldiers-running.png',
] as const;

interface CliArgs {
  workspaceId: string;
  ownerId: string | null;
  name: string;
  forceRename: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const out: Partial<CliArgs> = { ownerId: null, forceRename: false, name: 'Doodle Explainer (refs)' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--workspace' || arg === '-w') {
      out.workspaceId = argv[++i];
    } else if (arg === '--owner' || arg === '-o') {
      out.ownerId = argv[++i] || null;
    } else if (arg === '--name' || arg === '-n') {
      out.name = argv[++i] || out.name;
    } else if (arg === '--force-rename') {
      out.forceRename = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage:
  npx tsx scripts/seed-doodle-explainer-style.ts --workspace <uuid> [options]

Required:
  --workspace, -w <uuid>   Workspace to seed the style into.

Optional:
  --owner, -o <uuid>       Make the style private to this user.
                           Default: workspace-wide (visible to everyone).
  --name, -n <name>        Style name. Default: "Doodle Explainer (refs)".
  --force-rename           If a style with that name already exists,
                           append " (N)" and proceed instead of skipping.
  --help, -h               Show this help.
`);
      process.exit(0);
    }
  }
  if (!out.workspaceId) {
    console.error('error: --workspace <uuid> is required (run with --help)');
    process.exit(1);
  }
  return out as CliArgs;
}

function readRefBytes(filename: string): { bytes: Buffer; size: number; mimeType: 'image/png' } {
  const full = path.join(REFS_DIR, filename);
  if (!fs.existsSync(full)) {
    throw new Error(`Ref file not found: ${full}`);
  }
  const bytes = fs.readFileSync(full);
  // Magic-byte check — defensive, the source is our own repo but
  // catching a corrupted file here beats silently uploading garbage.
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error(`File ${filename} is not a valid PNG (magic bytes wrong)`);
  }
  return { bytes, size: bytes.length, mimeType: 'image/png' };
}

async function findExistingStyle(workspaceId: string, name: string): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM production_doc_styles
     WHERE workspace_id = ${workspaceId}::uuid
       AND name = ${name}
       AND draft = FALSE
     LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

async function resolveAvailableName(workspaceId: string, base: string): Promise<string> {
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base} (${n})`;
    const existing = await findExistingStyle(workspaceId, candidate);
    if (!existing) return candidate;
  }
  throw new Error(`Could not find an available name after 99 tries for "${base}"`);
}

async function main() {
  const args = parseArgs();
  console.log(`[seed-doodle] workspace=${args.workspaceId} owner=${args.ownerId ?? '(workspace-wide)'} name="${args.name}"`);

  // Idempotency guard.
  let resolvedName = args.name;
  const existingId = await findExistingStyle(args.workspaceId, args.name);
  if (existingId) {
    if (!args.forceRename) {
      console.log(`[seed-doodle] style "${args.name}" already exists (id=${existingId}). Skipping. Re-run with --force-rename to add another copy.`);
      process.exit(0);
    }
    resolvedName = await resolveAvailableName(args.workspaceId, args.name);
    console.log(`[seed-doodle] name collision; using "${resolvedName}" instead.`);
  }

  // Pull the built-in's descriptor + mixing rules so the seeded style
  // is a true copy + refs, not a hand-typed approximation.
  const builtIn = BUILT_IN_STYLES.find((s) => s.id === 'doodle_explainer');
  if (!builtIn) {
    throw new Error('BUILT_IN_STYLES no longer contains "doodle_explainer" — seeder is out of sync');
  }

  // Create the style row. `draft = FALSE`, `approved_at = NOW()`, and
  // `version = 1` so it lands ready-to-use in the picker.
  // `preferred_cloud_model = nano-banana-2-i2i` — Gemini 3.1 Flash Image,
  // replaced the original NanoBanana Pro on 2026-05-24 (cheaper + 14 refs).
  const { rows: styleRows } = await sql<{ id: string }>`
    INSERT INTO production_doc_styles (
      workspace_id, name, description,
      ai_image_suffix, mixing_rules, allow_overlay_stock,
      based_on_built_in, created_by,
      owner_id, draft, approved_at, version,
      style_prompt, preferred_cloud_model
    ) VALUES (
      ${args.workspaceId}::uuid, ${resolvedName}, ${builtIn.description},
      ${builtIn.ai_image_suffix}, ${builtIn.mixing_rules ?? null}, ${builtIn.allow_overlay_stock},
      ${'doodle_explainer'}, ${args.ownerId},
      ${args.ownerId}, FALSE, NOW(), 1,
      NULL, ${'nano-banana-2-i2i'}
    )
    RETURNING id
  `;
  const styleId = styleRows[0]!.id;
  console.log(`[seed-doodle] created style id=${styleId} name="${resolvedName}"`);

  // Upload each PNG to R2 + insert the style_reference_images row.
  // content_validated = TRUE because the bytes come from our own
  // repo (we just magic-byte checked them); skip the post-upload
  // validate round-trip the user-upload path uses.
  const bucket = getImagesBucket();
  for (let position = 0; position < REF_FILENAMES.length; position++) {
    const filename = REF_FILENAMES[position]!;
    const { bytes, size, mimeType } = readRefBytes(filename);
    // Same key shape as the user-upload route — keeps the
    // orphan-sweeper happy and lets the same R2 lifecycle rules apply.
    const r2Key = `style-refs/${args.workspaceId}/${styleId}/seed-${position}-${filename}`;
    await uploadToBucket(bucket, r2Key, bytes, mimeType);
    console.log(`[seed-doodle]   uploaded ${filename} -> ${r2Key} (${size} bytes)`);
    await sql`
      INSERT INTO style_reference_images (
        style_id, workspace_id, position,
        r2_bucket, r2_key, mime_type, size_bytes,
        content_validated, content_validated_at
      ) VALUES (
        ${styleId}::uuid, ${args.workspaceId}::uuid, ${position},
        ${bucket}, ${r2Key}, ${mimeType}, ${size},
        TRUE, NOW()
      )
    `;
  }

  console.log(`[seed-doodle] done — ${REF_FILENAMES.length} refs attached, style ready in picker.`);
  // Don't bump version after seed — version=1 captures the initial
  // "this is what the style is" snapshot; user edits should drive
  // subsequent bumps.
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-doodle] FAILED:', err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
  });
