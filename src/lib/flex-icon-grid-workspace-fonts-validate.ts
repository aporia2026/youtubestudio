/**
 * Pure validation for Flex Icon Grid workspace-font registry input.
 *
 * Lives in its own module (separated from the CRUD lib) so vitest can
 * import the validator directly without dragging in `@vercel/postgres`.
 * Mirrors the shape of the sibling
 * `flex-icon-grid-saved-palettes-validate.ts` /
 * `flex-icon-grid-saved-templates-validate.ts`.
 *
 * Rules:
 *  - `name` is required, trimmed, non-empty, ≤60 chars.
 *  - `r2_key` is required AND must point at the flex-icon-grid font
 *    upload prefix so a poisoned client can't register an arbitrary
 *    R2 object.
 *  - `mime_type` is one of the allowed font MIME types (TTF/OTF/
 *    WOFF/WOFF2 + the application/octet-stream fallback some browsers
 *    send for .ttf).
 *  - `size_bytes` is a non-negative integer at most 5 MB.
 */

export interface WorkspaceFontInput {
  name: string;
  r2_key: string;
  mime_type: string;
  size_bytes: number;
}

export type ValidationResult =
  | { ok: true; value: WorkspaceFontInput }
  | { ok: false; reason: string };

const ALLOWED_MIME_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'application/octet-stream',
  'application/x-font-ttf',
  'application/x-font-opentype',
]);

const MAX_FONT_SIZE = 5 * 1024 * 1024;
const REQUIRED_KEY_PREFIX = 'thumbnails/flex-icon-grid-font/';

export function validateWorkspaceFontInput(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'request body must be an object' };
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return { ok: false, reason: 'name is required' };
  if (name.length > 60) return { ok: false, reason: 'name must be at most 60 characters' };
  const r2_key = typeof o.r2_key === 'string' ? o.r2_key : '';
  if (!r2_key) return { ok: false, reason: 'r2_key is required' };
  if (!r2_key.startsWith(REQUIRED_KEY_PREFIX)) {
    return { ok: false, reason: 'r2_key must point at the flex-icon-grid font upload prefix' };
  }
  const mime_type = typeof o.mime_type === 'string' ? o.mime_type : '';
  if (!ALLOWED_MIME_TYPES.has(mime_type)) {
    return { ok: false, reason: `unsupported mime_type: ${mime_type}` };
  }
  const size_bytes = typeof o.size_bytes === 'number' ? Math.floor(o.size_bytes) : -1;
  if (size_bytes < 0) return { ok: false, reason: 'size_bytes must be a non-negative integer' };
  if (size_bytes > MAX_FONT_SIZE) {
    return { ok: false, reason: 'size_bytes exceeds the 5MB limit' };
  }
  return { ok: true, value: { name, r2_key, mime_type, size_bytes } };
}
