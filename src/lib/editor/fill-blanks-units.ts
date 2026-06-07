/**
 * Editor "Fill blanks" / bulk-generate work-unit builder.
 *
 * The editor's `runFillBlanks` worker pulls work units off a queue. Each
 * unit is either:
 *   - `single`  — one row, generated through `/api/generate/production-doc/image`
 *                 (or, for variants, through the i2i edit endpoint — see
 *                 `EditorClient.tsx:generateOne`).
 *   - `collage` — four consecutive blanks bundled into one call to
 *                 `/api/generate/production-doc/collage`.
 *
 * Chunking rules (must match the inline implementation this helper
 * replaced, plus one new rule for variants):
 *
 *   1. `collageOn === false` ⇒ every blank is a single unit, in order.
 *   2. `collageOn === true`  ⇒ greedy chunk runs of 4 consecutive blanks.
 *      A row with `image_model` set to anything other than
 *      `docModelDefault` breaks the chunk so its per-row model override
 *      survives.
 *   3. NEW (2026-06-07): variant rows (`(row.variant_index ?? 0) > 0`)
 *      always emit as singles, even in collage mode. Variants need the
 *      i2i edit endpoint with the base image + edit prompt + style-
 *      preservation hint; bundling them through the multi-cell t2i
 *      collage endpoint would lose all three.
 *
 * Pure helper. No React, no fetches, no side effects. Unit-tested in
 * `tests/fill-blanks-units.test.ts`.
 */

import type { ProductionDoc } from '@/remotion/utils';

export type WorkUnit =
  | { kind: 'collage'; indices: number[] }
  | { kind: 'single'; index: number };

export interface BuildFillBlanksUnitsArgs {
  /** Row indices (in doc order) that need generation. The helper
   *  trusts this set — it does NOT re-check `rowImages` or row
   *  visibility. */
  blankIndices: readonly number[];
  /** Full row list, used to read each row's `image_model` override and
   *  `variant_index` for chunk decisions. */
  rows: readonly ProductionDoc['rows'][number][];
  /** Whether the doc has collage mode enabled. When false, every blank
   *  emits as a single regardless of consecutive runs. */
  collageOn: boolean;
  /** The doc-level default image model. A row whose `image_model` is
   *  set to anything else breaks the collage chunk so the override
   *  survives in the single path. `undefined` here means "server
   *  default", and ANY row override (even matching the server default)
   *  breaks the chunk because the helper can't compare against an
   *  unknown value. */
  docModelDefault: string | undefined;
}

export function buildFillBlanksUnits(args: BuildFillBlanksUnitsArgs): WorkUnit[] {
  const { blankIndices, rows, collageOn, docModelDefault } = args;
  const units: WorkUnit[] = [];

  if (!collageOn) {
    for (const idx of blankIndices) units.push({ kind: 'single', index: idx });
    return units;
  }

  let i = 0;
  while (i < blankIndices.length) {
    // Try to fill a chunk of 4. Each candidate must:
    //   - not have a per-row model override that differs from the doc
    //     default (which would force it into the single path), AND
    //   - not be a variant row (which needs i2i edit, not t2i collage).
    const chunkCandidate: number[] = [];
    let j = i;
    while (j < blankIndices.length && chunkCandidate.length < 4) {
      const rowIndex = blankIndices[j];
      const row = rows[rowIndex];
      const rowOverride = row?.image_model;
      if (rowOverride && rowOverride !== docModelDefault) break;
      if ((row?.variant_index ?? 0) > 0) break;
      chunkCandidate.push(rowIndex);
      j++;
    }
    if (chunkCandidate.length === 4) {
      units.push({ kind: 'collage', indices: chunkCandidate });
      i += 4;
    } else {
      // Partial chunk — emit the first as a single and try again from
      // i+1. Avoids stranding a shot at the start of what could have
      // been a chunk.
      units.push({ kind: 'single', index: blankIndices[i] });
      i += 1;
    }
  }

  return units;
}
