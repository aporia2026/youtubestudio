import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadGoogleCredentials,
  assertGoogleCredentialsValid,
  __resetGoogleCredentialsCacheForTests,
} from '@/lib/tts/google-env';

// The Vercel `\n` footgun is the single most common Google-on-Vercel
// bug. Pinning the conversion behavior here so a regression in the env
// loader fails fast instead of silently breaking deploys.

const VALID_PEM_BODY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ==',
  '-----END PRIVATE KEY-----',
].join('\n');

const VALID_PEM_ESCAPED = VALID_PEM_BODY.replace(/\n/g, '\\n');

describe('google-env — credential loading', () => {
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = {
      GOOGLE_TTS_PROJECT_ID: process.env.GOOGLE_TTS_PROJECT_ID,
      GOOGLE_TTS_CLIENT_EMAIL: process.env.GOOGLE_TTS_CLIENT_EMAIL,
      GOOGLE_TTS_PRIVATE_KEY: process.env.GOOGLE_TTS_PRIVATE_KEY,
    };
    delete process.env.GOOGLE_TTS_PROJECT_ID;
    delete process.env.GOOGLE_TTS_CLIENT_EMAIL;
    delete process.env.GOOGLE_TTS_PRIVATE_KEY;
    __resetGoogleCredentialsCacheForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetGoogleCredentialsCacheForTests();
  });

  it('returns null when no env vars are set (provider stays hidden in picker)', () => {
    expect(loadGoogleCredentials()).toBeNull();
  });

  it('returns null when only some env vars are set (partial config = not configured)', () => {
    process.env.GOOGLE_TTS_PROJECT_ID = 'my-project';
    process.env.GOOGLE_TTS_CLIENT_EMAIL = 'sa@example.iam.gserviceaccount.com';
    // private key missing
    expect(loadGoogleCredentials()).toBeNull();
  });

  it('loads credentials with real newlines when env already has them', () => {
    process.env.GOOGLE_TTS_PROJECT_ID = 'my-project';
    process.env.GOOGLE_TTS_CLIENT_EMAIL = 'sa@example.iam.gserviceaccount.com';
    process.env.GOOGLE_TTS_PRIVATE_KEY = VALID_PEM_BODY;

    const creds = loadGoogleCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.projectId).toBe('my-project');
    expect(creds!.privateKey).toBe(VALID_PEM_BODY);
    expect(creds!.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('converts the Vercel `\\n` escape to real newlines (the footgun fix)', () => {
    process.env.GOOGLE_TTS_PROJECT_ID = 'my-project';
    process.env.GOOGLE_TTS_CLIENT_EMAIL = 'sa@example.iam.gserviceaccount.com';
    process.env.GOOGLE_TTS_PRIVATE_KEY = VALID_PEM_ESCAPED;

    const creds = loadGoogleCredentials();
    expect(creds).not.toBeNull();
    // Real newlines after normalization, not the literal two-char escape.
    expect(creds!.privateKey).toBe(VALID_PEM_BODY);
    expect(creds!.privateKey).not.toContain('\\n');
    expect(creds!.privateKey.split('\n').length).toBeGreaterThan(1);
  });

  it('caches the result so a repeat call does not re-read process.env', () => {
    process.env.GOOGLE_TTS_PROJECT_ID = 'p1';
    process.env.GOOGLE_TTS_CLIENT_EMAIL = 'a@b.com';
    process.env.GOOGLE_TTS_PRIVATE_KEY = VALID_PEM_BODY;
    const first = loadGoogleCredentials();
    process.env.GOOGLE_TTS_PROJECT_ID = 'p2';
    const second = loadGoogleCredentials();
    expect(second?.projectId).toBe('p1');
    expect(first).toBe(second);
  });
});

describe('google-env — strict assertion', () => {
  beforeEach(() => {
    delete process.env.GOOGLE_TTS_PROJECT_ID;
    delete process.env.GOOGLE_TTS_CLIENT_EMAIL;
    delete process.env.GOOGLE_TTS_PRIVATE_KEY;
    __resetGoogleCredentialsCacheForTests();
  });

  it('throws a user-actionable error when env vars are missing', () => {
    expect(() => assertGoogleCredentialsValid()).toThrow(/GOOGLE_TTS_PROJECT_ID/);
  });

  it('throws when the private key looks malformed (e.g. corrupted by paste)', () => {
    process.env.GOOGLE_TTS_PROJECT_ID = 'p';
    process.env.GOOGLE_TTS_CLIENT_EMAIL = 'a@b.com';
    process.env.GOOGLE_TTS_PRIVATE_KEY = 'NOT-A-VALID-KEY';
    expect(() => assertGoogleCredentialsValid()).toThrow(/PEM key/);
  });
});
