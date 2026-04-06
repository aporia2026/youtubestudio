'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface HistoryItem {
  id: string;
  timestamp: number;
  label: string;
  sublabel: string;
  preview?: string;
}

interface HistoryPanelProps {
  title: string;
  icon: string;
  items: HistoryItem[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  accentColor?: string;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function HistoryPanel({ title, icon, items, onRestore, onDelete, onClearAll, accentColor = 'var(--accent-purple)' }: HistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = search
    ? items.filter(i =>
        i.label.toLowerCase().includes(search.toLowerCase()) ||
        i.sublabel.toLowerCase().includes(search.toLowerCase()) ||
        (i.preview || '').toLowerCase().includes(search.toLowerCase())
      )
    : items;

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed right-0 top-1/2 -translate-y-1/2 z-40 px-1.5 py-6 rounded-l-lg transition-all"
        style={{
          background: open ? accentColor : 'var(--bg-card)',
          border: `1px solid ${open ? accentColor : 'var(--border)'}`,
          borderRight: 'none',
          color: open ? 'white' : 'var(--text-muted)',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 1,
        }}
      >
        {icon} {title} {items.length > 0 && `(${items.length})`}
      </button>

      {/* Slide-out panel */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40"
              style={{ background: 'rgba(0,0,0,0.3)' }}
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="fixed right-0 top-0 bottom-0 z-50 flex flex-col"
              style={{
                width: 380,
                background: 'var(--bg-primary)',
                borderLeft: '1px solid var(--border)',
                boxShadow: '-10px 0 40px rgba(0,0,0,0.3)',
              }}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2">
                  <span>{icon}</span>
                  <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
                  <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: `${accentColor}20`, color: accentColor }}>
                    {items.length}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {items.length > 0 && (
                    <button
                      onClick={() => { if (confirm('Clear all history?')) onClearAll(); }}
                      className="text-xs px-2 py-1 rounded"
                      style={{ color: '#ef4444' }}
                    >
                      Clear all
                    </button>
                  )}
                  <button onClick={() => setOpen(false)} className="text-lg" style={{ color: 'var(--text-muted)' }}>×</button>
                </div>
              </div>

              {/* Search */}
              <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search history..."
                  className="input-field w-full"
                  style={{ fontSize: 12, padding: '8px 12px' }}
                />
              </div>

              {/* Items */}
              <div className="flex-1 overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
                    <p className="text-sm">{search ? 'No results found' : 'No history yet'}</p>
                    <p className="text-xs mt-1">{search ? 'Try different keywords' : 'Generated content will appear here'}</p>
                  </div>
                ) : (
                  <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                    {filtered.map(item => (
                      <div
                        key={item.id}
                        className="px-4 py-3 transition-colors cursor-pointer group"
                        style={{ borderBottom: '1px solid var(--border)' }}
                        onClick={() => { onRestore(item.id); setOpen(false); }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-card-hover)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                              {item.label}
                            </p>
                            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {item.sublabel}
                            </p>
                            {item.preview && (
                              <p className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                                {item.preview}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{timeAgo(item.timestamp)}</span>
                            <button
                              onClick={e => { e.stopPropagation(); onDelete(item.id); }}
                              className="text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ color: '#ef4444' }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
