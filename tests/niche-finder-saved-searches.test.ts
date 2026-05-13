/**
 * Pure-helper tests for the saved-search helpers in watchlist.ts.
 *
 * Saved searches use a synthetic `search-<uuid>` slug so the existing
 * niche_watchlist PK `(workspace_id, niche_slug)` keeps working
 * without a migration. The slug is treated as opaque by the UI; only
 * these helpers know its shape.
 */
import { describe, expect, it } from 'vitest';
import {
  isSavedSearchSlug,
  newSavedSearchSlug,
  SAVED_SEARCH_SLUG_PREFIX,
} from '@/lib/niche-finder/watchlist';

describe('newSavedSearchSlug', () => {
  it('always starts with the documented prefix', () => {
    for (let i = 0; i < 5; i++) {
      expect(newSavedSearchSlug()).toMatch(new RegExp(`^${SAVED_SEARCH_SLUG_PREFIX}`));
    }
  });

  it('appends a UUID after the prefix', () => {
    const slug = newSavedSearchSlug();
    const uuid = slug.slice(SAVED_SEARCH_SLUG_PREFIX.length);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('produces a unique value on every call', () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 200; i++) slugs.add(newSavedSearchSlug());
    expect(slugs.size).toBe(200);
  });
});

describe('isSavedSearchSlug', () => {
  it('true for a freshly-minted slug', () => {
    expect(isSavedSearchSlug(newSavedSearchSlug())).toBe(true);
  });

  it('true for any slug starting with the prefix', () => {
    expect(isSavedSearchSlug(`${SAVED_SEARCH_SLUG_PREFIX}anything`)).toBe(true);
  });

  it('false for real niche slugs', () => {
    expect(isSavedSearchSlug('credit-card-churning-for-beginners')).toBe(false);
    expect(isSavedSearchSlug('finance')).toBe(false);
    expect(isSavedSearchSlug('')).toBe(false);
  });

  it('false for slugs that only contain the prefix as a substring elsewhere', () => {
    // The prefix has to be at the start.
    expect(isSavedSearchSlug(`niche-${SAVED_SEARCH_SLUG_PREFIX}foo`)).toBe(false);
  });
});
