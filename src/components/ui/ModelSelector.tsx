'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AI_MODELS, AIModel, AIProvider, formatModelPricing } from '@/lib/ai-models';
import { rankModel, highlight, tokens } from '@/lib/model-search';

const PROVIDER_COLORS: Record<AIProvider, string> = {
  anthropic: '#7c3aed',
  openai: '#10b981',
  google: '#3b82f6',
  kie: '#f59e0b',
  perplexity: '#06b6d4',
};

const PROVIDER_LABELS: Record<AIProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  kie: 'Kie.ai',
  perplexity: 'Perplexity',
};

type TierKey = 'flagship' | 'balanced' | 'fast';
const TIER_LABELS: Record<TierKey, { label: string; color: string }> = {
  flagship: { label: 'Flagship', color: 'var(--accent-purple-bright)' },
  balanced: { label: 'Balanced', color: 'var(--accent-cyan-bright)' },
  fast: { label: 'Fast', color: 'var(--accent-green)' },
};

type ProviderFilter = AIProvider | 'all';

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
  label?: string;
}

export function ModelSelector({ value, onChange, label = 'AI Model' }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [tierFilter, setTierFilter] = useState<Set<TierKey>>(new Set());
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = AI_MODELS.find(m => m.id === value) || AI_MODELS[0];

  const queryActive = search.trim().length > 0;

  // Per-provider counts (after tier+search filter, but BEFORE provider filter
  // — used to populate the count badges on each provider tab).
  const providerCounts = useMemo(() => {
    const counts: Record<AIProvider, number> = { anthropic: 0, openai: 0, google: 0, kie: 0, perplexity: 0 };
    for (const m of AI_MODELS) {
      if (tierFilter.size > 0 && !tierFilter.has(m.tier)) continue;
      if (queryActive && rankModel(search, m) === 0) continue;
      counts[m.provider]++;
    }
    return counts;
  }, [search, tierFilter, queryActive]);

  // Filtered + grouped list to render. When a query is active we sort by
  // rank descending so the best match is at the top — provider grouping is
  // dropped in that mode (the cross-provider best match is what the user
  // is asking for). With no query, we keep stable AI_MODELS order so the
  // grouped view feels predictable.
  const grouped = useMemo(() => {
    const scored: Array<{ model: AIModel; rank: number }> = [];
    for (const m of AI_MODELS) {
      if (providerFilter !== 'all' && m.provider !== providerFilter) continue;
      if (tierFilter.size > 0 && !tierFilter.has(m.tier)) continue;
      const rank = rankModel(search, m);
      if (rank === 0) continue;
      scored.push({ model: m, rank });
    }
    if (queryActive) {
      // Stable sort by rank desc — ties keep the AI_MODELS order.
      scored.sort((a, b) => b.rank - a.rank);
    }
    const flat = scored.map((s) => s.model);
    const byProvider: Record<AIProvider, AIModel[]> = { anthropic: [], openai: [], google: [], kie: [], perplexity: [] };
    for (const m of flat) byProvider[m.provider].push(m);
    return { byProvider, flat };
  }, [search, providerFilter, tierFilter, queryActive]);

  // Reset state on open
  useEffect(() => {
    if (!open) return;
    setSearch('');
    setProviderFilter('all');
    setTierFilter(new Set());
    setKeyboardIndex(grouped.flat.findIndex(m => m.id === value));
    requestAnimationFrame(() => searchRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset keyboard index when the filtered list changes shape.
  useEffect(() => {
    setKeyboardIndex(0);
  }, [search, providerFilter, tierFilter]);

  // Esc to close, Up/Down to navigate, Enter to select.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setKeyboardIndex(i => Math.min(grouped.flat.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setKeyboardIndex(i => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter') {
        const m = grouped.flat[keyboardIndex];
        if (m) {
          e.preventDefault();
          onChange(m.id);
          setOpen(false);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, grouped.flat, keyboardIndex, onChange]);

  // Keep the keyboard-focused row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector(`[data-kb-index="${keyboardIndex}"]`) as HTMLElement | null;
    if (node) node.scrollIntoView({ block: 'nearest' });
  }, [keyboardIndex, open]);

  function toggleTier(t: TierKey) {
    setTierFilter(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }

  // List of providers shown in the tab strip — only those that have at least
  // one model registered. Order is fixed (most-used first).
  const providerOrder: AIProvider[] = ['anthropic', 'openai', 'google', 'kie', 'perplexity'];

  let flatIdx = -1; // running counter so each rendered row gets a stable kb index

  return (
    <div className="relative">
      {label && (
        <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </label>
      )}
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-left transition-all"
        style={{
          background: 'var(--bg-secondary)',
          border: `1px solid ${open ? 'var(--accent-purple)' : 'var(--border)'}`,
          color: 'var(--text-primary)',
          boxShadow: open ? '0 0 0 3px rgba(124,58,237,0.15)' : 'none',
        }}
      >
        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PROVIDER_COLORS[selected.provider] }} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{selected.name}</div>
          <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
            {PROVIDER_LABELS[selected.provider]} · {selected.contextWindow} · {formatModelPricing(selected)}
            {selected.webSearch ? ' · web search' : ''}
          </div>
        </div>
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97 }}
              transition={{ duration: 0.15 }}
              className="absolute top-full mt-2 left-0 right-0 rounded-xl overflow-hidden flex flex-col z-50"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-bright)',
                boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
                maxHeight: '70vh',
              }}
            >
              {/* Search + filter header (sticky) */}
              <div className="shrink-0 p-2.5 space-y-2" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="relative">
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                  </svg>
                  <input
                    ref={searchRef}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={`Search ${AI_MODELS.length} models…`}
                    className="w-full pl-9 pr-3 py-2 rounded-lg text-sm"
                    style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    onKeyDown={e => {
                      // Don't let the global ↑/↓/Enter handler also fire when
                      // the user's typing in the input — but we DO want them
                      // to navigate the list. Handled via window listener,
                      // which still receives the events.
                      if (e.key === 'Escape') e.stopPropagation();
                    }}
                  />
                </div>

                {/* Provider tabs */}
                <div className="flex flex-wrap gap-1">
                  <FilterChip
                    active={providerFilter === 'all'}
                    onClick={() => setProviderFilter('all')}
                    color="var(--accent-purple-bright)"
                    label="All"
                    count={grouped.flat.length}
                  />
                  {providerOrder.map(p => {
                    const count = providerCounts[p];
                    if (count === 0) return null;
                    return (
                      <FilterChip
                        key={p}
                        active={providerFilter === p}
                        onClick={() => setProviderFilter(p)}
                        color={PROVIDER_COLORS[p]}
                        label={PROVIDER_LABELS[p]}
                        count={count}
                      />
                    );
                  })}
                </div>

                {/* Tier filters */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider mr-1" style={{ color: 'var(--text-muted)' }}>Tier:</span>
                  {(['flagship', 'balanced', 'fast'] as const).map(t => (
                    <FilterChip
                      key={t}
                      active={tierFilter.has(t)}
                      onClick={() => toggleTier(t)}
                      color={TIER_LABELS[t].color}
                      label={TIER_LABELS[t].label}
                      compact
                    />
                  ))}
                  {(tierFilter.size > 0 || providerFilter !== 'all' || search) && (
                    <button
                      onClick={() => { setTierFilter(new Set()); setProviderFilter('all'); setSearch(''); }}
                      className="text-[10px] px-2 py-1 ml-auto rounded transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* List */}
              <div ref={listRef} className="flex-1 overflow-y-auto">
                {grouped.flat.length === 0 ? (
                  <div className="px-4 py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                    No models match your filters.
                  </div>
                ) : providerFilter === 'all' && !queryActive ? (
                  // Grouped view (no query, no provider filter): one section
                  // per provider with a sticky header.
                  providerOrder.map(p => {
                    const list = grouped.byProvider[p];
                    if (!list || list.length === 0) return null;
                    return (
                      <div key={p}>
                        <div
                          className="sticky top-0 z-10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest flex items-center gap-2"
                          style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}
                        >
                          <div className="w-1.5 h-1.5 rounded-full" style={{ background: PROVIDER_COLORS[p] }} />
                          {PROVIDER_LABELS[p]}
                          <span className="ml-1 opacity-60">{list.length}</span>
                        </div>
                        {list.map(model => {
                          flatIdx++;
                          return (
                            <ModelRow
                              key={model.id}
                              model={model}
                              isSelected={model.id === value}
                              isKeyboardFocused={flatIdx === keyboardIndex}
                              kbIndex={flatIdx}
                              query={search}
                              onPick={() => { onChange(model.id); setOpen(false); }}
                              onHover={() => setKeyboardIndex(flatIdx)}
                            />
                          );
                        })}
                      </div>
                    );
                  })
                ) : (
                  // Flat list — either a single provider is selected OR a
                  // query is active (in which case rank order beats provider
                  // grouping). Provider colour dot inside each row carries
                  // the provider signal.
                  grouped.flat.map(model => {
                    flatIdx++;
                    return (
                      <ModelRow
                        key={model.id}
                        model={model}
                        isSelected={model.id === value}
                        isKeyboardFocused={flatIdx === keyboardIndex}
                        kbIndex={flatIdx}
                        query={search}
                        onPick={() => { onChange(model.id); setOpen(false); }}
                        onHover={() => setKeyboardIndex(flatIdx)}
                        showProviderDot={queryActive && providerFilter === 'all'}
                      />
                    );
                  })
                )}
              </div>

              {/* Footer hint */}
              <div className="shrink-0 px-3 py-1.5 text-[10px] flex items-center gap-3" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                <span><kbd style={kbStyle}>↑</kbd><kbd style={kbStyle}>↓</kbd> navigate</span>
                <span><kbd style={kbStyle}>↵</kbd> select</span>
                <span><kbd style={kbStyle}>Esc</kbd> close</span>
                <span className="ml-auto">{grouped.flat.length} of {AI_MODELS.length}</span>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

const kbStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '0 4px',
  marginRight: 2,
  borderRadius: 3,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid var(--border)',
  fontSize: 9,
  fontFamily: 'var(--font-geist-mono, monospace)',
};

function FilterChip({
  active, onClick, color, label, count, compact,
}: {
  active: boolean;
  onClick: () => void;
  color: string;
  label: string;
  count?: number;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full text-xs font-medium transition-all ${compact ? 'px-2 py-0.5' : 'px-2.5 py-1'}`}
      style={{
        background: active ? `${color}22` : 'transparent',
        color: active ? color : 'var(--text-muted)',
        border: `1px solid ${active ? color : 'var(--border)'}`,
      }}
    >
      {label}
      {count != null && <span className="ml-1 opacity-70">{count}</span>}
    </button>
  );
}

function ModelRow({
  model, isSelected, isKeyboardFocused, kbIndex, onPick, onHover, query = '', showProviderDot = false,
}: {
  model: AIModel;
  isSelected: boolean;
  isKeyboardFocused: boolean;
  kbIndex: number;
  onPick: () => void;
  onHover: () => void;
  query?: string;
  showProviderDot?: boolean;
}) {
  const tier = TIER_LABELS[model.tier];
  const bg = isSelected
    ? 'rgba(124,58,237,0.12)'
    : isKeyboardFocused
      ? 'var(--bg-card-hover)'
      : 'transparent';
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={onHover}
      data-kb-index={kbIndex}
      className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
      style={{
        background: bg,
        color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      {showProviderDot && (
        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: PROVIDER_COLORS[model.provider] }} />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
          <span className="truncate"><HighlightedText text={model.name} query={query} /></span>
          {model.webSearch && (
            <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4' }}>🌐 search</span>
          )}
        </div>
        <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
          <HighlightedText text={model.description} query={query} />
        </div>
        <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
          {formatModelPricing(model)}
          {model.pricingNote ? ` · ${model.pricingNote}` : ''}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', color: tier.color }}>
          {tier.label}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{model.contextWindow}</span>
        {isSelected && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: 'var(--accent-purple-bright)' }}>
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
      </div>
    </button>
  );
}

/** Bolds the matched substrings of a model's text against the active
 *  query. No-op when the query is empty. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!tokens(query).length) return <>{text}</>;
  const parts = highlight(query, text);
  return (
    <>
      {parts.map((p, i) =>
        p.match
          ? <strong key={i} style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{p.text}</strong>
          : <span key={i}>{p.text}</span>
      )}
    </>
  );
}
