import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Audit C6: previously this silently fell back to AUTH_SECRET when
 * ENCRYPTION_KEY was unset. That meant a session-token compromise
 * implicitly compromised every OAuth token at rest (they share the
 * key). The two should be independent.
 *
 * Hard-removing the fallback would break existing prod deployments
 * (every OAuth token would become unrecoverable). Compromise:
 *   - Prefer ENCRYPTION_KEY when set
 *   - Fall back to AUTH_SECRET WITH a one-time warning so ops can
 *     migrate (set ENCRYPTION_KEY=$AUTH_SECRET, then rotate AUTH_SECRET
 *     to a fresh value — encrypted data keeps decrypting until the
 *     ENCRYPTION_KEY is rotated separately)
 *   - Refuse if neither is set (unchanged from before)
 *
 * The warning fires once per process via the cached fallback flag.
 */
let warnedFallback = false;
function getKey(): Buffer {
  const explicit = process.env.ENCRYPTION_KEY;
  if (explicit) {
    return createHash('sha256').update(explicit).digest();
  }
  const fallback = process.env.AUTH_SECRET;
  if (fallback) {
    if (!warnedFallback) {
      // Emit a single line per process so log scrapers can alert on
      // it. Uses console.warn directly because importing the structured
      // logger would create a dependency cycle (logger imports nothing
      // crypto-related but several callers are early-init code paths).
      console.warn(
        'crypto: ENCRYPTION_KEY is unset — falling back to AUTH_SECRET. ' +
          'These should be independent secrets. Set ENCRYPTION_KEY=$AUTH_SECRET in your env to silence this warning, ' +
          'then rotate AUTH_SECRET to a fresh value (sessions re-issue on next login; OAuth tokens keep decrypting).',
      );
      warnedFallback = true;
    }
    return createHash('sha256').update(fallback).digest();
  }
  throw new Error('ENCRYPTION_KEY or AUTH_SECRET must be set');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: base64(iv + authTag + ciphertext)
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}
