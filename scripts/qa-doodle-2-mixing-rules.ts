/**
 * Phase 3 QA harness for the 2026-05-28 doodle_explainer_2 authenticity round.
 *
 * Runs the LLM-only path of the production-doc pipeline against a short
 * real-life-story script and reports the new metrics added in Phase 2b:
 *
 *   - Variant-group ratio (target: ~40% of rows, acceptable 25-55%).
 *   - Overlay-stock-terms coverage (floor: ≥1 per 8-12 rows = ratio ≥0.08).
 *   - First 10 row prompts (eyeball for book / building / bloody painting bleed).
 *   - Sample overlay terms (eyeball that named entities triggered correctly).
 *   - The full generated doc JSON, saved to disk for deeper inspection.
 *
 * Does NOT touch the image-generation pipeline — that's a separate $$$ pass
 * the user runs through the UI for visual verification.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/qa-doodle-2-mixing-rules.ts
 *
 * Cost: ~$0.10-0.50 for one production-doc LLM call via the default chain
 * (gpt-5.4-mini → gpt-5.4 fallback per src/lib/ai-models.ts).
 *
 * Output: a verification report in stdout + the parsed doc JSON saved to
 *         _plans/2026-05-28-qa-doodle-2-run-<timestamp>.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { productionDocPrompt } from '../src/lib/prompts';
import { generateTextWithFallback } from '../src/lib/ai';
import { DEFAULT_FALLBACK_CHAINS } from '../src/lib/ai-models';
import { autoGroupVariants } from '../src/lib/auto-group-variants';
import { getBuiltInStyle } from '../src/lib/production-doc-styles';
import { extractJson } from '../src/lib/auto-pipeline/stages/generate-production-doc';
import {
  getEffectiveAiImageSuffix,
  getEffectiveMixingRules,
  isTrimmedSuffixEnabled,
} from '../src/lib/production-doc-flags';

// ─── Test script — Mary Celeste mystery, 1872 ────────────────────────────
// Chosen because:
//   • Real event with photographic record (period photographs of the ship
//     exist, named figures are documented) — exercises the realism pillar.
//   • Multiple named entities (Captain Benjamin Briggs, the Dei Gratia,
//     Genoa, the Atlantic) — exercises overlay_stock_terms.
//   • Natural variant-group opportunities (the ship discovered abandoned;
//     a held scene that can evolve through several beats).
//   • Period props worth naming specifically (brass sextant, lantern,
//     wooden hull, captain's log) — exercises the specific-named-props
//     pillar.
//   • Short enough (~180 words ≈ 80s at 135 wpm) that the LLM call costs
//     ~$0.20 and runs in ~30 seconds.

const TEST_SCRIPT = `
In December 1872, sailors aboard the Dei Gratia spotted something strange in the middle of the Atlantic Ocean. A two-masted brigantine, drifting under partial sail, with no one at the helm.

The ship was the Mary Celeste. She had left New York one month earlier, bound for Genoa, with Captain Benjamin Briggs, his wife, his two-year-old daughter, and a crew of seven on board.

When the Dei Gratia crew climbed aboard, they found an empty ship. No people, no signs of struggle, no blood. The cargo was untouched. The captain's log had been updated nine days earlier. A breakfast was still set on the galley table.

The lifeboat was missing. Briggs and everyone with him had vanished into the open sea.

Investigators in Gibraltar examined the ship and found nothing conclusive. Theories piled up. A waterspout. A mutiny. Pirates. Methane fumes from the cargo of industrial alcohol.

No bodies were ever recovered. The Mary Celeste was sold, refitted, and sailed for another twelve years before her new captain deliberately ran her aground off the coast of Haiti, in an attempt to commit insurance fraud.

What happened to the Briggs family remains one of the most enduring mysteries of the sea.
`.trim();

const NICHE = 'Mystery / historical true-story explainer';
const TOPIC = 'The Mary Celeste';

interface DocRow {
  ai_image_prompt?: string;
  group_id?: string;
  variant_index?: number;
  variant_edit_prompt?: string;
  overlay_stock_terms?: string;
  start_timecode?: string;
  narration?: string;
}

interface DocResult {
  rows?: DocRow[];
  [k: string]: unknown;
}

async function main(): Promise<void> {
  console.info('[qa-doodle-2] Phase 3 QA harness — starting');

  // 1) Resolve the doodle_explainer_2 style payload from the registry.
  const style = getBuiltInStyle('doodle_explainer_2');
  if (!style) throw new Error('doodle_explainer_2 not found in built-in styles');
  if (!style.mixing_rules) throw new Error('doodle_explainer_2 has no mixing_rules');

  // Resolve EFFECTIVE suffix + mixing_rules — honours the
  // USE_TRIMMED_SUFFIX flag the same way the production routes
  // (auto-pipeline stage + manual /api/generate/production-doc) do.
  // Without this, the harness was testing the full 32kB mixing_rules
  // while production used the 1.5-2kB trimmed version — wildly
  // different test surface. Default to "trimmed" if the env doesn't
  // explicitly set the flag, since that matches the production deploy
  // verified by the prompt suffix the user pasted on 2026-05-28.
  if (process.env.USE_TRIMMED_SUFFIX === undefined) {
    process.env.USE_TRIMMED_SUFFIX = '1';
  }
  const effectiveSuffix = getEffectiveAiImageSuffix({
    id: style.id,
    ai_image_suffix: style.ai_image_suffix ?? '',
  });
  const effectiveMixingRules = getEffectiveMixingRules({
    id: style.id,
    mixing_rules: style.mixing_rules,
  });

  console.info('[qa-doodle-2] style resolved', {
    id: style.id,
    label: style.label,
    trimmedFlag: isTrimmedSuffixEnabled(),
    aiImageSuffixCharsFull: style.ai_image_suffix?.length ?? 0,
    aiImageSuffixCharsEffective: effectiveSuffix.length,
    mixingRulesCharsFull: style.mixing_rules.length,
    mixingRulesCharsEffective: effectiveMixingRules?.length ?? 0,
    allowOverlayStock: style.allow_overlay_stock,
    refCount: style.built_in_refs?.length ?? 0,
  });

  // 2) Build the production-doc prompt with the EFFECTIVE rules.
  const { system, user } = productionDocPrompt({
    script: TEST_SCRIPT,
    niche: NICHE,
    topic: TOPIC,
    style: {
      id: style.id,
      label: style.label,
      ai_image_suffix: effectiveSuffix,
      mixing_rules: effectiveMixingRules ?? '',
      allow_overlay_stock: style.allow_overlay_stock ?? false,
    },
  });
  console.info('[qa-doodle-2] prompt built', {
    systemChars: system.length,
    userChars: user.length,
  });

  // 3) Call the LLM via the same chain the production-doc route uses.
  const chain = DEFAULT_FALLBACK_CHAINS['production-doc'];
  if (!chain || chain.length === 0) throw new Error('No production-doc chain configured');
  console.info('[qa-doodle-2] LLM chain', { chain });

  const t0 = Date.now();
  const llmResult = await generateTextWithFallback(chain, (modelId) => ({
    modelId,
    prompt: user,
    systemPrompt: system,
    temperature: 0.7,
    maxTokens: 16000,
  }));
  console.info('[qa-doodle-2] LLM returned', {
    modelUsed: llmResult.modelUsed,
    ms: Date.now() - t0,
    textChars: llmResult.text.length,
  });

  // 4) Robust JSON parse — matches the production-doc stage handler so
  //    preamble/postamble around the JSON doesn't break the harness.
  const parsed = extractJson(llmResult.text);
  if (parsed === null) {
    throw new Error('extractJson returned null — LLM output had no recoverable JSON');
  }
  const doc = parsed as DocResult;
  if (!Array.isArray(doc.rows)) throw new Error('Parsed JSON had no `rows` array');
  const rowsRaw = doc.rows;
  console.info('[qa-doodle-2] doc parsed', { rowCount: rowsRaw.length });

  // 5) Run the auto-grouper (same post-pass the API route runs).
  const grouped = autoGroupVariants(
    rowsRaw as unknown as Parameters<typeof autoGroupVariants>[0],
  );
  console.info('[qa-doodle-2] auto-group pass', {
    groupCount: grouped.groupCount,
    mergedRowCount: grouped.mergedRowCount,
  });

  // 6) Compute the verification metrics.
  const rows = rowsRaw;
  const totalRows = rows.length;
  const groupRows = rows.filter((r) => typeof r.group_id === 'string' && r.group_id.length > 0).length;
  const variantRatio = totalRows > 0 ? groupRows / totalRows : 0;

  const overlayRows = rows.filter(
    (r) => typeof r.overlay_stock_terms === 'string' && r.overlay_stock_terms.trim().length > 0,
  );
  const overlayRatio = totalRows > 0 ? overlayRows.length / totalRows : 0;

  // 7) Eyeball-friendly samples.
  const firstTenPrompts = rows.slice(0, 10).map((r, i) => ({
    i,
    group: r.group_id ? `${r.group_id}#${r.variant_index ?? '?'}` : '',
    prompt: (r.ai_image_prompt ?? r.variant_edit_prompt ?? '').slice(0, 180),
  }));
  const overlaySamples = overlayRows.slice(0, 10).map((r) => ({
    i: rows.indexOf(r),
    term: r.overlay_stock_terms ?? '',
  }));

  // 8) Bleed scan — does the LLM mention book / building / blood / forest
  //    in scenes where the script doesn't call for them? Cheap text-only
  //    proxy for the visual bleed problem we're trying to prevent.
  const bleedKeywords = ['book', 'building', 'bloody', 'blood drip', 'red blob', 'painting on wall', 'forest', 'trees'];
  const bleedHits: { rowIndex: number; keyword: string; promptSnippet: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const text = (rows[i].ai_image_prompt ?? '') + ' ' + (rows[i].variant_edit_prompt ?? '');
    const narration = rows[i].narration ?? '';
    const lowerText = text.toLowerCase();
    const lowerNarration = narration.toLowerCase();
    for (const kw of bleedKeywords) {
      // Only flag if the keyword is in the image prompt but NOT justified
      // by the narration (i.e. the LLM injected it without script support).
      if (lowerText.includes(kw) && !lowerNarration.includes(kw)) {
        bleedHits.push({
          rowIndex: i,
          keyword: kw,
          promptSnippet: text.slice(Math.max(0, lowerText.indexOf(kw) - 30), lowerText.indexOf(kw) + 80),
        });
      }
    }
  }

  // 9) Report.
  console.info('\n========== PHASE 3 QA REPORT ==========\n');
  console.info('Script:', TOPIC, `(${TEST_SCRIPT.split(/\s+/).length} words)`);
  console.info('Style: ', style.label, `(${style.id})`);
  console.info('Model: ', llmResult.modelUsed);
  console.info('Rows:  ', totalRows);
  console.info('');
  console.info('--- VARIANT GROUPS (target ratio 0.40, acceptable 0.25-0.55) ---');
  console.info('  Group rows:     ', groupRows, '/', totalRows);
  console.info('  Fresh rows:     ', totalRows - groupRows);
  console.info('  Ratio:          ', variantRatio.toFixed(3));
  console.info('  Within target:  ', variantRatio >= 0.25 && variantRatio <= 0.55 ? 'YES' : 'NO');
  console.info('  Auto-grouper added:', grouped.groupCount, 'groups (', grouped.mergedRowCount, 'rows)');
  console.info('');
  console.info('--- OVERLAY STOCK TERMS (floor ratio 0.08, ≥1 per 8-12 rows) ---');
  console.info('  Overlay rows:   ', overlayRows.length, '/', totalRows);
  console.info('  Ratio:          ', overlayRatio.toFixed(3));
  console.info('  Meets floor:    ', overlayRatio >= 0.08 ? 'YES' : 'NO');
  console.info('  Sample terms:');
  for (const s of overlaySamples) console.info('   ', `row ${s.i}:`, s.term);
  console.info('');
  console.info('--- BLEED SCAN (image prompts mentioning subject-coded keywords NOT in narration) ---');
  if (bleedHits.length === 0) {
    console.info('  No bleed keywords found in image prompts beyond what the script calls for. Clean.');
  } else {
    console.info('  Found', bleedHits.length, 'unjustified mentions:');
    for (const h of bleedHits) {
      console.info('   ', `row ${h.rowIndex}:`, `[${h.keyword}]`, '...', h.promptSnippet, '...');
    }
  }
  console.info('');
  console.info('--- FIRST 10 ROW PROMPTS (eyeball for visual bleed) ---');
  for (const r of firstTenPrompts) {
    console.info(`  row ${String(r.i).padStart(2)}`, r.group ? `[${r.group}]` : '         ', r.prompt);
  }
  console.info('');

  // 10) Save the full doc JSON for deeper inspection.
  const outDir = path.resolve(__dirname, '..', '_plans');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `2026-05-28-qa-doodle-2-run-${ts}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        script: TEST_SCRIPT,
        niche: NICHE,
        topic: TOPIC,
        styleId: style.id,
        modelUsed: llmResult.modelUsed,
        metrics: {
          totalRows,
          groupRows,
          variantRatio: Number(variantRatio.toFixed(3)),
          overlayRows: overlayRows.length,
          overlayRatio: Number(overlayRatio.toFixed(3)),
          autoGrouper: { groupCount: grouped.groupCount, mergedRowCount: grouped.mergedRowCount },
          bleedHits,
        },
        doc,
      },
      null,
      2,
    ),
  );
  console.info('Saved full doc to:', outPath);
  console.info('\n=======================================\n');
}

main().catch((e) => {
  console.error('[qa-doodle-2] FATAL:', e);
  process.exit(1);
});
