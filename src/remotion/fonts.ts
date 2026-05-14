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
 * Curated set (v1) covers the styles the production-doc-styles list
 * implies (Cinematic / 2D Animation / Documentary / Tech&SaaS /
 * Whiteboard / Viral / Doodle Explainer). New families plug in by
 * adding a load block below + a row in `FONT_REGISTRY`.
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

/**
 * Load a Google Font behind a single `delayRender` handle.
 *
 * Failure path is deliberate: log + `continueRender` (not `cancelRender`)
 * so a Google CDN hiccup degrades to system fonts rather than killing
 * the render entirely. Typography is a soft dependency.
 */
function loadGated<T extends { fontFamily: string; waitUntilDone: () => Promise<unknown> }>(
  label: string,
  result: T,
): string {
  const handle = delayRender(`Loading ${label}`);
  result
    .waitUntilDone()
    .then(() => continueRender(handle))
    .catch((err) => {
      console.error(`[remotion] ${label} font failed to load:`, err);
      continueRender(handle);
    });
  return result.fontFamily;
}

// ─── Inter (body + UI default) ────────────────────────────────────────────────

export const INTER_FAMILY = loadGated(
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

export const PATRICK_HAND_FAMILY = loadGated(
  'Patrick Hand',
  loadPatrickHand('normal', { weights: ['400'], subsets: ['latin'] }),
);

// ─── Anton (bold ultra-condensed for thumbnail-style titles) ──────────────────

export const ANTON_FAMILY = loadGated(
  'Anton',
  loadAnton('normal', { weights: ['400'], subsets: ['latin'] }),
);

// ─── Bebas Neue (tall narrow caps, alternative bold title) ────────────────────

export const BEBAS_NEUE_FAMILY = loadGated(
  'Bebas Neue',
  loadBebasNeue('normal', { weights: ['400'], subsets: ['latin'] }),
);

// ─── Archivo Black (heavy sans-serif title for stat cards) ────────────────────

export const ARCHIVO_BLACK_FAMILY = loadGated(
  'Archivo Black',
  loadArchivoBlack('normal', { weights: ['400'], subsets: ['latin'] }),
);

// ─── Caveat (casual handwritten alternative to Patrick Hand) ──────────────────

export const CAVEAT_FAMILY = loadGated(
  'Caveat',
  loadCaveat('normal', { weights: ['400', '700'], subsets: ['latin'] }),
);

// ─── Source Serif 4 (editorial body for documentary-style content) ────────────

export const SOURCE_SERIF_4_FAMILY = loadGated(
  'Source Serif 4',
  loadSourceSerif4('normal', { weights: ['400', '700'], subsets: ['latin'] }),
);

// ─── JetBrains Mono (code blocks, terminal-style on-screen text) ──────────────

export const JETBRAINS_MONO_FAMILY = loadGated(
  'JetBrains Mono',
  loadJetBrainsMono('normal', { weights: ['400', '700'], subsets: ['latin'] }),
);

// ─── Registry ─────────────────────────────────────────────────────────────────
//
// Single source of truth for which families are loadable + their fallback
// stack. Server-side validation (channel-visual-brand-kit) allowlists keys
// against this registry, so adding a font here is the one place needed.
//
// The fallback strings end with a generic family so a Google CDN hiccup
// (`continueRender` after `console.error` above) still produces legible
// typography rather than the browser default.

export const FONT_REGISTRY = {
  Inter: { fontFamily: INTER_FAMILY, fallback: `${INTER_FAMILY}, system-ui, sans-serif` },
  'Patrick Hand': { fontFamily: PATRICK_HAND_FAMILY, fallback: `${PATRICK_HAND_FAMILY}, "Comic Sans MS", cursive` },
  Anton: { fontFamily: ANTON_FAMILY, fallback: `${ANTON_FAMILY}, "Impact", sans-serif` },
  'Bebas Neue': { fontFamily: BEBAS_NEUE_FAMILY, fallback: `${BEBAS_NEUE_FAMILY}, "Impact", sans-serif` },
  'Archivo Black': { fontFamily: ARCHIVO_BLACK_FAMILY, fallback: `${ARCHIVO_BLACK_FAMILY}, system-ui, sans-serif` },
  Caveat: { fontFamily: CAVEAT_FAMILY, fallback: `${CAVEAT_FAMILY}, "Comic Sans MS", cursive` },
  'Source Serif 4': { fontFamily: SOURCE_SERIF_4_FAMILY, fallback: `${SOURCE_SERIF_4_FAMILY}, Georgia, serif` },
  'JetBrains Mono': { fontFamily: JETBRAINS_MONO_FAMILY, fallback: `${JETBRAINS_MONO_FAMILY}, "Courier New", monospace` },
} as const;

export type FontFamilyName = keyof typeof FONT_REGISTRY;

export const ALLOWED_FONT_FAMILIES = Object.keys(FONT_REGISTRY) as FontFamilyName[];

/**
 * Resolve a user-supplied font-family name to a CSS-ready fallback stack.
 * Unknown names fall through to Inter so a corrupt brand-kit row never
 * breaks a render — same defensive posture as the load-failure handler.
 */
export function resolveFontStack(name: string | undefined | null): string {
  if (typeof name === 'string' && name in FONT_REGISTRY) {
    return FONT_REGISTRY[name as FontFamilyName].fallback;
  }
  return FONT_REGISTRY.Inter.fallback;
}
