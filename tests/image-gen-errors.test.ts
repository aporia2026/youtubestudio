/**
 * Tests for `src/lib/auto-pipeline/image-gen-errors.ts`.
 *
 * The classifier sits between every image-generation failure in the
 * stage handler and the row's persisted `last_error` field. A bug
 * here misroutes failures to the wrong retry budget — either grinding
 * forever on a deterministic failure (if a permanent error gets
 * classified as `timeout` which has 3 attempts) or giving up too soon
 * (if a transient error gets classified as `content_policy` with 1
 * attempt).
 *
 * The sanitizer is rule-13 (security) load-bearing: a single regex
 * gap here ships a Bearer token or an internal file path to the
 * client, where it's rendered in the chip tooltip and shipped across
 * tabs via `useProject` polling.
 *
 * Coverage:
 *   - Each of the 11 classifier categories (one example per).
 *   - The fallthrough to `unknown` for unrecognised strings.
 *   - Each of the four sanitization patterns (Bearer / API key /
 *     file path / storage URL).
 *   - `isExhausted` per-budget behaviour.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyImageGenError,
  isExhausted,
  RETRY_BUDGETS,
  sanitizeErrorMessage,
  labelForErrorClass,
  type ImageGenErrorClass,
} from '../src/lib/auto-pipeline/image-gen-errors';

describe('classifyImageGenError', () => {
  it('classifies OpenAI-style content policy violations', () => {
    expect(classifyImageGenError('content_policy_violation').class).toBe('content_policy');
    expect(classifyImageGenError('This violates our usage policies.').class).toBe('content_policy');
    expect(classifyImageGenError({ message: 'safety system rejected' }).class).toBe('content_policy');
  });

  it('classifies reference-image rejection patterns', () => {
    expect(classifyImageGenError('reference_rejected: nsfw-pose').class).toBe('reference_rejected');
    expect(classifyImageGenError(new Error('ReferenceRejectedError: …')).class).toBe('reference_rejected');
    expect(classifyImageGenError('reference image blocked').class).toBe('reference_rejected');
  });

  it('classifies empty-prompt errors', () => {
    expect(classifyImageGenError('empty_ai_image_prompt').class).toBe('invalid_prompt');
    expect(classifyImageGenError('prompt_required').class).toBe('invalid_prompt');
  });

  it('classifies missing-style-refs errors', () => {
    expect(classifyImageGenError('no_style_refs_available').class).toBe('no_refs');
  });

  it('classifies variant source-missing errors', () => {
    expect(classifyImageGenError('source_image_not_generated').class).toBe('source_missing');
  });

  it('classifies killed / disabled errors', () => {
    expect(classifyImageGenError('kill_switch').class).toBe('killed');
    expect(classifyImageGenError('settings_disabled').class).toBe('killed');
  });

  it('classifies motion-collage validation failures', () => {
    expect(classifyImageGenError('validation_failed:malformed-grid').class).toBe('validation_failed');
  });

  it('classifies timeout family', () => {
    expect(classifyImageGenError('Request timed out').class).toBe('timeout');
    expect(classifyImageGenError('ETIMEDOUT').class).toBe('timeout');
    expect(classifyImageGenError('Gateway 504').class).toBe('timeout');
  });

  it('classifies blank-output errors', () => {
    expect(classifyImageGenError('no_image_returned').class).toBe('blank_output');
    expect(classifyImageGenError('blank output from model').class).toBe('blank_output');
  });

  it('classifies generic provider rejection (atlas-edit-failed / gpt2)', () => {
    expect(classifyImageGenError('[atlas-edit-failed] 422 Unprocessable').class).toBe('model_rejected');
    expect(classifyImageGenError('[gpt2-edit-failed] mouth removal flow').class).toBe('model_rejected');
    expect(classifyImageGenError('HTTP 500 from upstream').class).toBe('model_rejected');
  });

  it('falls back to unknown for unrecognised strings', () => {
    expect(classifyImageGenError('something weird happened').class).toBe('unknown');
    expect(classifyImageGenError(null).class).toBe('unknown');
    expect(classifyImageGenError(undefined).class).toBe('unknown');
    expect(classifyImageGenError({}).class).toBe('unknown');
  });

  it('always returns a non-empty message', () => {
    const seen: ImageGenErrorClass[] = [];
    for (const raw of ['', null, undefined, {}, 'random gibberish']) {
      const r = classifyImageGenError(raw);
      expect(r.message.length).toBeGreaterThan(0);
      seen.push(r.class);
    }
    expect(seen.every((c) => c in RETRY_BUDGETS)).toBe(true);
  });

  it('match order: reference_rejected wins over generic provider rejection', () => {
    // A real failure string can include both signals — make sure the
    // more actionable category lands.
    expect(
      classifyImageGenError('[atlas-edit-failed] reference_rejected: nsfw').class,
    ).toBe('reference_rejected');
  });
});

describe('sanitizeErrorMessage', () => {
  it('scrubs Bearer tokens', () => {
    const out = sanitizeErrorMessage('Auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def');
    expect(out).toContain('Bearer ***');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('scrubs sk- / pk- / key_ API-key shapes', () => {
    const out = sanitizeErrorMessage('Bad key: sk-1234567890abcdef1234567890abcdef');
    expect(out).toContain('sk-***');
    expect(out).not.toContain('1234567890abcdef1234567890abcdef');
  });

  it('scrubs Unix and Windows file system paths', () => {
    const unix = sanitizeErrorMessage('ENOENT: /Users/joe/secret/file.txt missing');
    expect(unix).toContain('/Users/***');
    expect(unix).not.toContain('joe/secret');

    const win = sanitizeErrorMessage('Cannot read C:\\Users\\jane\\app\\config.json');
    expect(win).toContain('C:\\Users\\***');
    expect(win).not.toContain('jane');
  });

  it('scrubs customer-id-bearing storage URLs', () => {
    const out = sanitizeErrorMessage(
      'Atlas: https://cust-1234.r2.cloudflarestorage.com/bucket-abc/path/to/img.png',
    );
    expect(out).toMatch(/r2\.cloudflarestorage\.com\/\*\*\*/);
    expect(out).not.toContain('bucket-abc');
  });

  it('caps long messages at 240 chars', () => {
    const long = 'x'.repeat(500);
    const out = sanitizeErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith('...')).toBe(true);
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeErrorMessage('')).toBe('');
  });
});

describe('isExhausted', () => {
  it('returns false when attempts is undefined', () => {
    expect(isExhausted(undefined, 'content_policy')).toBe(false);
  });

  it('returns false when attempts < budget', () => {
    // timeout budget = 3
    expect(isExhausted(0, 'timeout')).toBe(false);
    expect(isExhausted(1, 'timeout')).toBe(false);
    expect(isExhausted(2, 'timeout')).toBe(false);
  });

  it('returns true when attempts == budget', () => {
    expect(isExhausted(1, 'content_policy')).toBe(true); // budget 1
    expect(isExhausted(3, 'timeout')).toBe(true); // budget 3
  });

  it('returns true when attempts > budget', () => {
    expect(isExhausted(5, 'content_policy')).toBe(true);
  });

  it('content_policy / reference_rejected / invalid_prompt give one shot only', () => {
    expect(RETRY_BUDGETS.content_policy).toBe(1);
    expect(RETRY_BUDGETS.reference_rejected).toBe(1);
    expect(RETRY_BUDGETS.invalid_prompt).toBe(1);
  });

  it('timeout gets three shots', () => {
    expect(RETRY_BUDGETS.timeout).toBe(3);
  });
});

describe('labelForErrorClass', () => {
  it('produces a short label for every error class', () => {
    for (const cls of Object.keys(RETRY_BUDGETS) as ImageGenErrorClass[]) {
      const label = labelForErrorClass(cls);
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(16);
    }
  });

  it('falls back to "Failed" for unknown strings', () => {
    expect(labelForErrorClass('something_unknown')).toBe('Failed');
  });
});
