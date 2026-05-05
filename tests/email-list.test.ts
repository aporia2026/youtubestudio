import { describe, expect, it } from 'vitest';
import { EMAIL_LIST_RE, SINGLE_EMAIL_RE, parseEmailRecipients } from '@/lib/email-list';

describe('SINGLE_EMAIL_RE', () => {
  it('accepts standard addresses', () => {
    expect(SINGLE_EMAIL_RE.test('foo@bar.com')).toBe(true);
    expect(SINGLE_EMAIL_RE.test('foo.bar+filter@quux.io')).toBe(true);
    expect(SINGLE_EMAIL_RE.test('a-b.c+d@x-y.z.com')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(SINGLE_EMAIL_RE.test('not-an-email')).toBe(false);
    expect(SINGLE_EMAIL_RE.test('foo@')).toBe(false);
    expect(SINGLE_EMAIL_RE.test('@bar.com')).toBe(false);
    expect(SINGLE_EMAIL_RE.test('foo@bar')).toBe(false); // no TLD
    expect(SINGLE_EMAIL_RE.test('Foo <foo@bar.com>')).toBe(false); // display name
  });

  it('rejects CRLF + Bcc-injection attempts', () => {
    expect(SINGLE_EMAIL_RE.test('foo@bar.com\r\nBcc: evil@evil.com')).toBe(false);
    expect(SINGLE_EMAIL_RE.test('foo@bar.com\nevil@evil.com')).toBe(false);
  });
});

describe('EMAIL_LIST_RE', () => {
  it('accepts a single address', () => {
    expect(EMAIL_LIST_RE.test('foo@bar.com')).toBe(true);
  });

  it('accepts multiple addresses comma-separated, with optional spaces', () => {
    expect(EMAIL_LIST_RE.test('a@b.com,c@d.io')).toBe(true);
    expect(EMAIL_LIST_RE.test('a@b.com, c@d.io')).toBe(true);
    expect(EMAIL_LIST_RE.test('a@b.com , c@d.io , e@f.net')).toBe(true);
  });

  it('rejects trailing comma + empty entries', () => {
    expect(EMAIL_LIST_RE.test('a@b.com,')).toBe(false);
    expect(EMAIL_LIST_RE.test(',a@b.com')).toBe(false);
    expect(EMAIL_LIST_RE.test('a@b.com,,c@d.io')).toBe(false);
  });

  it('rejects newlines / tabs / NUL between addresses', () => {
    expect(EMAIL_LIST_RE.test('a@b.com\r\nc@d.io')).toBe(false);
    expect(EMAIL_LIST_RE.test('a@b.com\nc@d.io')).toBe(false);
    expect(EMAIL_LIST_RE.test('a@b.com\tc@d.io')).toBe(false);
    expect(EMAIL_LIST_RE.test('a@b.com\x00c@d.io')).toBe(false);
  });
});

describe('parseEmailRecipients', () => {
  const fallback = 'owner@example.com';

  it('uses the override when provided + valid', () => {
    expect(parseEmailRecipients('a@b.com, c@d.io', fallback)).toEqual([
      'a@b.com',
      'c@d.io',
    ]);
  });

  it('falls back when the override is null', () => {
    expect(parseEmailRecipients(null, fallback)).toEqual([fallback]);
  });

  it('falls back when the override is empty/whitespace', () => {
    expect(parseEmailRecipients('', fallback)).toEqual([fallback]);
    expect(parseEmailRecipients('   ', fallback)).toEqual([fallback]);
  });

  it('falls back when the override fails validation (hand-edited DB)', () => {
    expect(parseEmailRecipients('Foo <foo@bar.com>', fallback)).toEqual([fallback]);
    expect(parseEmailRecipients('not-an-email', fallback)).toEqual([fallback]);
  });

  it('returns [] when both override and fallback are missing/invalid', () => {
    expect(parseEmailRecipients(null, null)).toEqual([]);
    expect(parseEmailRecipients(null, 'not-an-email')).toEqual([]);
    expect(parseEmailRecipients('also-bad', null)).toEqual([]);
  });

  it('de-dupes repeated addresses defensively', () => {
    expect(parseEmailRecipients('foo@bar.com, foo@bar.com', fallback)).toEqual([
      'foo@bar.com',
    ]);
  });
});
