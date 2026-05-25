/**
 * Google Cloud credential loading.
 *
 * Reads `GOOGLE_TTS_PROJECT_ID`, `GOOGLE_TTS_CLIENT_EMAIL`, and
 * `GOOGLE_TTS_PRIVATE_KEY` from process.env. Same service account is
 * reused across Cloud TTS + Cloud Speech-to-Text (both are roles on the
 * same GCP project), so there's one env trio, not two.
 *
 * The Vercel `\n` footgun
 * -----------------------
 * Vercel stores env vars verbatim. When you paste a service-account
 * `private_key` that contains literal newlines into the Vercel UI, it
 * stores them as the two-character sequence `\n`. The Google SDK needs
 * real newlines. So at read time we must:
 *
 *     privateKey.replace(/\\n/g, '\n')
 *
 * This silently works in `npm run dev` (your local .env has real
 * newlines) and silently fails in Vercel preview deploys (cryptic JWT
 * signing errors). Every Google-on-Vercel project hits this; the fix is
 * in `loadGoogleCredentials()` below, plus a self-check log at boot via
 * `assertGoogleCredentialsValid()` so a misconfigured deploy fails loud
 * the first time the Google provider is touched.
 */

import { logger } from '../logger';

export interface GoogleCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

let cached: GoogleCredentials | null = null;
let logged = false;

/**
 * Read + normalize Google credentials from env. Returns null when any
 * of the three vars is missing — callers (the dispatcher, the picker
 * UI) treat absence as "Google is not configured" and hide the
 * provider without crashing.
 */
export function loadGoogleCredentials(): GoogleCredentials | null {
  if (cached) return cached;

  const projectId = process.env.GOOGLE_TTS_PROJECT_ID;
  const clientEmail = process.env.GOOGLE_TTS_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_TTS_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawKey) {
    if (!logged) {
      logger.info('[tts boot] google credentials not configured', {
        hasProjectId: Boolean(projectId),
        hasClientEmail: Boolean(clientEmail),
        hasPrivateKey: Boolean(rawKey),
      });
      logged = true;
    }
    return null;
  }

  // The newline normalization — the entire reason this file exists.
  const privateKey = rawKey.replace(/\\n/g, '\n');

  cached = { projectId, clientEmail, privateKey };

  if (!logged) {
    logger.info('[tts boot] google credentials loaded', {
      projectId,
      clientEmailMasked: maskEmail(clientEmail),
      privateKeyValid: privateKey.includes('BEGIN PRIVATE KEY'),
      privateKeyLength: privateKey.length,
    });
    logged = true;
  }

  return cached;
}

/**
 * Strict variant — throws a clear, user-actionable error if any var is
 * missing or malformed. Called from the Google provider/aligner on
 * first synthesize/align attempt so the failure surfaces in the API
 * response with the actual misconfiguration named, not a JWT-internals
 * error.
 */
export function assertGoogleCredentialsValid(): GoogleCredentials {
  const creds = loadGoogleCredentials();
  if (!creds) {
    throw new Error(
      'Google TTS is not configured. Set GOOGLE_TTS_PROJECT_ID, ' +
        'GOOGLE_TTS_CLIENT_EMAIL, and GOOGLE_TTS_PRIVATE_KEY in the ' +
        'environment. See _plans/2026-05-25-google-tts-voiceover-provider.md.',
    );
  }
  if (!creds.privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error(
      'GOOGLE_TTS_PRIVATE_KEY is set but does not look like a PEM key. ' +
        "Verify the env var preserves newlines — Vercel stores them as '\\n' " +
        'which this loader converts at read time. If you pasted the key ' +
        "into Vercel's UI, make sure the leading '-----BEGIN PRIVATE KEY-----' " +
        "line is intact.",
    );
  }
  return creds;
}

/**
 * For test isolation — drop the cached credentials so a test can mutate
 * process.env and re-read. Never call from production code.
 */
export function __resetGoogleCredentialsCacheForTests(): void {
  cached = null;
  logged = false;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '<malformed>';
  const head = local.slice(0, 3);
  return `${head}***@${domain}`;
}
