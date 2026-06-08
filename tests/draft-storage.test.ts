/**
 * Tests for the localStorage-backed crash-recovery draft storage.
 *
 * Plan: 2026-06-08-editor-crash-recovery-and-render-loop.md.
 *
 * The pure-function side (decideRecovery, draftStorageKey) is
 * trivially testable. The localStorage-bound side uses vitest's
 * `vi.stubGlobal('localStorage', ...)` so the same tests run without
 * jsdom in the suite default environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDraft,
  decideRecovery,
  draftStorageKey,
  readDraft,
  writeDraft,
  type DraftEnvelope,
} from '@/lib/editor/draft-storage';

// ─── Mock localStorage ───────────────────────────────────────────

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null { return this.store.get(k) ?? null; }
  setItem(k: string, v: string): void {
    if (this.shouldThrowQuota) throw new DOMException('Quota', 'QuotaExceededError');
    this.store.set(k, v);
  }
  removeItem(k: string): void { this.store.delete(k); }
  clear(): void { this.store.clear(); }
  shouldThrowQuota = false;
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  // jsdom defaults `window` to defined; we just need a truthy value.
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Pure helpers ────────────────────────────────────────────────

describe('draftStorageKey', () => {
  it('builds a project-prefixed key', () => {
    expect(draftStorageKey('proj-123')).toBe('editor:draft:proj-123');
  });
});

describe('decideRecovery', () => {
  const draft = (baseVersion: number): DraftEnvelope => ({
    v: 1,
    savedAt: 1_700_000_000_000,
    baseVersion,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: { doc: { rows: [] } as any, rowImages: {} },
  });

  it('returns "restore" when draft baseVersion equals server version', () => {
    expect(decideRecovery(draft(5), 5)).toBe('restore');
  });

  it('returns "stale" when server has moved past the draft', () => {
    expect(decideRecovery(draft(3), 7)).toBe('stale');
  });

  it('treats a draft ahead of the server as stale (clock skew / rollback)', () => {
    expect(decideRecovery(draft(9), 5)).toBe('stale');
  });

  it('returns "none" when there is no draft', () => {
    expect(decideRecovery(null, 5)).toBe('none');
  });
});

// ─── localStorage round-trip ─────────────────────────────────────

describe('writeDraft + readDraft round-trip', () => {
  const sampleEnvelope: DraftEnvelope = {
    v: 1,
    savedAt: 1_700_000_000_000,
    baseVersion: 42,
    payload: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doc: { title: 't', niche: 'n', rows: [] } as any,
      rowImages: { 0: 'https://example.com/0.png' },
    },
  };

  it('writes a draft and reads it back identically', () => {
    expect(writeDraft('p1', sampleEnvelope)).toEqual({ ok: true });
    const out = readDraft('p1');
    expect(out).toEqual(sampleEnvelope);
  });

  it('returns null when no draft has been written for the project', () => {
    expect(readDraft('never-written')).toBeNull();
  });

  it('isolates drafts by projectId', () => {
    writeDraft('p1', sampleEnvelope);
    writeDraft('p2', { ...sampleEnvelope, baseVersion: 99 });
    expect(readDraft('p1')?.baseVersion).toBe(42);
    expect(readDraft('p2')?.baseVersion).toBe(99);
  });

  it('clearDraft removes a draft so readDraft returns null', () => {
    writeDraft('p1', sampleEnvelope);
    expect(readDraft('p1')).not.toBeNull();
    clearDraft('p1');
    expect(readDraft('p1')).toBeNull();
  });

  it('returns null on a malformed JSON blob (defensive)', () => {
    storage.setItem(draftStorageKey('p1'), '{not json');
    expect(readDraft('p1')).toBeNull();
  });

  it('returns null when the envelope schema version is unknown', () => {
    storage.setItem(
      draftStorageKey('p1'),
      JSON.stringify({ v: 99, savedAt: 0, baseVersion: 0, payload: { doc: {} } }),
    );
    expect(readDraft('p1')).toBeNull();
  });

  it('returns null when the envelope is missing the doc', () => {
    storage.setItem(
      draftStorageKey('p1'),
      JSON.stringify({ v: 1, savedAt: 0, baseVersion: 0, payload: {} }),
    );
    expect(readDraft('p1')).toBeNull();
  });

  it('reports quota failure rather than throwing', () => {
    storage.shouldThrowQuota = true;
    const result = writeDraft('p1', sampleEnvelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('quota');
  });
});
