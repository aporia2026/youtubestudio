/**
 * Font loading for Remotion compositions.
 *
 * Without this, text falls back to whatever system font happens to be
 * installed on the render machine — meaning Studio preview on macOS,
 * /api/render on Linux (Vercel), and Lambda all render the same shot
 * with different typography. Loading via `@remotion/google-fonts`
 * guarantees Inter is available on every platform and gates the first
 * frame on the font being ready via `delayRender`.
 *
 * Imported as a side-effect from Root.tsx — do not remove that import.
 */
import { delayRender, continueRender } from 'remotion';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadPatrickHand } from '@remotion/google-fonts/PatrickHand';

// ─── Inter (body + UI default) ────────────────────────────────────────────────

const interHandle = delayRender('Loading Inter font');
const inter = loadInter('normal', {
  weights: ['400', '500', '600', '700', '800', '900'],
  subsets: ['latin'],
});
inter.waitUntilDone()
  .then(() => continueRender(interHandle))
  .catch((err) => {
    // Fall back to system fonts rather than hanging the render forever.
    // The frame will still render; only typography is degraded.
    console.error('[remotion] Inter font failed to load:', err);
    continueRender(interHandle);
  });
export const INTER_FAMILY = inter.fontFamily;

// ─── Patrick Hand (whiteboard-style section title stripe) ─────────────────────
//
// Patrick Hand ships only weight 400 — the friendly hand-drawn rendering is
// the point, no need for other weights.

const patrickHandle = delayRender('Loading Patrick Hand font');
const patrickHand = loadPatrickHand('normal', {
  weights: ['400'],
  subsets: ['latin'],
});
patrickHand.waitUntilDone()
  .then(() => continueRender(patrickHandle))
  .catch((err) => {
    console.error('[remotion] Patrick Hand font failed to load:', err);
    continueRender(patrickHandle);
  });
export const PATRICK_HAND_FAMILY = patrickHand.fontFamily;
