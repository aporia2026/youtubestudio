'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import type { ScheduleItem, ScheduleStatus } from '@/lib/schedule';
import {
  exportScheduleCSV,
  exportScheduleListPDF,
  exportScheduleCalendarPDF,
} from '@/lib/schedule-export';

type Props = {
  items: ScheduleItem[];
  statuses: ScheduleStatus[];
  scopeLabel: string;
};

type Item = { key: string; label: string; hint: string; run: () => Promise<void> | void };

export function ExportMenu({ items, statuses, scopeLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function exportSheets() {
    // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
    const res = await fetch('/api/schedule/export-sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exportData: { scopeLabel, items, statuses } }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.sheetUrl) {
      toast.success('Sheet created', {
        action: { label: 'Open', onClick: () => window.open(data.sheetUrl, '_blank') },
      });
      window.open(data.sheetUrl, '_blank');
      return;
    }
    if (data.error === 'NEEDS_GOOGLE_AUTH') {
      toast.error('Connect Google in Settings → Google Account first');
      return;
    }
    if (data.error === 'NEEDS_REAUTH') {
      toast.error(data.message || 'Reconnect your Google account');
      return;
    }
    toast.error(data.message || data.error || 'Export failed');
  }

  const exports: Item[] = [
    {
      key: 'csv',
      label: 'CSV',
      hint: 'Spreadsheet-compatible file',
      run: () => exportScheduleCSV(items, scopeLabel),
    },
    {
      key: 'pdf-list',
      label: 'PDF (list)',
      hint: 'Printable list with status, dates, notes',
      run: () => exportScheduleListPDF(items, statuses, scopeLabel),
    },
    {
      key: 'pdf-calendar',
      label: 'PDF (calendar)',
      hint: 'Landscape month grid, one page per month',
      run: () => exportScheduleCalendarPDF(items, scopeLabel),
    },
    {
      key: 'sheets',
      label: 'Google Sheets',
      hint: 'Creates a new sheet in your Drive',
      run: exportSheets,
    },
  ];

  async function run(item: Item) {
    try {
      setBusy(item.key);
      await item.run();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  }

  const disabled = items.length === 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all"
        style={{
          background: 'var(--bg-secondary)',
          color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
          border: '1px solid var(--border)',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Export
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="absolute right-0 mt-2 w-72 rounded-lg z-40 overflow-hidden"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 10px 40px rgba(0,0,0,0.4)' }}
            >
              <div className="px-3 py-2 text-[10px] uppercase tracking-wider font-semibold"
                style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                Export {items.length} item{items.length === 1 ? '' : 's'} · {scopeLabel}
              </div>
              <div className="py-1">
                {exports.map(it => (
                  <button
                    key={it.key}
                    onClick={() => run(it)}
                    disabled={!!busy}
                    className="w-full text-left px-3 py-2.5 transition-colors"
                    style={{
                      color: 'var(--text-primary)',
                      opacity: busy && busy !== it.key ? 0.4 : 1,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div className="text-sm font-medium">
                      {it.label}{busy === it.key ? ' …' : ''}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{it.hint}</div>
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
