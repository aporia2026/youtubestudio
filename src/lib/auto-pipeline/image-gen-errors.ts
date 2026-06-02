/**
 * Image-generation error classification + retry budgets.
 *
 * Phase 2 of `_plans/2026-06-03-production-doc-flow-stabilization.md`.
 *
 * Before this module, every image generator in
 * `production-doc-image-gen.ts` and `generate-production-doc-images.ts`
 * caught errors as opaque strings, logged them, and left the row's
 * `image_url` empty. The stage handler treated "row has no image_url"
 * as "still pending" and re-entered itself indefinitely until the
 * `$10` cost cap kicked in. The user saw blank rows with no error
 * surface and no way to recover except deleting the doc.
 *
 * This module is the foundation for the fix:
 *
 *   - `classifyImageGenError(unknown) → { class, message }` reads a
 *     thrown error (or a returned `{ error: string }` shape) and maps
 *     it to one of eleven named categories. The categories are not
 *     marketing copy — they drive different retry budgets and
 *     different UI affordances.
 *
 *   - `RETRY_BUDGETS[class] → number` is the maximum number of
 *     attempts per error class. content_policy / reference_rejected
 *     get 1 (re-running the same prompt against the same model won't
 *     change the answer); timeout gets 3 (transient). The stage
 *     handler reads this map to decide "retry vs. give up."
 *
 *   - `sanitizeErrorMessage(string) → string` scrubs the four leak
 *     patterns we've seen surface from the underlying providers:
 *     bearer tokens, file system paths, customer IDs in URLs, and
 *     internal-only fields names. Output is safe to render in a chip
 *     and to ship to the client. Rule 13 (security) makes this
 *     non-optional.
 *
 * Pure: no IO, no logger, no React. Imported by the stage handler AND
 * by the production-doc page's row UI (the chip needs the category to
 * pick its tone/label). Tested in `tests/image-gen-errors.test.ts`.
 */

// ─── Types ──────────────────────────────────────────────────────────

/** Same string union as `ProductionRow.last_error.class` in
 *  `@/remotion/utils.ts` — kept here as the source of truth so the
 *  classifier and the schema can't drift. The page-level inline
 *  mirror in `production-doc/page.tsx` also references the same set
 *  per AGENTS.md. */
export type ImageGenErrorClass =
  | 'content_policy'
  | 'reference_rejected'
  | 'model_rejected'
  | 'blank_output'
  | 'timeout'
  | 'invalid_prompt'
  | 'no_refs'
  | 'source_missing'
  | 'killed'
  | 'validation_failed'
  | 'unknown';

export interface ClassifiedImageGenError {
  class: ImageGenErrorClass;
  message: string;
}

// ─── Retry budgets ──────────────────────────────────────────────────

/**
 * Maximum number of attempts per error class before the circuit
 * breaker in `stillRemaining()` treats the row as done and the UI
 * surfaces a chip + Retry button. Tuning rationale:
 *
 *   - content_policy / reference_rejected / invalid_prompt /
 *     killed / validation_failed: **1**. These are deterministic —
 *     the same prompt against the same model will fail the same
 *     way. Burning retries here costs money and delays the failure
 *     surface for the user.
 *
 *   - no_refs / source_missing: **1**. Config / sequencing problem.
 *     Source-missing rows pick up automatically on the next tick
 *     when the source generates, separate from the retry budget;
 *     the budget only matters when the source is permanently
 *     broken.
 *
 *   - model_rejected / blank_output / unknown: **2**. Could be
 *     transient (rate limit, model hiccup) or permanent (prompt
 *     model can't render). Two shots gives the transient case a
 *     fair chance without grinding on permanent failures.
 *
 *   - timeout: **3**. Most likely to be transient (network blip,
 *     Vercel cold start, provider load). Worth the extra attempt.
 *
 * Sums to a worst-case of `3 attempts × 8 rows/tick × N ticks` —
 * still bounded by the existing `PIPELINE_IMAGE_GEN_CAP_USD` cost
 * cap, just much tighter.
 */
export const RETRY_BUDGETS: Record<ImageGenErrorClass, number> = {
  content_policy: 1,
  reference_rejected: 1,
  invalid_prompt: 1,
  killed: 1,
  validation_failed: 1,
  no_refs: 1,
  source_missing: 1,
  model_rejected: 2,
  blank_output: 2,
  unknown: 2,
  timeout: 3,
};

// ─── Classifier ─────────────────────────────────────────────────────

/**
 * Read the message of a thrown Error / returned error string and map
 * it to one of the eleven categories above. Falls back to `unknown`
 * with the sanitized raw message attached.
 *
 * Match order matters: more specific patterns first (e.g.
 * `reference_rejected:` comes before generic `atlas-edit-failed`)
 * so a single failure that hits multiple signals lands on the most
 * actionable category.
 *
 * Always returns a `message` — never empty — so the UI chip has
 * something to render.
 */
export function classifyImageGenError(err: unknown): ClassifiedImageGenError {
  const raw = extractMessage(err);
  const lower = raw.toLowerCase();

  // ── Content policy: model refused on safety / policy grounds ─────
  // Common: OpenAI/Atlas returns "content_policy_violation",
  // "safety system", "violates our usage policies".
  if (
    /content[_\s-]?polic(y|ies)/i.test(raw) ||
    /safety[_\s-]?(system|filter)/i.test(raw) ||
    /violat(es|ed|ion)/i.test(raw) ||
    /policy_violation/i.test(raw)
  ) {
    return {
      class: 'content_policy',
      message: sanitizeErrorMessage(
        raw || 'The image model refused this prompt on policy grounds.',
      ),
    };
  }

  // ── Reference rejected: Atlas filters out a ref image (NSFW / copy) —
  // ReferenceRejectedError class + the `reference_rejected:` prefix
  // emitted by production-doc-image-gen on rethrow.
  if (
    /reference[_\s-]?rejected/i.test(raw) ||
    /ReferenceRejectedError/.test(raw) ||
    /ref(erence)?[_\s]?image[_\s]?(rejected|filtered|blocked)/i.test(raw)
  ) {
    return {
      class: 'reference_rejected',
      message: sanitizeErrorMessage(
        raw || 'One of the style reference images was rejected.',
      ),
    };
  }

  // ── Invalid prompt: empty / missing prompt input ────────────────
  if (
    /empty[_\s-]?(ai[_\s-]?image[_\s-]?)?prompt/i.test(raw) ||
    /prompt[_\s-]?(missing|required|empty)/i.test(raw)
  ) {
    return {
      class: 'invalid_prompt',
      message: 'No prompt to send to the image model — the row is missing its visual brief.',
    };
  }

  // ── No refs: style requires refs and none are available ─────────
  if (/no[_\s-]?style[_\s-]?refs/i.test(raw) || /refs[_\s-]?available/i.test(raw)) {
    return {
      class: 'no_refs',
      message: 'This style needs reference images, but none are configured for this video.',
    };
  }

  // ── Source missing: variant source not generated yet ────────────
  if (/source[_\s-]?image[_\s-]?not[_\s-]?generated/i.test(raw)) {
    return {
      class: 'source_missing',
      message: "Waiting on the base image for this variant — it hasn't been generated yet.",
    };
  }

  // ── Killed: kill switch / settings disabled ─────────────────────
  if (/kill[_\s-]?switch/i.test(raw) || /settings[_\s-]?disabled/i.test(raw)) {
    return {
      class: 'killed',
      message: 'Generation is disabled for this row in your settings or by a kill-switch.',
    };
  }

  // ── Validation failed: malformed grid / panel prompts ───────────
  if (/validation[_\s-]?failed/i.test(raw) || /malformed[_\s-]?grid/i.test(raw)) {
    return {
      class: 'validation_failed',
      message: 'The motion-collage panel layout did not pass validation.',
    };
  }

  // ── Timeout: vercel function ceiling, provider timeout, fetch ───
  if (
    /timeout/i.test(raw) ||
    /timed[_\s-]?out/i.test(raw) ||
    /etimedout/i.test(raw) ||
    /deadline[_\s-]?exceeded/i.test(raw) ||
    /504/.test(raw)
  ) {
    return {
      class: 'timeout',
      message: 'The image model took too long to respond.',
    };
  }

  // ── Blank output: model returned blank / null / corrupt image ───
  if (
    /blank[_\s-]?(output|image)/i.test(raw) ||
    /empty[_\s-]?response/i.test(raw) ||
    /null[_\s-]?image/i.test(raw) ||
    /no[_\s-]?image[_\s-]?returned/i.test(raw)
  ) {
    return {
      class: 'blank_output',
      message: 'The image model returned a blank or unreadable image.',
    };
  }

  // ── Model rejected (catch-all for atlas-edit-failed / gpt2-edit-failed) ─
  // Match the generic provider-failure prefixes our pipeline emits.
  if (
    /atlas[_\s-]?edit[_\s-]?failed/i.test(raw) ||
    /gpt2?[_\s-]?edit[_\s-]?failed/i.test(raw) ||
    /image[_\s-]?(gen|generation)[_\s-]?failed/i.test(raw) ||
    /model[_\s-]?(rejected|error)/i.test(raw) ||
    lower.includes('400') ||
    lower.includes('422') ||
    lower.includes('500') ||
    lower.includes('503')
  ) {
    return {
      class: 'model_rejected',
      message: sanitizeErrorMessage(raw || 'The image model rejected the request.'),
    };
  }

  // ── Fallback ────────────────────────────────────────────────────
  return {
    class: 'unknown',
    message: sanitizeErrorMessage(raw || 'Image generation failed with an unrecognised error.'),
  };
}

// ─── Sanitization (rule 13: don't leak credentials / PII / paths) ──

/**
 * Scrub a raw error string before showing it to the user OR before
 * persisting it to the doc (which is then served back to other tabs).
 *
 * Patterns scrubbed:
 *
 *   1. Bearer tokens — `Bearer <hex>` / `Bearer <base64>`.
 *   2. API key formats — `sk-…`, `pk-…`, `key_…`, generic
 *      40-char-hex sequences.
 *   3. Local file system paths — `/Users/<x>`, `/home/<x>`,
 *      `C:\Users\<x>`, etc.
 *   4. URLs containing customer IDs — `r2.cloudflarestorage.com/<id>/…`,
 *      `s3.amazonaws.com/<bucket>/…`.
 *
 * Caps the result at 240 chars so the chip's tooltip stays readable
 * even when the original message is multi-paragraph.
 */
export function sanitizeErrorMessage(raw: string): string {
  if (!raw) return '';
  let s = raw;
  // Bearer tokens & cookies.
  s = s.replace(/Bearer\s+[\w.\-+/=]+/gi, 'Bearer ***');
  s = s.replace(/cookie[:=]\s*[^;\s]+/gi, 'cookie=***');
  // API-key shapes.
  s = s.replace(/\b(sk|pk|key)[-_][A-Za-z0-9-_]{16,}\b/g, '$1-***');
  s = s.replace(/\b[A-Fa-f0-9]{40,}\b/g, '***');
  // File system paths.
  s = s.replace(/(\/Users\/|\/home\/|C:\\Users\\)[^\s"',:;]+/g, '$1***');
  // Storage URLs with customer ids.
  s = s.replace(
    /(https?:\/\/[^\s/]+\.(r2\.cloudflarestorage|amazonaws|backblazeb2)\.com\/)[^\s"',]+/g,
    '$1***',
  );
  // Cap length so chip tooltip stays readable.
  if (s.length > 240) s = s.slice(0, 237) + '...';
  return s.trim();
}

// ─── Helpers ────────────────────────────────────────────────────────

function extractMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const obj = err as { message?: unknown; error?: unknown; toString?: () => string };
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
    try {
      const s = String(err);
      if (s && s !== '[object Object]') return s;
      return JSON.stringify(err);
    } catch {
      return '';
    }
  }
  return String(err);
}

// ─── User-facing labels (PR2 row chip) ─────────────────────────────

/**
 * Short user-friendly label for an error class — drives the chip text
 * shown on rows where the auto-pipeline gave up. Kept terse (one or
 * two words) so the chip fits inside the image cell on the grid view
 * without wrapping. Full sanitized `message` still surfaces in the
 * chip's tooltip via the `title` attribute.
 */
export const ERROR_CLASS_LABELS: Record<ImageGenErrorClass, string> = {
  content_policy: 'Content policy',
  reference_rejected: 'Ref rejected',
  model_rejected: 'Model error',
  blank_output: 'Blank output',
  timeout: 'Timed out',
  invalid_prompt: 'No prompt',
  no_refs: 'No style refs',
  source_missing: 'Source missing',
  killed: 'Disabled',
  validation_failed: 'Invalid setup',
  unknown: 'Failed',
};

export function labelForErrorClass(cls: string): string {
  return (ERROR_CLASS_LABELS as Record<string, string>)[cls] ?? 'Failed';
}

// ─── Convenience: budget check ──────────────────────────────────────

/**
 * Returns true when a row has consumed its budget for the given error
 * class and should be skipped by the next tick's plan. Used by both
 * the circuit-breaker in the stage handler AND by the UI to decide
 * whether to render the chip vs. the spinner.
 */
export function isExhausted(
  attempts: number | undefined,
  errorClass: ImageGenErrorClass,
): boolean {
  const budget = RETRY_BUDGETS[errorClass];
  return (attempts ?? 0) >= budget;
}
