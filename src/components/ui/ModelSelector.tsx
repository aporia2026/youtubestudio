'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AI_MODELS, AIModel, AIProvider } from '@/lib/ai-models';

const PROVIDER_COLORS: Record<AIProvider, string> = {
  anthropic: '#7c3aed',
  openai: '#10b981',
  google: '#3b82f6',
  kie: '#f59e0b',
};

const PROVIDER_LABELS: Record<AIProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  kie: 'Kie.ai',
};

const TIER_LABELS = {
  flagship: { label: 'Flagship', color: 'var(--accent-purple-bright)' },
  balanced: { label: 'Balanced', color: 'var(--accent-cyan-bright)' },
  fast: { label: 'Fast', color: 'var(--accent-green)' },
};

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
  label?: string;
}

export function ModelSelector({ value, onChange, label = 'AI Model' }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = AI_MODELS.find(m => m.id === value) || AI_MODELS[0];

  const byProvider = AI_MODELS.reduce((acc, m) => {
    if (!acc[m.provider]) acc[m.provider] = [];
    acc[m.provider].push(m);
    return acc;
  }, {} as Record<AIProvider, AIModel[]>);

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
        <div
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: PROVIDER_COLORS[selected.provider] }}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{selected.name}</div>
          <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
            {PROVIDER_LABELS[selected.provider]} · {selected.contextWindow} context
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
              className="absolute top-full mt-2 left-0 right-0 rounded-xl overflow-hidden overflow-y-auto z-50"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-bright)',
                boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
                maxHeight: '60vh',
              }}
            >
              {(Object.keys(byProvider) as AIProvider[]).map(provider => (
                <div key={provider}>
                  <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider flex items-center gap-2"
                    style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                    <div className="w-2 h-2 rounded-full" style={{ background: PROVIDER_COLORS[provider] }} />
                    {PROVIDER_LABELS[provider]}
                  </div>
                  {byProvider[provider].map(model => {
                    const isSelected = model.id === value;
                    const tier = TIER_LABELS[model.tier];
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => { onChange(model.id); setOpen(false); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
                        style={{
                          background: isSelected ? 'rgba(124,58,237,0.1)' : 'transparent',
                          color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                        }}
                        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-card-hover)'; }}
                        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{model.name}</div>
                          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{model.description}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs px-2 py-0.5 rounded-full"
                            style={{ background: 'rgba(255,255,255,0.05)', color: tier.color }}>
                            {tier.label}
                          </span>
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{model.contextWindow}</span>
                          {isSelected && (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                              style={{ color: 'var(--accent-purple-bright)' }}>
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
