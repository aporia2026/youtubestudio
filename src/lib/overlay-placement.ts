/**
 * Overlay placement resolver — Layer 1 of the overlay-blending plan
 * (see `_plans/2026-05-17-section-title-letterbox-and-overlay-blending.md`).
 *
 * Takes the LLM's preferred overlay zone + size, the saliency map of
 * the row's image, and whether the row has a section title, and returns
 * the **final** zone + size the renderer should use.
 *
 * The LLM picks zones blind — it never sees the image, so it sometimes
 * lands the overlay on top of focal content. This resolver lets the
 * image's own pixel data correct that choice:
 *
 *   1. Build the set of allowed zones (excludes top zones when the row
 *      has a section title in `overlay` layout — the stripe sits there).
 *   2. Score each allowed zone by the *emptiness* of its saliency cell
 *      (1 - busyness), with a bonus for zones near the LLM's pick so
 *      we honor intent when there's no good reason to override.
 *   3. Pick the top-scoring zone. If its cell is still pretty busy,
 *      shrink the overlay one size tier so it occupies less of the cell.
 *
 * Pure function — unit-testable, no I/O.
 */

import type {
  ImageSaliencyMap,
  OverlaySize,
  OverlayZone,
} from '@/remotion/utils';
import { zoneToSaliencyIndex } from '@/remotion/utils';

const ALL_ZONES: OverlayZone[] = [
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
  'center-top', 'center-bottom', 'left-center', 'right-center',
];

/** Zones whose anchor pixel falls in the top half of the frame. These
 *  are forbidden when a section-title stripe is rendered on top in
 *  `overlay` layout (it would land on or beside the stripe). */
const TOP_ZONES: ReadonlySet<OverlayZone> = new Set<OverlayZone>([
  'top-left', 'top-right', 'center-top',
]);

/** Squared Euclidean distance between two zones in the 3×3 conceptual
 *  layout (cols: left/center/right, rows: top/center/bottom). Used to
 *  bias the resolver toward the LLM's intent when scores are close. */
function zoneCoords(z: OverlayZone): { col: 0 | 1 | 2; row: 0 | 1 | 2 } {
  switch (z) {
    case 'top-left':      return { col: 0, row: 0 };
    case 'center-top':    return { col: 1, row: 0 };
    case 'top-right':     return { col: 2, row: 0 };
    case 'left-center':   return { col: 0, row: 1 };
    case 'right-center':  return { col: 2, row: 1 };
    case 'bottom-left':   return { col: 0, row: 2 };
    case 'center-bottom': return { col: 1, row: 2 };
    case 'bottom-right':  return { col: 2, row: 2 };
  }
}

function zoneDistance(a: OverlayZone, b: OverlayZone): number {
  const ac = zoneCoords(a);
  const bc = zoneCoords(b);
  const dc = ac.col - bc.col;
  const dr = ac.row - bc.row;
  return dc * dc + dr * dr;
}

/** Size order; index 0 is smallest. */
const SIZE_ORDER: OverlaySize[] = ['small', 'medium', 'large'];

/** Cell busyness above this threshold triggers a size shrink. */
const BUSY_SHRINK_THRESHOLD = 0.55;

export interface OverlayPlacementInput {
  llmZone: OverlayZone | undefined;
  llmSize: OverlaySize | undefined;
  saliency: ImageSaliencyMap | undefined;
  hasSectionTitle: boolean;
  /** When `true`, the row will render with `section_title_layout === 'overlay'`,
   *  so top zones must be excluded. In letterbox mode the stripe doesn't
   *  intrude on the scene area, so top zones remain usable.
   *  Treated as `true` when undefined (safer default).  */
  stripeOverlapsScene: boolean;
}

export interface OverlayPlacementOutput {
  zone: OverlayZone | undefined;
  size: OverlaySize | undefined;
  /** Telemetry: how the resolver arrived at this placement. */
  reason:
    | 'no-llm-zone'
    | 'no-saliency'
    | 'llm-zone-empty'
    | 'llm-zone-busy-fallback'
    | 'stripe-forbidden-fallback';
}

/** Pure resolver — no I/O, no logging. Caller logs the reason. */
export function resolveOverlayPlacement(
  input: OverlayPlacementInput,
): OverlayPlacementOutput {
  const { llmZone, llmSize, saliency, hasSectionTitle, stripeOverlapsScene } = input;

  if (!llmZone) {
    return { zone: undefined, size: undefined, reason: 'no-llm-zone' };
  }

  const forbidsTop = hasSectionTitle && stripeOverlapsScene;
  const allowed = ALL_ZONES.filter((z) => !forbidsTop || !TOP_ZONES.has(z));

  // No saliency yet — honor the LLM zone, but still apply the stripe guard.
  if (!saliency) {
    const zone = forbidsTop && TOP_ZONES.has(llmZone)
      ? nearestAllowed(llmZone, allowed)
      : llmZone;
    return {
      zone,
      size: llmSize,
      reason: forbidsTop && TOP_ZONES.has(llmZone)
        ? 'stripe-forbidden-fallback'
        : 'no-saliency',
    };
  }

  // Score each allowed zone:  emptiness (0..1) - 0.08 * distanceFromLLM.
  // The penalty is small enough that the LLM's choice wins when scores
  // are close, but a clearly emptier far cell can still override.
  const scored = allowed.map((z) => {
    const idx = zoneToSaliencyIndex(z, saliency);
    const busy = idx >= 0 ? saliency.busyness[idx] : 0.5;
    const emptiness = 1 - busy;
    const penalty = 0.08 * zoneDistance(z, llmZone);
    return { zone: z, emptiness, busy, score: emptiness - penalty };
  }).sort((a, b) => b.score - a.score);

  const winner = scored[0];
  const llmWasForbidden = forbidsTop && TOP_ZONES.has(llmZone);
  const winnerIsLlmZone = winner.zone === llmZone;

  let reason: OverlayPlacementOutput['reason'];
  if (llmWasForbidden) reason = 'stripe-forbidden-fallback';
  else if (winnerIsLlmZone) reason = 'llm-zone-empty';
  else reason = 'llm-zone-busy-fallback';

  // Size shrink: if the winning cell is still pretty busy, shrink one
  // size tier so the overlay occupies less of the busy cell. Caps at
  // 'small' — never shrink to nothing.
  let size = llmSize;
  if (size && winner.busy > BUSY_SHRINK_THRESHOLD) {
    const i = SIZE_ORDER.indexOf(size);
    if (i > 0) size = SIZE_ORDER[i - 1];
  }

  return { zone: winner.zone, size, reason };
}

function nearestAllowed(z: OverlayZone, allowed: OverlayZone[]): OverlayZone {
  let best = allowed[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const cand of allowed) {
    const d = zoneDistance(z, cand);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return best;
}
