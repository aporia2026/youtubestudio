'use client';

/**
 * NichePicker — combobox-style picker for the production-doc / generator
 * Niche field. Combines free-text entry (so you can type a niche that
 * isn't in your list) with a click-to-open dropdown that surfaces:
 *
 *   1. Your workspace's configured niches (Settings → Niches)
 *   2. Plus any recent niches from this browser's history that aren't
 *      already in the configured list
 *
 * Replaces the prior `AutocompleteInput`-based niche field which used a
 * native `<datalist>`. Browsers filter datalists by typed prefix, so a
 * field that's pre-populated with a value would never show the user
 * their full configured list until they cleared the input — a real UX
 * gap raised 2026-05-26.
 *
 * Behavior:
 * - Click ▼ → opens dropdown of all suggestions. Click a row → fills.
 * - Type into the input → free-text entry; dropdown closes on selection.
 * - Click outside → closes.
 * - Escape → closes without changing the value.
 */

import { useEffect, useRef, useState } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  required?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function NichePicker({
  value,
  onChange,
  suggestions,
  placeholder,
  required,
  className = 'input-field',
  style,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dedupe while preserving order so workspace niches and recent niches
  // don't show twice. Case-insensitive dedup, first occurrence wins.
  const deduped = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of suggestions) {
      const key = s.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s.trim());
    }
    return out;
  })();

  // Close on outside click. Tracks the root, so clicks inside the
  // dropdown itself don't fire the close.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-stretch">
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          autoComplete="off"
          className={className}
          style={{
            ...style,
            paddingRight: 36,
            width: '100%',
          }}
          onKeyDown={e => {
            if (e.key === 'Escape' && open) {
              e.preventDefault();
              setOpen(false);
            }
          }}
          onFocus={() => {
            if (deduped.length > 0) setOpen(true);
          }}
        />
        <button
          type="button"
          aria-label={open ? 'Hide niche list' : 'Show niche list'}
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          className="absolute top-0 bottom-0 flex items-center justify-center"
          style={{
            right: 0,
            width: 36,
            color: 'var(--text-muted)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
          }}
          tabIndex={-1}
        >
          ▼
        </button>
      </div>
      {open && deduped.length > 0 && (
        <div
          role="listbox"
          className="absolute z-50 left-0 right-0 mt-1 rounded overflow-y-auto"
          style={{
            top: '100%',
            maxHeight: 280,
            background: 'var(--bg-secondary, #0d0d14)',
            border: '1px solid var(--border, rgba(255,255,255,0.1))',
            boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
          }}
        >
          {deduped.map(s => {
            const selected = s === value;
            return (
              <button
                key={s}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(s);
                  setOpen(false);
                }}
                className="block w-full text-left px-3 py-2 text-sm"
                style={{
                  background: selected ? 'rgba(124,58,237,0.18)' : 'transparent',
                  color: 'var(--text-primary, #f0f0ff)',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => {
                  if (!selected) {
                    (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
                  }
                }}
                onMouseLeave={e => {
                  if (!selected) {
                    (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  }
                }}
              >
                {s}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
