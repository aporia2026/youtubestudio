/**
 * Client-safe dubbing constants. The orchestrator in `src/lib/dubbing.ts`
 * pulls in server-only modules (next/headers via ai.ts), so the language
 * list and type are extracted here so client components can import them
 * without dragging the whole pipeline into the browser bundle.
 *
 * The orchestrator re-exports these from dubbing.ts for server-side
 * convenience — single source of truth lives here.
 */

/** YouTube auto-dubbing supports these 8 as of 2026. We piggyback the same
 *  list so the user's dubbed audio matches what YouTube can natively serve.
 *  Format: ISO 639-1 base code, with a regional suffix where the source TTS
 *  / translation differentiates (Brazilian vs European Portuguese). */
export const SUPPORTED_LANGUAGES = [
  { code: 'es', label: 'Spanish' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ja', label: 'Japanese' },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['code'];

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

export function isSupportedLanguage(code: string): code is SupportedLanguage {
  return SUPPORTED_SET.has(code);
}
