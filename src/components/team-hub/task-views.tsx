'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  ViewModeToggle,
  loadViewMode,
  saveViewMode,
  type AssignmentViewMode,
} from '@/components/dashboard/ViewModeToggle';

/**
 * Shared toolbar + state hook for the per-role Tasks tab views in
 * /team-hub. Each role-specific tab (NarratorTasksTab, EditorTasksTab,
 * ReviewerTasksTab) wires up the same four controls — search, filter
 * chips, sort, view-mode toggle — using these primitives so the surface
 * feels consistent across roles.
 *
 * Why a hook + a single toolbar component (rather than three full
 * copies)? The state shape is identical regardless of role; the data
 * the controls operate on isn't. Owning state + chrome here keeps a
 * change-or-bug fix in one place.
 *
 * Persistence: each (roleKey, control) pair is stored in localStorage
 * via a stable namespace, so a returning user lands on the view they
 * had last time. View-mode reuses the existing
 * `assignmentViewMode:<role>` key from ViewModeToggle so the team-hub
 * inherits whatever the user picked on the legacy /narrator and /editor
 * portals.
 */

export type SortDirection = 'asc' | 'desc';

export interface SortOption<F extends string> {
  field: F;
  /** Display label in the sort dropdown. */
  label: string;
}

export interface SortState<F extends string> {
  field: F;
  direction: SortDirection;
}

export interface FilterOption<F extends string> {
  key: F;
  label: string;
  /** Optional count shown in the chip — passed in by the caller after
   *  the filter has been applied so we don't double-iterate the data. */
  count?: number;
  /** Visual tone — 'urgent' draws the chip in red regardless of active
   *  state so a "5 overdue" pill draws the eye. */
  tone?: 'urgent';
}

const NS = 'teamHubTasks';

function lsKey(role: string, control: 'search' | 'filter' | 'sort'): string {
  return `${NS}:${role}:${control}`;
}

function readLs(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLs(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Quota / disabled storage — silently degrade.
  }
}

interface UseTaskListControlsOptions<F extends string, S extends string> {
  /** Stable role key used as the localStorage namespace. Pick one per
   *  tab — sharing a key across tabs would let a narrator filter leak
   *  into the editor tab on next open. */
  roleKey: string;
  defaultFilter: F;
  defaultSort: SortState<S>;
  defaultView?: AssignmentViewMode;
  /** Allowed values for runtime defence — stored values that don't pass
   *  the guard fall back to the default (eg. an old key from a
   *  previous schema). */
  allowedFilters: readonly F[];
  allowedSortFields: readonly S[];
}

export interface TaskListControls<F extends string, S extends string> {
  search: string;
  setSearch: (v: string) => void;
  filter: F;
  setFilter: (v: F) => void;
  sort: SortState<S>;
  setSort: (v: SortState<S>) => void;
  view: AssignmentViewMode;
  setView: (v: AssignmentViewMode) => void;
}

/**
 * Per-role hook that owns the four control values + persists them.
 *
 * Initial render returns the defaults so SSR/CSR don't disagree. An
 * effect on mount hydrates from localStorage. Updates write through.
 */
export function useTaskListControls<F extends string, S extends string>(
  opts: UseTaskListControlsOptions<F, S>,
): TaskListControls<F, S> {
  const {
    roleKey,
    defaultFilter,
    defaultSort,
    defaultView = 'cards',
    allowedFilters,
    allowedSortFields,
  } = opts;

  const [search, setSearchState] = useState('');
  const [filter, setFilterState] = useState<F>(defaultFilter);
  const [sort, setSortState] = useState<SortState<S>>(defaultSort);
  const [view, setViewState] = useState<AssignmentViewMode>(defaultView);

  // Hydrate from localStorage on mount. Uses guards so a malformed
  // stored value never blows up the page.
  useEffect(() => {
    const storedSearch = readLs(lsKey(roleKey, 'search')) ?? '';
    setSearchState(storedSearch);

    const storedFilter = readLs(lsKey(roleKey, 'filter'));
    if (storedFilter && (allowedFilters as readonly string[]).includes(storedFilter)) {
      setFilterState(storedFilter as F);
    }

    const storedSort = readLs(lsKey(roleKey, 'sort'));
    if (storedSort) {
      const [field, direction] = storedSort.split(':');
      if (
        (allowedSortFields as readonly string[]).includes(field) &&
        (direction === 'asc' || direction === 'desc')
      ) {
        setSortState({ field: field as S, direction });
      }
    }

    setViewState(loadViewMode(roleKey, defaultView));
  }, [roleKey, defaultView, allowedFilters, allowedSortFields]);

  const setSearch = useCallback(
    (v: string) => {
      setSearchState(v);
      writeLs(lsKey(roleKey, 'search'), v ? v : null);
    },
    [roleKey],
  );
  const setFilter = useCallback(
    (v: F) => {
      setFilterState(v);
      writeLs(lsKey(roleKey, 'filter'), v);
    },
    [roleKey],
  );
  const setSort = useCallback(
    (v: SortState<S>) => {
      setSortState(v);
      writeLs(lsKey(roleKey, 'sort'), `${v.field}:${v.direction}`);
    },
    [roleKey],
  );
  const setView = useCallback(
    (v: AssignmentViewMode) => {
      setViewState(v);
      saveViewMode(roleKey, v);
    },
    [roleKey],
  );

  return { search, setSearch, filter, setFilter, sort, setSort, view, setView };
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

interface TaskListToolbarProps<F extends string, S extends string> {
  total: number;
  visible: number;
  search: string;
  onSearchChange: (v: string) => void;
  filter: F;
  filterOptions: readonly FilterOption<F>[];
  onFilterChange: (v: F) => void;
  sort: SortState<S>;
  sortOptions: readonly SortOption<S>[];
  onSortChange: (v: SortState<S>) => void;
  view: AssignmentViewMode;
  onViewChange: (v: AssignmentViewMode) => void;
}

export function TaskListToolbar<F extends string, S extends string>({
  total,
  visible,
  search,
  onSearchChange,
  filter,
  filterOptions,
  onFilterChange,
  sort,
  sortOptions,
  onSortChange,
  view,
  onViewChange,
}: TaskListToolbarProps<F, S>) {
  return (
    <div
      className="sticky top-0 z-10 border-b px-6 py-3 flex flex-wrap items-center gap-2"
      style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
    >
      {/* Filter chips */}
      <div className="flex items-center gap-1 flex-wrap">
        {filterOptions.map((opt) => {
          const active = filter === opt.key;
          const accent = opt.tone === 'urgent' ? '#ef4444' : '#a78bfa';
          return (
            <button
              key={opt.key}
              onClick={() => onFilterChange(opt.key)}
              className="text-[11px] px-2.5 py-1 rounded-full font-medium transition-colors flex items-center gap-1.5"
              style={{
                background: active ? `${accent}22` : 'transparent',
                color: active ? accent : 'var(--text-muted)',
                border: `1px solid ${active ? accent : 'var(--border)'}`,
              }}
            >
              <span>{opt.label}</span>
              {opt.count != null && (
                <span className="text-[10px] opacity-70">{opt.count}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="ml-auto flex items-center gap-2 flex-wrap">
        {/* Search */}
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search…"
            className="pl-7 pr-3 py-1 rounded-md text-[11px] outline-none"
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              minWidth: 160,
            }}
          />
          <svg
            className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none"
            width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            style={{ color: 'var(--text-muted)' }}
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>

        {/* Sort dropdown */}
        <SortControl sort={sort} options={sortOptions} onChange={onSortChange} />

        {/* View toggle */}
        <ViewModeToggle mode={view} onChange={onViewChange} />

        {/* Result count */}
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {visible === total ? `${total}` : `${visible} of ${total}`}
        </span>
      </div>
    </div>
  );
}

interface SortControlProps<S extends string> {
  sort: SortState<S>;
  options: readonly SortOption<S>[];
  onChange: (next: SortState<S>) => void;
}

function SortControl<S extends string>({ sort, options, onChange }: SortControlProps<S>) {
  const current = options.find((o) => o.field === sort.field);
  const dirGlyph = sort.direction === 'asc' ? '↑' : '↓';

  return (
    <div
      className="inline-flex items-center gap-0.5 p-0.5 rounded-md"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
    >
      <select
        value={sort.field}
        onChange={(e) =>
          onChange({ field: e.target.value as S, direction: sort.direction })
        }
        className="appearance-none bg-transparent outline-none text-[11px] px-2 py-0.5 cursor-pointer"
        style={{ color: 'var(--text-primary)' }}
      >
        {options.map((opt) => (
          <option key={opt.field} value={opt.field} style={{ background: '#1a1a1a', color: '#fff' }}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        onClick={() =>
          onChange({ field: sort.field, direction: sort.direction === 'asc' ? 'desc' : 'asc' })
        }
        className="px-1.5 py-0.5 rounded text-[11px] font-medium"
        style={{ color: 'var(--text-muted)' }}
        title={`Sort ${sort.direction === 'asc' ? 'ascending' : 'descending'} by ${current?.label ?? sort.field}`}
      >
        {dirGlyph}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Case-insensitive contains — used by every role's search box. */
export function matchesSearch(haystack: (string | null | undefined)[], q: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return haystack.some((s) => (s ?? '').toLowerCase().includes(needle));
}

/** Stable comparator that handles nullable strings, numbers, and dates. */
export function compareValues(a: unknown, b: unknown, dir: SortDirection): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  // Nulls always sort last regardless of direction — null deadlines
  // shouldn't bubble to the top of "soonest first."
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  let cmp = 0;
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b;
  } else if (a instanceof Date && b instanceof Date) {
    cmp = a.getTime() - b.getTime();
  } else {
    cmp = String(a).localeCompare(String(b));
  }
  return dir === 'asc' ? cmp : -cmp;
}

/** Resolve a date-or-null value to a millisecond timestamp for sorting. */
export function dateMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Friendly relative-time formatter, shared across the per-role rows. */
export function timeAgo(s: string | null): string {
  if (!s) return 'never';
  const diff = Date.now() - new Date(s).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export interface DeadlineHint {
  text: string;
  tone: 'normal' | 'soon' | 'overdue' | 'none';
}

export function deadlineHint(deadline: string | null): DeadlineHint {
  if (!deadline) return { text: 'No deadline', tone: 'none' };
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms < 0) {
    const d = Math.floor(-ms / (24 * 60 * 60 * 1000));
    return { text: d === 0 ? 'Overdue today' : `Overdue ${d}d`, tone: 'overdue' };
  }
  const d = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (d <= 2) return { text: d === 0 ? 'Due today' : `Due in ${d}d`, tone: 'soon' };
  return { text: `Due in ${d}d`, tone: 'normal' };
}

/** Build the index used by the kanban groupBy step. */
export function groupByStatus<T extends { status: string }, K extends string>(
  rows: readonly T[],
  columns: readonly { key: K; statuses: readonly string[] }[],
  fallbackKey: K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const c of columns) out[c.key] = [];
  for (const row of rows) {
    const col = columns.find((c) => (c.statuses as readonly string[]).includes(row.status));
    out[col ? col.key : fallbackKey].push(row);
  }
  return out;
}

// Re-export for convenient import sites.
export { type AssignmentViewMode };
