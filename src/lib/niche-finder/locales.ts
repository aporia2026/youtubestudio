/**
 * Niche-finder language + region allow-lists.
 *
 * Single source of truth used by:
 *   - the user-settings API route (validates incoming PUT bodies)
 *   - the NicheFinderLocalePicker UI (renders dropdown options)
 *   - the post-fetch language filter (decides when to apply script
 *     heuristics — `isLatinScriptLanguage` covers the same set).
 *
 * Keep the lists small and curated. Adding a language here switches
 * the picker on for it AND turns on the script heuristic when its
 * native script is Latin. Adding a region just affects YouTube's
 * `regionCode` parameter (no downstream filtering on region).
 */

export interface AllowedLanguage {
  /** ISO 639-1 code passed to YouTube's `relevanceLanguage` AND to
   *  the post-fetch language filter. */
  code: string;
  /** Display label in the picker. */
  label: string;
}

export interface AllowedRegion {
  /** ISO 3166-1 alpha-2 code passed to YouTube's `regionCode`. */
  code: string;
  /** Display label in the picker. */
  label: string;
}

/** Language defaults are tilted toward the operator's stated focus
 *  (English long-form). Spanish / French / German / Portuguese cover
 *  the next-largest YouTube markets; the rest fill out the major
 *  scripts so the operator can switch when researching cross-market. */
export const ALLOWED_LANGUAGES: readonly AllowedLanguage[] = Object.freeze([
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ar', label: 'Arabic' },
  { code: 'ru', label: 'Russian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'id', label: 'Indonesian' },
]);

/** Region defaults are the top YouTube markets by watch-time. Picker
 *  shows them in this order; adding more here is cheap (the value just
 *  passes through to YouTube as `regionCode`). */
export const ALLOWED_REGIONS: readonly AllowedRegion[] = Object.freeze([
  { code: 'US', label: 'United States' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'CA', label: 'Canada' },
  { code: 'AU', label: 'Australia' },
  { code: 'IE', label: 'Ireland' },
  { code: 'NZ', label: 'New Zealand' },
  { code: 'DE', label: 'Germany' },
  { code: 'FR', label: 'France' },
  { code: 'ES', label: 'Spain' },
  { code: 'IT', label: 'Italy' },
  { code: 'BR', label: 'Brazil' },
  { code: 'MX', label: 'Mexico' },
  { code: 'IN', label: 'India' },
  { code: 'JP', label: 'Japan' },
  { code: 'KR', label: 'South Korea' },
]);

export const DEFAULT_LANGUAGE = 'en';
export const DEFAULT_REGION = 'US';
