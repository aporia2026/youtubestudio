/**
 * Tests for the canonical project payload migrator + validator.
 *
 * Phase 1 of `_plans/2026-05-19-editor-production-doc-parity.md`.
 *
 * These tests guard the round-trip that the whole parity plan rests
 * on: anything we accept on the wire has to survive `migratePayload`
 * intact, and anything malformed has to be rejected by
 * `validatePayload` with a useful field path.
 */
import { describe, expect, it } from 'vitest';
import {
  PROJECT_PAYLOAD_VERSION,
  emptyProjectPayload,
  migratePayload,
  validatePayload,
  __testing,
} from '@/lib/project/payload';

const VALID_DOC = {
  title: 'Cyber-attack history',
  niche: 'tech',
  total_duration: '120',
  total_words: 300,
  speaking_pace_wpm: 150,
  rows: [
    { timecode: '00:00', script_text: 'Morris Worm' },
    { timecode: '00:05', script_text: '10% OF THE NET' },
  ],
};

// ─── pin_duration round-trip (2026-05-23 pin-duration architecture) ──
//
// The pin-duration plan adds a new boolean field to ProductionRow.
// This test runs FIRST in the implementation order so we know — before
// any other code depends on it — whether the validator+migrator pair
// strips the field on save→load. If it does, the plan calls for
// explicit pass-through in `migratePayload`; if it doesn't (because
// rows pass through opaquely), no migrator change is needed.
//
// See `_plans/2026-05-23-editor-pin-duration-architecture.md` Phase 1.

describe('pin_duration round-trip through validatePayload + migratePayload', () => {
  function payloadWith(rows: Array<Record<string, unknown>>) {
    return {
      doc: {
        title: 'Pin test',
        niche: 'tech',
        total_duration: '60',
        total_words: 100,
        speaking_pace_wpm: 150,
        rows,
      },
      flags: { animateScenes: true, suppressLowerThirds: false, overlaysDisabled: false, rowLockedAsStill: {} },
    };
  }

  it('preserves pin_duration: true on a row through migratePayload', () => {
    const raw = payloadWith([
      { timecode: '00:00', script_text: 'A', duration_override_ms: 4000, pin_duration: true },
      { timecode: '00:04', script_text: 'B' },
    ]);
    const { payload } = migratePayload(raw);
    const r0 = payload.doc.rows[0] as { pin_duration?: boolean; duration_override_ms?: number };
    expect(r0.pin_duration).toBe(true);
    expect(r0.duration_override_ms).toBe(4000);
  });

  it('leaves pin_duration undefined on a legacy row that lacks the field', () => {
    const raw = payloadWith([
      { timecode: '00:00', script_text: 'A', duration_override_ms: 4000 },
    ]);
    const { payload } = migratePayload(raw);
    const r0 = payload.doc.rows[0] as { pin_duration?: boolean };
    expect(r0.pin_duration).toBeUndefined();
  });

  it('survives the full validate → migrate path with the field intact', () => {
    const raw = payloadWith([
      { timecode: '00:00', script_text: 'A', duration_override_ms: 4000, pin_duration: true },
    ]);
    const result = validatePayload(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r0 = result.payload.doc.rows[0] as { pin_duration?: boolean };
    expect(r0.pin_duration).toBe(true);
  });
});

describe('isSafeAssetUrl', () => {
  const isSafe = __testing.isSafeAssetUrl;

  it('accepts relative proxy paths', () => {
    expect(isSafe('/api/voiceover/123')).toBe(true);
    expect(isSafe('/api/broll/abc')).toBe(true);
  });

  it('accepts absolute https URLs', () => {
    expect(isSafe('https://something.public.blob.vercel-storage.com/x.mp3')).toBe(true);
    expect(isSafe('https://abc.r2.dev/clip.mp4')).toBe(true);
    expect(isSafe('https://tempfile.aiquickdraw.com/file.mp4')).toBe(true);
  });

  it('rejects javascript / data / vbscript / file / blob schemes', () => {
    expect(isSafe('javascript:alert(1)')).toBe(false);
    expect(isSafe('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafe(' javascript:void(0)')).toBe(false);
    expect(isSafe('data:text/html,<script>1</script>')).toBe(false);
    expect(isSafe('vbscript:msgbox')).toBe(false);
    expect(isSafe('file:///etc/passwd')).toBe(false);
    expect(isSafe('blob:https://x.com/abc')).toBe(false);
  });

  it('rejects http://', () => {
    expect(isSafe('http://example.com/x.mp3')).toBe(false);
  });

  it('rejects empty / non-URL input', () => {
    expect(isSafe('')).toBe(false);
    expect(isSafe('not-a-url')).toBe(false);
  });
});

describe('emptyProjectPayload', () => {
  it('returns a structurally valid payload at the current version', () => {
    const p = emptyProjectPayload();
    expect(p.version).toBe(PROJECT_PAYLOAD_VERSION);
    expect(p.doc.rows).toEqual([]);
    expect(p.rowImages).toEqual({});
    expect(p.rowOverlays).toEqual({});
    expect(p.rowVideoClips).toEqual({});
    expect(p.flags.animateScenes).toBe(true);
    expect(p.flags.suppressLowerThirds).toBe(false);
    expect(p.flags.overlaysDisabled).toBe(false);
    expect(p.flags.rowLockedAsStill).toEqual({});
  });

  it('passes its own title through', () => {
    expect(emptyProjectPayload('Hello').title).toBe('Hello');
  });
});

describe('migratePayload — defensive fill', () => {
  it('returns an empty payload for non-object input without throwing', () => {
    const r = migratePayload(null);
    expect(r.payload.version).toBe(PROJECT_PAYLOAD_VERSION);
    expect(r.appliedDefaults).toContain('<entire-payload>');

    expect(migratePayload(undefined).payload.version).toBe(PROJECT_PAYLOAD_VERSION);
    expect(migratePayload('not an object').payload.doc.rows).toEqual([]);
    expect(migratePayload([1, 2, 3]).payload.doc.rows).toEqual([]);
  });

  it('preserves a fully-canonical payload byte-for-byte (key set)', () => {
    const input = {
      version: 1,
      title: 'T',
      doc: VALID_DOC,
      rowImages: { 0: '/api/img/0' },
      rowOverlays: { 1: { status: 'done', url: '/api/o/1' } },
      rowVideoClips: { 2: { status: 'ready', videoUrl: '/api/v/2', durationSeconds: 6 } },
      voiceoverUrl: '/api/voiceover/abc',
      voiceoverAlignment: { words: [{ text: 'Morris', start: 0, end: 0.5 }] },
      captions: {
        voiceoverUrlHash: 'abc',
        modelId: 'gpt-4o-mini-transcribe',
        generatedAt: '2026-05-19T00:00:00Z',
        segments: [{ start: 0, end: 1, text: 'Morris' }],
      },
      musicUrl: '/api/music/x',
      brandKitOverride: { primaryColor: '#ff0000' },
      channelId: 'ch-1',
      flags: {
        animateScenes: false,
        suppressLowerThirds: true,
        overlaysDisabled: false,
        rowLockedAsStill: { 0: true },
      },
    };
    const { payload, droppedFields, appliedDefaults } = migratePayload(input);
    expect(droppedFields).toEqual([]);
    expect(appliedDefaults).toEqual([]);
    expect(payload.title).toBe('T');
    expect(payload.rowImages).toEqual({ 0: '/api/img/0' });
    expect(payload.rowVideoClips[2]?.videoUrl).toBe('/api/v/2');
    expect(payload.voiceoverUrl).toBe('/api/voiceover/abc');
    expect(payload.flags.animateScenes).toBe(false);
    expect(payload.flags.rowLockedAsStill).toEqual({ 0: true });
  });

  it('migrates legacy rowImages: RowImageState[] into the index-keyed map', () => {
    const input = {
      doc: VALID_DOC,
      rowImages: [
        { status: 'done', imageUrl: '/api/img/0' },
        { status: 'idle' }, // no imageUrl — dropped silently
        { status: 'done', imageUrl: 'https://abc.r2.dev/2.png' },
      ],
    };
    const { payload } = migratePayload(input);
    expect(payload.rowImages).toEqual({
      0: '/api/img/0',
      2: 'https://abc.r2.dev/2.png',
    });
  });

  it('migrates legacy rowVideoClips: Record<number, clipId>', () => {
    const input = {
      doc: VALID_DOC,
      rowVideoClips: { 0: 'clip-abc', 3: 'clip-xyz' },
    };
    const { payload } = migratePayload(input);
    expect(payload.rowVideoClips[0]).toEqual({ status: 'pending' });
    expect(payload.rowVideoClips[3]).toEqual({ status: 'pending' });
  });

  it('drops rowImages entries with unsafe URLs and reports them', () => {
    const input = {
      doc: VALID_DOC,
      rowImages: {
        0: 'javascript:alert(1)',
        1: 'data:image/svg+xml,<script>1</script>',
        2: '/api/img/2',
      },
    };
    const { payload, droppedFields } = migratePayload(input);
    expect(payload.rowImages).toEqual({ 2: '/api/img/2' });
    expect(droppedFields).toContain('rowImages[0]');
    expect(droppedFields).toContain('rowImages[1]');
  });

  it('drops a malformed voiceoverUrl without dropping the rest of the payload', () => {
    const input = {
      doc: VALID_DOC,
      voiceoverUrl: 'javascript:alert(1)',
      rowImages: { 0: '/api/img/0' },
    };
    const { payload, droppedFields } = migratePayload(input);
    expect(payload.voiceoverUrl).toBeUndefined();
    expect(payload.rowImages[0]).toBe('/api/img/0');
    expect(droppedFields).toContain('voiceoverUrl');
  });

  it('upgrades top-level legacy flag aliases into flags.*', () => {
    const input = {
      doc: VALID_DOC,
      animateScenes: false,
      suppressLowerThirds: true,
    };
    const { payload } = migratePayload(input);
    expect(payload.flags.animateScenes).toBe(false);
    expect(payload.flags.suppressLowerThirds).toBe(true);
  });

  it('prefers flags.* over legacy top-level aliases when both are present', () => {
    const input = {
      doc: VALID_DOC,
      animateScenes: false,
      flags: { animateScenes: true },
    };
    const { payload } = migratePayload(input);
    expect(payload.flags.animateScenes).toBe(true);
  });

  it('bridges the legacy visualBrandKitOverride field name', () => {
    const input = {
      doc: VALID_DOC,
      visualBrandKitOverride: { primaryColor: '#abcdef' },
    };
    const { payload } = migratePayload(input);
    expect(payload.brandKitOverride).toEqual({ primaryColor: '#abcdef' });
  });

  it('drops numerically-non-keyed entries in rowImages / rowOverlays / rowVideoClips', () => {
    const input = {
      doc: VALID_DOC,
      rowImages: { 'not-a-number': '/api/img/0', 0: '/api/img/0' },
      rowOverlays: { abc: { status: 'done' } },
      rowVideoClips: { foo: { status: 'ready' } },
    };
    const { payload, droppedFields } = migratePayload(input);
    expect(payload.rowImages).toEqual({ 0: '/api/img/0' });
    expect(payload.rowOverlays).toEqual({});
    expect(payload.rowVideoClips).toEqual({});
    expect(droppedFields).toContain('rowImages[not-a-number]');
    expect(droppedFields).toContain('rowOverlays[abc]');
    expect(droppedFields).toContain('rowVideoClips[foo]');
  });

  it('drops voiceoverAlignment / captions when shape is wrong but keeps the rest', () => {
    const input = {
      doc: VALID_DOC,
      voiceoverAlignment: { not_words: [] },
      captions: { no_segments_field: true },
    };
    const { payload, droppedFields } = migratePayload(input);
    expect(payload.voiceoverAlignment).toBeUndefined();
    expect(payload.captions).toBeUndefined();
    expect(droppedFields).toContain('voiceoverAlignment');
    expect(droppedFields).toContain('captions');
    expect(payload.doc.rows.length).toBe(2);
  });
});

describe('validatePayload — route boundary', () => {
  it('accepts a canonical payload', () => {
    const r = validatePayload({
      version: 1,
      title: 'T',
      doc: VALID_DOC,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.doc.rows.length).toBe(2);
  });

  it('rejects non-object input with the root field path', () => {
    const r = validatePayload(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('<root>');
  });

  it('rejects a payload missing doc.rows', () => {
    const r = validatePayload({ doc: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('doc.rows');
  });

  it('rejects a wrong version', () => {
    const r = validatePayload({ version: 99, doc: VALID_DOC });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('version');
  });

  it('rejects an unsafe voiceoverUrl', () => {
    const r = validatePayload({
      doc: VALID_DOC,
      voiceoverUrl: 'javascript:alert(1)',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('voiceoverUrl');
  });

  it('rejects http:// voiceoverUrl (no plaintext)', () => {
    const r = validatePayload({
      doc: VALID_DOC,
      voiceoverUrl: 'http://example.com/x.mp3',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('voiceoverUrl');
  });

  it('accepts an absent voiceoverUrl', () => {
    const r = validatePayload({ doc: VALID_DOC });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.voiceoverUrl).toBeUndefined();
  });

  it('rejects a non-string voiceoverUrl', () => {
    const r = validatePayload({ doc: VALID_DOC, voiceoverUrl: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('voiceoverUrl');
  });

  it('strips unknown top-level keys via the migrator', () => {
    const r = validatePayload({
      doc: VALID_DOC,
      // Anything the validator + migrator don't recognize should NOT
      // appear on the canonical payload. Defense-in-depth: a malicious
      // PATCH can't smuggle arbitrary JSONB into the row.
      __extra_unknown_field__: 'should-be-stripped',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.payload)).not.toContain('__extra_unknown_field__');
    }
  });
});
