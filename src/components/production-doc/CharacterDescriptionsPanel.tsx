/**
 * CharacterDescriptionsPanel — doc-level bible editor.
 *
 * Renders one row per `character_id` slug currently in use across the
 * doc. For each slug, shows the description (from
 * `doc.doodle_explainer_2_character_descriptions[slug]`) and an
 * [edit] button that swaps the description into an inline textarea.
 *
 * Surfaces a ⚠ warning next to slugs that are tagged on rows but
 * have no description — the LLM forgot to emit one, or the user
 * added the slug via the per-row chip after generation. Clicking
 * [add] on those rows opens the same inline editor.
 *
 * Phase 4 (Editor UI) of the doodle_explainer_2 cache work.
 */
'use client';

import React, { useMemo, useState } from 'react';

export interface CharacterDescriptionsPanelProps {
  /** Slugs in use across the doc, sorted. From
   *  `collectCharacterIds(doc.rows)` in `src/lib/character-bible.ts`. */
  usedSlugs: ReadonlyArray<string>;
  /** The current descriptions map. The panel reads from here and
   *  writes back via `onChange`. Undefined / missing is fine. */
  descriptions: Record<string, string> | undefined;
  /** Persist callback. The panel hands back the FULL next-state map
   *  (not a patch) so the caller can replace the entire field on the
   *  doc in one setDoc/updateProductionDocEntry round-trip — same
   *  shape as the other doc-level mutations in the page. */
  onChange: (next: Record<string, string>) => void;
}

const DESCRIPTION_SOFT_CAP = 200;

export function CharacterDescriptionsPanel({
  usedSlugs,
  descriptions,
  onChange,
}: CharacterDescriptionsPanelProps) {
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const tagged = useMemo(() => descriptions ?? {}, [descriptions]);

  // Slugs the user might want to describe but that aren't tagged on
  // any row yet — listed in `descriptions` but never used. Surfaced
  // at the bottom of the panel so the user can clean up orphans.
  const orphanedSlugs = useMemo(() => {
    const usedSet = new Set(usedSlugs);
    return Object.keys(tagged)
      .filter((slug) => !usedSet.has(slug) && tagged[slug]?.trim().length > 0)
      .sort();
  }, [tagged, usedSlugs]);

  function startEdit(slug: string) {
    setEditingSlug(slug);
    setDraft(tagged[slug] ?? '');
  }

  function commit() {
    if (editingSlug === null) return;
    const trimmed = draft.trim();
    const next = { ...tagged };
    if (trimmed.length === 0) {
      // Empty save = remove the entry entirely so
      // `buildCharacterBiblePrefix` doesn't see an empty value.
      delete next[editingSlug];
    } else {
      next[editingSlug] = trimmed;
    }
    onChange(next);
    setEditingSlug(null);
    setDraft('');
  }

  function cancel() {
    setEditingSlug(null);
    setDraft('');
  }

  const allSlugs = useMemo(() => {
    // Tagged on rows first (most relevant), then orphans.
    return [...usedSlugs, ...orphanedSlugs.filter((s) => !usedSlugs.includes(s))];
  }, [usedSlugs, orphanedSlugs]);

  if (allSlugs.length === 0) {
    return (
      <div
        className="px-3 py-2 rounded text-xs"
        style={{
          background: 'var(--bg-card, #111)',
          border: '1px dashed var(--border)',
          color: 'var(--text-muted)',
        }}
      >
        No character_id slugs on any row in this doc yet. Add slugs via the 👤 chip on
        individual rows; then come back here to write each character&rsquo;s visual description.
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--bg-card, #111)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        One short visual description per recurring character. Prepended to every row&rsquo;s
        prompt so non-anchored characters render consistently across the doc.
      </div>
      {allSlugs.map((slug) => {
        const desc = tagged[slug] ?? '';
        const isUsed = usedSlugs.includes(slug);
        const missing = isUsed && desc.trim().length === 0;
        const editing = editingSlug === slug;
        const overCap = draft.length > DESCRIPTION_SOFT_CAP;
        return (
          <div
            key={slug}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: 6,
              borderRadius: 4,
              background: missing ? 'rgba(251,191,36,0.06)' : 'rgba(255,255,255,0.02)',
              border: missing ? '1px solid rgba(251,191,36,0.25)' : '1px solid transparent',
            }}
          >
            <span
              className="text-xs"
              style={{
                color: isUsed ? '#22d3ee' : 'var(--text-muted)',
                fontWeight: 600,
                minWidth: 110,
                flexShrink: 0,
              }}
              title={
                isUsed
                  ? `"${slug}" is tagged on rows in this doc.`
                  : `"${slug}" has a description but isn't tagged on any row. Safe to remove.`
              }
            >
              {missing && <span style={{ color: '#fbbf24' }}>⚠ </span>}
              {slug}
            </span>
            {editing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
                    if (e.key === 'Escape') cancel();
                  }}
                  rows={2}
                  placeholder="Gray hair and mustache, dark vest over white shirt, brown trousers, ~50 years old, often holds a hat."
                  className="text-xs px-2 py-1 rounded"
                  style={{
                    background: 'var(--bg-elevated, #1a1a1a)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                    outline: 'none',
                    resize: 'vertical',
                    minHeight: 50,
                  }}
                  autoFocus
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    className="text-[10px]"
                    style={{ color: overCap ? '#fbbf24' : 'var(--text-muted)' }}
                    title={
                      overCap
                        ? `Soft cap is ${DESCRIPTION_SOFT_CAP} chars — longer descriptions waste prompt budget but won't fail.`
                        : `Aim for 1-2 sentences (≤${DESCRIPTION_SOFT_CAP} chars).`
                    }
                  >
                    {draft.length}/{DESCRIPTION_SOFT_CAP}
                  </span>
                  <button
                    type="button"
                    onClick={commit}
                    className="text-[11px] px-2 py-1 rounded"
                    style={{
                      background: 'rgba(34,211,238,0.18)',
                      color: '#22d3ee',
                      border: '1px solid rgba(34,211,238,0.4)',
                      cursor: 'pointer',
                    }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={cancel}
                    className="text-[11px] px-2 py-1 rounded"
                    style={{
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flex: 1 }}>
                <span
                  className="text-xs"
                  style={{
                    color: desc ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontStyle: desc ? 'normal' : 'italic',
                    flex: 1,
                    lineHeight: 1.4,
                  }}
                >
                  {desc || (missing ? 'No description yet — needed for the bible.' : '—')}
                </span>
                <button
                  type="button"
                  onClick={() => startEdit(slug)}
                  className="text-[10px] px-2 py-0.5 rounded"
                  style={{
                    background: 'transparent',
                    color: missing ? '#fbbf24' : 'var(--text-muted)',
                    border: `1px solid ${missing ? 'rgba(251,191,36,0.4)' : 'var(--border)'}`,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  {missing ? 'add' : 'edit'}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
