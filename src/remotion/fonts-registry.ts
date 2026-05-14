/**
 * Pure font registry — names, CSS fallback stacks, and the allowlist that
 * server-side validation (e.g. channel-visual-brand-kit) reads when
 * sanitizing user-supplied font keys.
 *
 * Deliberately free of Remotion imports. `fonts.ts` next door re-exports
 * everything here AND runs the `@remotion/google-fonts` side-effects that
 * register the fonts with the renderer. Splitting the two lets API
 * routes and other server code share the allowlist without dragging
 * Remotion (which needs `React.createContext`) into the Node page-data
 * collection step — a transitive import that, before this split,
 * crashed `next build` for any route under
 * `src/app/api/.../visual-brand-kit/route.ts`.
 *
 * Verified on 2026-05-14 that `@remotion/google-fonts/Inter` (and the
 * other curated families below) returns `{ fontFamily: 'Inter' }` etc.
 * — the literal family names baked in here match what the loader
 * registers at render time, so a render-time consumer of FONT_REGISTRY
 * sees the same string the browser font cache keys on.
 */

// ─── Canonical family names ───────────────────────────────────────────────────
//
// One literal per curated family. These are the names `@remotion/google-fonts`
// returns from `loadFont(...).fontFamily`; copying them here decouples the
// pure registry from the loader module.

export const INTER_FAMILY = 'Inter';
export const PATRICK_HAND_FAMILY = 'Patrick Hand';
export const ANTON_FAMILY = 'Anton';
export const BEBAS_NEUE_FAMILY = 'Bebas Neue';
export const ARCHIVO_BLACK_FAMILY = 'Archivo Black';
export const CAVEAT_FAMILY = 'Caveat';
export const SOURCE_SERIF_4_FAMILY = 'Source Serif 4';
export const JETBRAINS_MONO_FAMILY = 'JetBrains Mono';

// ─── Registry ─────────────────────────────────────────────────────────────────
//
// Single source of truth for which families are loadable + their fallback
// stack. Server-side validation (channel-visual-brand-kit) allowlists keys
// against this registry, so adding a font here is the one place needed.
//
// The fallback strings end with a generic family so a Google CDN hiccup
// (the loader's `continueRender` after `console.error` path) still
// produces legible typography rather than the browser default.

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
 * breaks a render — same defensive posture as the loader's
 * load-failure handler.
 */
export function resolveFontStack(name: string | undefined | null): string {
  if (typeof name === 'string' && name in FONT_REGISTRY) {
    return FONT_REGISTRY[name as FontFamilyName].fallback;
  }
  return FONT_REGISTRY.Inter.fallback;
}
