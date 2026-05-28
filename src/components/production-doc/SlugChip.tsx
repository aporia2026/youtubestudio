/**
 * SlugChip — per-row character_id / scene_id editor.
 *
 * Renders a small inline chip showing the current slug (or "—" when
 * unset). Click opens a popover dropdown of slugs already in use in
 * the doc, plus "+ New" (which swaps in a text input) and "Clear"
 * (which sets the value to undefined).
 *
 * One component, two icons. The caller passes `kind = 'character' |
 * 'scene'` to pick the icon + tooltip wording. The save path is a
 * single `onChange(nextSlug)` callback; the caller wires it to
 * `updateRow(rowIndex, { character_id: nextSlug })` or the scene
 * equivalent.
 *
 * Phase 4 (Editor UI) of the doodle_explainer_2 cache work — closes
 * the LLM mis-tagging loop so the user can fix character_id /
 * scene_id without regenerating the whole doc. Spec:
 * _plans/2026-05-28-doodle-2-character-cache.md (Phase 4).
 */
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { validateSlug } from '@/lib/character-bible';

export interface SlugChipProps {
  /** Which field this chip edits. Drives icon, tooltip, and the
   *  "+ New" placeholder text. */
  kind: 'character' | 'scene';
  /** Current value on the row (the slug, or undefined when unset). */
  value: string | undefined;
  /** All slugs of this kind currently in use across the doc, plus
   *  their row counts. Sorted by the caller (the helper functions
   *  in `src/lib/character-bible.ts` produce this directly). */
  availableSlugs: ReadonlyArray<{ slug: string; count: number }>;
  /** Slugs in use but missing a description in
   *  `doc.doodle_explainer_2_character_descriptions`. Used to badge
   *  those slugs in the dropdown so the user knows which ones still
   *  need a description added. Only meaningful for `kind === 'character'`. */
  untaggedDescriptionSlugs?: ReadonlyArray<string>;
  /** Save callback. Pass undefined to clear the field. */
  onChange: (next: string | undefined) => void;
}

const ICONS = {
  character: '👤',
  scene: '🏛',
};

const KIND_LABELS = {
  character: { singular: 'character', titleCase: 'Character' },
  scene: { singular: 'scene', titleCase: 'Scene' },
};

export function SlugChip({
  kind,
  value,
  availableSlugs,
  untaggedDescriptionSlugs,
  onChange,
}: SlugChipProps) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const draftError = useMemo(() => {
    if (!adding) return null;
    if (draft.length === 0) return null; // don't shout before they type
    return validateSlug(draft);
  }, [adding, draft]);

  const untaggedSet = useMemo(
    () => new Set(untaggedDescriptionSlugs ?? []),
    [untaggedDescriptionSlugs],
  );

  // Close on outside click + ESC.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
        setDraft('');
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setAdding(false);
        setDraft('');
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Focus the input the moment we enter "adding" mode.
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  function commitNew() {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setAdding(false);
      return;
    }
    if (validateSlug(trimmed) !== null) return; // tooltip already shows
    onChange(trimmed);
    setOpen(false);
    setAdding(false);
    setDraft('');
  }

  const icon = ICONS[kind];
  const label = KIND_LABELS[kind];
  const chipTitle = value
    ? `${label.titleCase}_id: ${value}. Click to change.`
    : `No ${label.singular}_id set on this row. Click to assign.`;
  const display = value ?? '—';
  const isSet = Boolean(value);

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={chipTitle}
        className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap"
        style={{
          background: isSet ? 'rgba(34,211,238,0.12)' : 'rgba(120,120,120,0.10)',
          color: isSet ? '#22d3ee' : 'var(--text-muted)',
          border: isSet ? '1px solid rgba(34,211,238,0.35)' : '1px dashed var(--border)',
          cursor: 'pointer',
          maxWidth: 140,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {icon} {display}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Edit ${label.singular}_id`}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 50,
            background: 'var(--bg-card, #111)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 6,
            minWidth: 220,
            maxWidth: 280,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}
        >
          {adding ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value.toLowerCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitNew();
                  if (e.key === 'Escape') {
                    setAdding(false);
                    setDraft('');
                  }
                }}
                placeholder={kind === 'character' ? 'e.g. george, louis-as-adult' : 'e.g. sodder-house'}
                className="text-xs px-2 py-1 rounded"
                style={{
                  background: 'var(--bg-elevated, #1a1a1a)',
                  color: 'var(--text-primary)',
                  border: `1px solid ${draftError ? '#ef4444' : 'var(--border)'}`,
                  outline: 'none',
                }}
                maxLength={50}
              />
              {draftError && (
                <span className="text-[10px]" style={{ color: '#fca5a5' }}>
                  {draftError}
                </span>
              )}
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  onClick={commitNew}
                  disabled={draft.trim().length === 0 || validateSlug(draft.trim()) !== null}
                  className="text-[10px] px-2 py-1 rounded flex-1"
                  style={{
                    background: 'rgba(34,211,238,0.18)',
                    color: '#22d3ee',
                    border: '1px solid rgba(34,211,238,0.4)',
                    cursor: draft.trim().length === 0 || validateSlug(draft.trim()) !== null ? 'not-allowed' : 'pointer',
                    opacity: draft.trim().length === 0 || validateSlug(draft.trim()) !== null ? 0.5 : 1,
                  }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setDraft('');
                  }}
                  className="text-[10px] px-2 py-1 rounded"
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button
                type="button"
                onClick={() => {
                  setAdding(true);
                  setDraft('');
                }}
                className="text-[11px] px-2 py-1 rounded text-left"
                style={{
                  background: 'transparent',
                  color: '#22d3ee',
                  border: '1px dashed rgba(34,211,238,0.45)',
                  cursor: 'pointer',
                }}
              >
                + New {label.singular}_id…
              </button>
              {availableSlugs.length > 0 && (
                <div
                  style={{
                    maxHeight: 180,
                    overflowY: 'auto',
                    marginTop: 2,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                  }}
                >
                  {availableSlugs.map(({ slug, count }) => {
                    const selected = slug === value;
                    const untagged = kind === 'character' && untaggedSet.has(slug);
                    return (
                      <button
                        key={slug}
                        type="button"
                        onClick={() => {
                          onChange(slug);
                          setOpen(false);
                        }}
                        className="text-[11px] px-2 py-1 rounded text-left"
                        style={{
                          background: selected ? 'rgba(34,211,238,0.18)' : 'transparent',
                          color: selected ? '#22d3ee' : 'var(--text-primary)',
                          border: '1px solid transparent',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 6,
                        }}
                        title={
                          untagged
                            ? `"${slug}" is used on ${count} row(s) but has no description in the Character descriptions panel.`
                            : `"${slug}" is used on ${count} row(s) in this doc.`
                        }
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {slug} {untagged && <span style={{ color: '#fbbf24' }}>⚠</span>}
                        </span>
                        <span style={{ color: 'var(--text-muted)' }}>{count}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {isSet && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(undefined);
                    setOpen(false);
                  }}
                  className="text-[10px] px-2 py-1 rounded text-left"
                  style={{
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    border: '1px dashed var(--border)',
                    cursor: 'pointer',
                    marginTop: 2,
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
