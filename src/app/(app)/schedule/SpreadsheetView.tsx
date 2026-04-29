'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';
import { statusColor } from '@/lib/schedule';
import type { Channel } from './types';

type Props = {
  items: ScheduleItem[];
  statuses: ScheduleStatus[];
  channels: Channel[];
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Partial<ScheduleItem> & { channel_ids?: string[] }) => void;
  onDelete: (id: string, alsoChildren?: boolean) => void;
  onRefresh: () => void;
};

type ColumnKind = 'built-in' | 'custom';
type Column = {
  key: string;       // built-in key or custom field name
  label: string;
  kind: ColumnKind;
};

const BUILT_IN_COLUMNS: Column[] = [
  { key: 'title', label: 'Title', kind: 'built-in' },
  { key: 'scheduled_for', label: 'Scheduled', kind: 'built-in' },
  { key: 'status', label: 'Status', kind: 'built-in' },
  { key: 'channels', label: 'Channels', kind: 'built-in' },
  { key: 'notes', label: 'Notes', kind: 'built-in' },
  { key: 'tags', label: 'Tags', kind: 'built-in' },
];

function dtLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SpreadsheetView({ items, statuses, channels, onSelect, onPatch, onDelete, onRefresh }: Props) {
  // Discover custom field keys used anywhere in the dataset so every row shares the same column set.
  const customKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const it of items) {
      for (const k of Object.keys(it.custom_fields ?? {})) keys.add(k);
    }
    return Array.from(keys).sort();
  }, [items]);

  const [extraCustomKeys, setExtraCustomKeys] = useState<string[]>([]);
  const allCustomKeys = useMemo(
    () => Array.from(new Set([...customKeys, ...extraCustomKeys])),
    [customKeys, extraCustomKeys],
  );

  const columns: Column[] = useMemo(() => [
    ...BUILT_IN_COLUMNS,
    ...allCustomKeys.map(k => ({ key: k, label: k, kind: 'custom' as ColumnKind })),
  ], [allCustomKeys]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleRow = (id: string) => {
    setSelectedIds(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleAll = () => {
    setSelectedIds(s => (s.size === items.length ? new Set() : new Set(items.map(i => i.id))));
  };

  function addCustomColumn() {
    const name = window.prompt('New custom field name (e.g. "thumbnail_done", "runtime_minutes")');
    if (!name) return;
    const trimmed = name.trim().replace(/\s+/g, '_').toLowerCase();
    if (!trimmed) return;
    setExtraCustomKeys(k => k.includes(trimmed) ? k : [...k, trimmed]);
  }

  async function bulkSetStatus(status: string) {
    await Promise.all(Array.from(selectedIds).map(id => onPatch(id, { status })));
    toast.success(`Updated ${selectedIds.size} rows`);
  }

  async function bulkDelete() {
    if (!window.confirm(`Delete ${selectedIds.size} rows?`)) return;
    await Promise.all(Array.from(selectedIds).map(id => onDelete(id)));
    setSelectedIds(new Set());
  }

  function exportCsv() {
    const escape = (raw: unknown) => {
      const s = Array.isArray(raw)
        ? raw.join('; ')
        : raw == null
          ? ''
          : typeof raw === 'string' ? raw : JSON.stringify(raw);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['id', ...columns.map(c => c.label)].map(escape).join(',');
    const rows = items.map(it => [it.id, ...columns.map(col => cellValue(it, col))].map(escape).join(','));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `schedule-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function cellValue(it: ScheduleItem, col: Column): string | string[] {
    if (col.kind === 'custom') {
      const v = it.custom_fields?.[col.key];
      return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
    }
    switch (col.key) {
      case 'title': return it.title;
      case 'scheduled_for': return it.scheduled_for ?? '';
      case 'status': return it.status;
      case 'channels': return (it.channels ?? []).map(c => c.name);
      case 'notes': return it.notes ?? '';
      case 'tags': return it.tags ?? [];
      default: return '';
    }
  }

  if (items.length === 0) {
    return (
      <div className="py-20 text-center rounded-lg"
        style={{ background: 'var(--bg-secondary)', border: '1px dashed var(--border)', color: 'var(--text-muted)' }}>
        No items — create your first video or add one from the ideas page.
      </div>
    );
  }

  return (
    <div>
      {/* Bulk toolbar */}
      <div className="flex items-center gap-2 mb-3">
        <button onClick={addCustomColumn}
          className="text-xs px-3 py-1.5 rounded-md"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
          + Add column
        </button>
        <button onClick={exportCsv}
          className="text-xs px-3 py-1.5 rounded-md"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
          Export CSV
        </button>
        <button onClick={onRefresh}
          className="text-xs px-3 py-1.5 rounded-md"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
          Refresh
        </button>

        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{selectedIds.size} selected</span>
            <select
              onChange={e => { if (e.target.value) { bulkSetStatus(e.target.value); e.target.value = ''; } }}
              className="text-xs px-2 py-1.5 rounded-md"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value="">Set status…</option>
              {statuses.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <button onClick={bulkDelete}
              className="text-xs px-3 py-1.5 rounded-md"
              style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="rounded-lg overflow-x-auto"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <table className="w-full text-sm" style={{ minWidth: 960 }}>
          <thead>
            <tr style={{ background: 'var(--bg-tertiary)' }}>
              <th className="w-8 p-2">
                <input type="checkbox"
                  checked={selectedIds.size === items.length && items.length > 0}
                  onChange={toggleAll} />
              </th>
              {columns.map(col => (
                <th key={col.key}
                  className="text-left px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--text-muted)' }}>
                  {col.label}
                </th>
              ))}
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.id}
                style={{ borderTop: '1px solid var(--border)',
                  background: selectedIds.has(it.id) ? 'rgba(124,58,237,0.07)' : 'transparent' }}>
                <td className="p-2 text-center">
                  <input type="checkbox"
                    checked={selectedIds.has(it.id)}
                    onChange={() => toggleRow(it.id)} />
                </td>
                {columns.map(col => (
                  <td key={col.key} className="px-3 py-1.5" style={{ color: 'var(--text-primary)' }}>
                    <Cell item={it} column={col} statuses={statuses} channels={channels} onPatch={onPatch} />
                  </td>
                ))}
                <td className="p-2">
                  <button onClick={() => onSelect(it.id)}
                    className="text-xs px-2 py-1 rounded"
                    style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                    title="Open detail">
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ item, column, statuses, channels, onPatch }: {
  item: ScheduleItem;
  column: Column;
  statuses: ScheduleStatus[];
  channels: Channel[];
  onPatch: (id: string, patch: Partial<ScheduleItem> & { channel_ids?: string[] }) => void;
}) {
  const common = {
    className: 'w-full bg-transparent outline-none text-sm px-2 py-1 rounded',
    style: { color: 'var(--text-primary)', border: '1px solid transparent' },
    onFocus: (e: React.FocusEvent<HTMLElement>) => { (e.currentTarget.style as CSSStyleDeclaration).border = '1px solid var(--border)'; },
    onBlur: (e: React.FocusEvent<HTMLElement>) => { (e.currentTarget.style as CSSStyleDeclaration).border = '1px solid transparent'; },
  };

  if (column.kind === 'custom') {
    const raw = item.custom_fields?.[column.key];
    const value = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
    return (
      <input
        {...common}
        defaultValue={value}
        onBlur={e => {
          const next = { ...(item.custom_fields ?? {}), [column.key]: e.currentTarget.value };
          onPatch(item.id, { custom_fields: next });
          common.onBlur(e);
        }}
      />
    );
  }

  switch (column.key) {
    case 'title':
      return (
        <input
          {...common}
          defaultValue={item.title}
          onBlur={e => { if (e.currentTarget.value !== item.title) onPatch(item.id, { title: e.currentTarget.value }); common.onBlur(e); }}
        />
      );
    case 'scheduled_for':
      return (
        <input
          type="datetime-local"
          {...common}
          defaultValue={dtLocal(item.scheduled_for)}
          onBlur={e => {
            const raw = e.currentTarget.value;
            const iso = raw ? new Date(raw).toISOString() : null;
            onPatch(item.id, { scheduled_for: iso });
            common.onBlur(e);
          }}
        />
      );
    case 'status':
      return (
        <select
          value={item.status}
          onChange={e => onPatch(item.id, { status: e.target.value })}
          className="px-2 py-0.5 rounded text-xs font-medium cursor-pointer"
          style={{
            background: statusColor(statuses, item.status) + '22',
            color: statusColor(statuses, item.status),
            border: `1px solid ${statusColor(statuses, item.status)}55`,
          }}
        >
          {statuses.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      );
    case 'channels': {
      const selectedIds = new Set((item.channels ?? []).map(c => c.id));
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {(item.channels ?? []).map(c => (
            <span key={c.id} className="text-[11px] px-1.5 py-0.5 rounded"
              style={{ background: (c.account_color || '#7c3aed') + '33', color: c.account_color || 'var(--text-primary)' }}>
              {c.name}
            </span>
          ))}
          <select
            onChange={e => {
              const id = e.target.value;
              if (!id) return;
              const next = selectedIds.has(id)
                ? Array.from(selectedIds).filter(x => x !== id)
                : [...Array.from(selectedIds), id];
              onPatch(item.id, { channel_ids: next });
              e.target.value = '';
            }}
            className="text-xs px-1 py-0.5 rounded bg-transparent"
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
          >
            <option value="">+</option>
            {channels.map(c => (
              <option key={c.id} value={c.id}>
                {selectedIds.has(c.id) ? '− ' : '+ '}{c.name}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case 'notes':
      return (
        <input
          {...common}
          defaultValue={item.notes ?? ''}
          onBlur={e => { if (e.currentTarget.value !== (item.notes ?? '')) onPatch(item.id, { notes: e.currentTarget.value }); common.onBlur(e); }}
        />
      );
    case 'tags':
      return (
        <input
          {...common}
          defaultValue={(item.tags ?? []).join(', ')}
          placeholder="tag, tag, tag"
          onBlur={e => {
            const tags = e.currentTarget.value.split(',').map(t => t.trim()).filter(Boolean);
            onPatch(item.id, { tags });
            common.onBlur(e);
          }}
        />
      );
  }
  return null;
}
