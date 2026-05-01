'use client';

import type * as React from 'react';

export type AssignmentViewMode = 'cards' | 'kanban' | 'table';

const STORAGE_KEY = 'assignmentViewMode';

export function loadViewMode(role: string, fallback: AssignmentViewMode = 'cards'): AssignmentViewMode {
  if (typeof window === 'undefined') return fallback;
  const v = window.localStorage.getItem(`${STORAGE_KEY}:${role}`);
  if (v === 'cards' || v === 'kanban' || v === 'table') return v;
  return fallback;
}

export function saveViewMode(role: string, mode: AssignmentViewMode) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(`${STORAGE_KEY}:${role}`, mode);
}

const ICONS: Record<AssignmentViewMode, React.ReactNode> = {
  cards: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  kanban: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="5" height="18" rx="1.5" />
      <rect x="10" y="3" width="5" height="13" rx="1.5" />
      <rect x="17" y="3" width="4" height="9" rx="1.5" />
    </svg>
  ),
  table: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="14" x2="21" y2="14" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  ),
};

const LABELS: Record<AssignmentViewMode, string> = {
  cards: 'Cards',
  kanban: 'Kanban',
  table: 'Table',
};

export function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: AssignmentViewMode;
  onChange: (m: AssignmentViewMode) => void;
}) {
  const modes: AssignmentViewMode[] = ['cards', 'kanban', 'table'];
  return (
    <div
      className="inline-flex items-center gap-0.5 p-0.5 rounded-lg"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
    >
      {modes.map(m => {
        const active = m === mode;
        return (
          <button
            key={m}
            onClick={() => onChange(m)}
            title={`${LABELS[m]} view`}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all"
            style={{
              background: active ? 'rgba(124,58,237,0.18)' : 'transparent',
              color: active ? '#a78bfa' : 'var(--text-muted)',
            }}
          >
            <span style={{ display: 'inline-flex' }}>{ICONS[m]}</span>
            <span className="hidden sm:inline">{LABELS[m]}</span>
          </button>
        );
      })}
    </div>
  );
}
