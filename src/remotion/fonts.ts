/**
 * Font loading for Remotion compositions.
 *
 * Without this, text falls back to whatever system font happens to be
 * installed on the render machine — meaning Studio preview on macOS,
 * /api/render on Linux (Vercel), and Lambda all render the same shot
 * with different typography. Loading via `@remotion/google-fonts`
 * guarantees every curated family is available on every platform and
 * gates the first frame on each font being ready via `delayRender`.
 *
 * Imported as a side-effect from Root.tsx — do not remove that import.
 *
 * Pure registry data (FONT_REGISTRY, ALLOWED_FONT_FAMILIES, FontFamilyName,
 * resolveFontStack, plus the canonical *_FAMILY constants) lives in
 * `./fonts-registry`. Server-only code paths import from there to avoid
 * dragging Remotion into Node page-data collection (which would crash
 * with "React.createContext is undefined"). Render-side and client
 * components can keep importing from this module — everything from
 * the registry is re-exported below.
 *
 * Available weights per family were verified against the installed
 * `@remotion/google-fonts` package on 2026-05-14; single-weight
 * families (Patrick Hand, Anton, Bebas Neue, Archivo Black) ship only
 * `400` upstream, so loading anything else would throw at boot.
 */
import { delayRender, continueRender } from 'remotion';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadPatrickHand } from '@remotion/google-fonts/PatrickHand';
import { loadFont as loadAnton } from '@remotion/google-fonts/Anton';
import { loadFont as loadBebasNeue } from '@remotion/google-fonts/BebasNeue';
import { loadFont as loadArchivoBlack } from '@remotion/google-fonts/ArchivoBlack';
import { loadFont as loadCaveat } from '@remotion/google-fonts/Caveat';
import { loadFont as loadSourceSerif4 } from '@remotion/google-fonts/SourceSerif4';
import { loadFont as loadJetBrainsMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadLilitaOne } from '@remotion/google-fonts/LilitaOne';

export {
  INTER_FAMILY,
  PATRICK_HAND_FAMILY,
  ANTON_FAMILY,
  BEBAS_NEUE_FAMILY,
  ARCHIVO_BLACK_FAMILY,
  CAVEAT_FAMILY,
  SOURCE_SERIF_4_FAMILY,
  JETBRAINS_MONO_FAMILY,
  LILITA_ONE_FAMILY,
  FONT_REGISTRY,
  ALLOWED_FONT_FAMILIES,
  resolveFontStack,
  type FontFamilyName,
} from './fonts-registry';

/**
 * Load a Google Font behind a single `delayRender` handle.
 *
 * Failure path is deliberate: log + `continueRender` (not `cancelRender`)
 * so a Google CDN hiccup degrades to system fonts rather than killing
 * the render entirely. Typography is a soft dependency.
 */
function loadGated<T extends { waitUntilDone: () => Promise<unknown> }>(
  label: string,
  result: T,
): void {
  const handle = delayRender(`Loading ${label}`);
  result
    .waitUntilDone()
    .then(() => continueRender(handle))
    .catch((err) => {
      console.error(`[remotion] ${label} font failed to load:`, err);
      continueRender(handle);
    });
}

// ─── Inter (body + UI default) ────────────────────────────────────────────────

loadGated(
  'Inter',
  loadInter('normal', {
    weights: ['400', '500', '600', '700', '800', '900'],
    subsets: ['latin'],
  }),
);

// ─── Patrick Hand (whiteboard-style section title stripe) ─────────────────────
//
// Patrick Hand ships only weight 400 — the friendly hand-drawn rendering is
// the point, no need for other weights.

loadGated(
  'Patrick Hand',
  loadPatrickHand('normal', { weights: ['400'], subsets: ['latin'] }),
);

// ─── Anton (bold ultra-condensed for thumbnail-style titles) ──────────────────

loadGated(
  'Anton',
  loadAnton('normal', { weights: ['400'], subsets: ['latin'] }),
);

// ─── Bebas Neue (tall narrow caps, alternative bold title) ────────────────────

loadGated(
  'Bebas Neue',
  loadBebasNeue('normal', { weights: ['400'], subsets: ['latin'] }),
);

// ─── Archivo Black (heavy sans-serif title for stat cards) ────────────────────

loadGated(
  'Archivo Black',
  loadArchivoBlack('normal', { weights: ['400'], subsets: ['latin'] }),
);

// ─── Caveat (casual handwritten alternative to Patrick Hand) ──────────────────

loadGated(
  'Caveat',
  loadCaveat('normal', { weights: ['400', '700'], subsets: ['latin'] }),
);

// ─── Source Serif 4 (editorial body for documentary-style content) ────────────

loadGated(
  'Source Serif 4',
  loadSourceSerif4('normal', { weights: ['400', '700'], subsets: ['latin'] }),
);

// ─── JetBrains Mono (code blocks, terminal-style on-screen text) ──────────────

loadGated(
  'JetBrains Mono',
  loadJetBrainsMono('normal', { weights: ['400', '700'], subsets: ['latin'] }),
);

// ─── Lilita One (chunky rounded display for the doodle_explainer_2 ──────────
// yellow-bubble on-screen text treatment — single weight upstream).

loadGated(
  'Lilita One',
  loadLilitaOne('normal', { weights: ['400'], subsets: ['latin'] }),
);
