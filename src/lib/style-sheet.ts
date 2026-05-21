/**
 * Pure helpers for Phase 7 — per-doc style sheet (visual consistency v2).
 *
 * The style sheet is one image generated at doc init that every per-row
 * shot chains against via img-to-img at moderate denoise. Two layout
 * variants depending on whether the show has a recurring protagonist.
 *
 * See `_plans/2026-05-21-phase-7-style-sheet.md`.
 */

export type StyleSheetModel = 'flux-schnell-local' | 'qwen-image-local';

/** Maximum number of characters we'll forward into the diffusion prompt
 *  for the user's free-text style description. Keeps the leading directive
 *  from crowding out the actual scene prompt at downstream consumers. */
const STYLE_PROMPT_MAX_CHARS = 600;

/** Long-form YouTube canvas defaults (1920×1080) for no-protagonist sheets.
 *  Protagonist sheets use a square 1024×1024 grid so all four poses get
 *  roughly equal area. */
export const PROTAGONIST_SHEET_DIMENSIONS = { width: 1024, height: 1024 } as const;
export const SCENE_SHEET_DIMENSIONS = { width: 1920, height: 1080 } as const;

export interface BuildSheetPromptInput {
  /** The doc's resolved style suffix (palette, line-weight, render style)
   *  — same string that gets appended to every per-row prompt. */
  stylePrompt: string;
  /** True ⇒ build a 2×2 protagonist grid prompt; false ⇒ full-scene swatch. */
  hasProtagonist: boolean;
  /** Optional user-provided context (e.g. "lead character is a red-headed
   *  engineer in a green hoodie"). Sanitised + capped before injection. */
  protagonistDescription?: string;
}

/** Build the full diffusion prompt for the style sheet. Pure — no I/O. */
export function buildSheetPrompt(input: BuildSheetPromptInput): string {
  const style = (input.stylePrompt ?? '').trim().slice(0, STYLE_PROMPT_MAX_CHARS);
  if (input.hasProtagonist) {
    const desc = (input.protagonistDescription ?? '').trim().slice(0, 200);
    // Layout directive uses scene-description language (not imperatives)
    // because diffusion models render directives verbatim — same lesson
    // from the OST safe-top fix in the production-doc image route.
    const protagonistClause = desc
      ? `The same character — described as ${desc} — appears in three poses (front view, three-quarter view, profile view). `
      : 'A single recurring protagonist character appears in three poses (front view, three-quarter view, profile view). ';
    return [
      'A character reference sheet composed as a 2×2 grid on a clean neutral background.',
      protagonistClause + 'The fourth tile shows a horizontal color palette swatch with five sample colors.',
      style ? `Style: ${style}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  // No-protagonist: a single hero scene that establishes palette + level of
  // detail without a character. The downstream i2i chain will pick up the
  // style from this image even though no character is present.
  return [
    'A wide establishing scene that demonstrates the visual style of the production.',
    'No characters or people in the frame. The composition shows the palette, line weight, and level of detail clearly.',
    style ? `Style: ${style}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface SheetReferenceInputDoc {
  style_sheet_url?: string | null;
  style_sheet_description?: string | null;
}

export interface SheetReferenceInputRow {
  style_sheet_skip?: boolean | null;
}

export interface ResolvedSheetReference {
  /** URL to feed into the local i2i chain. `undefined` ⇒ this row generates
   *  via t2i (no chaining). */
  referenceImageUrl: string | undefined;
  /** Short text description appended to cloud-Kie prompts as a fallback
   *  for chaining. `undefined` ⇒ no description to inject. */
  styleSheetDescription: string | undefined;
}

/** Resolve a row's effective sheet reference: returns the doc's sheet URL
 *  unless the row opts out via `style_sheet_skip`. Pure. */
export function resolveSheetReference(
  row: SheetReferenceInputRow,
  doc: SheetReferenceInputDoc,
): ResolvedSheetReference {
  if (row.style_sheet_skip === true) {
    return { referenceImageUrl: undefined, styleSheetDescription: undefined };
  }
  const url = doc.style_sheet_url?.trim() || undefined;
  const desc = doc.style_sheet_description?.trim() || undefined;
  return { referenceImageUrl: url, styleSheetDescription: desc };
}
