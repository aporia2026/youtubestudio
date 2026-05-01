import { describe, expect, it } from 'vitest';
import { SCOPED_TABLES, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';

describe('SCOPED_TABLES allowlist', () => {
  it('contains all root + child tenant tables (no typos in identifiers)', () => {
    const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
    for (const t of SCOPED_TABLES) {
      expect(SAFE_IDENT.test(t)).toBe(true);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(SCOPED_TABLES).size).toBe(SCOPED_TABLES.length);
  });

  it('includes the canonical root tenant tables', () => {
    for (const t of [
      'projects',
      'channels',
      'schedule_items',
      'series',
      'review_projects',
      'video_ideas',
    ]) {
      expect(SCOPED_TABLES).toContain(t);
    }
  });

  it('includes video_analytics (added in PR #3)', () => {
    expect(SCOPED_TABLES).toContain('video_analytics');
  });
});

describe('ResourceNotInWorkspaceError', () => {
  it('preserves the table + resource id for upstream handlers', () => {
    const err = new ResourceNotInWorkspaceError('projects', 'p-1');
    expect(err.table).toBe('projects');
    expect(err.resourceId).toBe('p-1');
    expect(err.name).toBe('ResourceNotInWorkspaceError');
    expect(err.message).toMatch(/p-1/);
  });

  it('is throwable + identifiable via instanceof', () => {
    let caught: unknown = null;
    try {
      throw new ResourceNotInWorkspaceError('channels', 'c-9');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ResourceNotInWorkspaceError);
  });
});
