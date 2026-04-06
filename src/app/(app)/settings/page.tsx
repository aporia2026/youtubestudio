'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { AI_MODELS, APP_FEATURES, type AppFeature } from '@/lib/ai-models';
import { ModelSelector } from '@/components/ui/ModelSelector';

interface Niche {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  is_active: boolean;
}

export default function SettingsPage() {
  const [niches, setNiches] = useState<Niche[]>([]);
  const [newNiche, setNewNiche] = useState('');
  const [newNicheDesc, setNewNicheDesc] = useState('');
  const [newNicheKeywords, setNewNicheKeywords] = useState('');
  const [addingNiche, setAddingNiche] = useState(false);
  const [activeSection, setActiveSection] = useState<'niches' | 'api' | 'models' | 'about'>('niches');
  const [featureModels, setFeatureModels] = useState<Record<AppFeature, string>>({
    'script-generator': AI_MODELS[0].id,
    'qa-engine': AI_MODELS[0].id,
    'idea-generator': AI_MODELS[0].id,
  });

  useEffect(() => {
    fetch('/api/niches').then(r => r.json()).then(data => setNiches(data.niches || []));
    // Load saved feature model defaults from localStorage
    try {
      const saved = localStorage.getItem('feature_model_defaults');
      if (saved) setFeatureModels(prev => ({ ...prev, ...JSON.parse(saved) }));
    } catch {}
  }, []);

  async function addNiche() {
    if (!newNiche.trim()) return;
    setAddingNiche(true);
    try {
      const res = await fetch('/api/niches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newNiche,
          description: newNicheDesc,
          keywords: newNicheKeywords.split(',').map(k => k.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) throw new Error();
      toast.success('Niche added!');
      setNewNiche(''); setNewNicheDesc(''); setNewNicheKeywords('');
      const data = await (await fetch('/api/niches')).json();
      setNiches(data.niches || []);
    } catch { toast.error('Failed to add niche'); }
    finally { setAddingNiche(false); }
  }

  async function toggleNiche(id: string, isActive: boolean) {
    await fetch(`/api/niches/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !isActive }),
    });
    setNiches(n => n.map(ni => ni.id === id ? { ...ni, is_active: !isActive } : ni));
  }

  async function deleteNiche(id: string) {
    await fetch(`/api/niches/${id}`, { method: 'DELETE' });
    setNiches(n => n.filter(ni => ni.id !== id));
    toast.success('Niche removed');
  }

  async function initDB() {
    try {
      await fetch('/api/db/init', { method: 'POST' });
      toast.success('Database initialized!');
    } catch { toast.error('Failed to initialize database'); }
  }

  function updateFeatureModel(feature: AppFeature, modelId: string) {
    const updated = { ...featureModels, [feature]: modelId };
    setFeatureModels(updated);
    localStorage.setItem('feature_model_defaults', JSON.stringify(updated));
    toast.success('Default model updated');
  }

  const SECTIONS = [
    { id: 'niches' as const, label: '🎯 Niches' },
    { id: 'api' as const, label: '🔑 API Keys' },
    { id: 'models' as const, label: '🤖 Model Defaults' },
    { id: 'about' as const, label: 'ℹ️ About' },
  ];

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>Manage your niches, API integrations, and system configuration</p>
      </div>

      <div className="flex gap-6">
        {/* Sidebar */}
        <div className="w-40 shrink-0">
          <nav className="space-y-1">
            {SECTIONS.map(s => (
              <button key={s.id} onClick={() => setActiveSection(s.id)}
                className="w-full text-left px-3 py-2 rounded-lg text-sm transition-all"
                style={{
                  background: activeSection === s.id ? 'rgba(124,58,237,0.15)' : 'transparent',
                  color: activeSection === s.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}>
                {s.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex-1">
          {activeSection === 'niches' && (
            <div className="space-y-4">
              <div className="glass rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Manage Niches</h2>
                <div className="space-y-3 mb-5">
                  {niches.map(niche => (
                    <div key={niche.id} className="flex items-center gap-3 p-3 rounded-lg"
                      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{niche.name}</p>
                        {niche.description && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{niche.description}</p>}
                        {niche.keywords?.length > 0 && (
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {niche.keywords.slice(0, 4).map((k: string) => (
                              <span key={k} className="badge badge-purple text-xs">{k}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => toggleNiche(niche.id, niche.is_active)}
                          className="relative w-10 h-5 rounded-full transition-all"
                          style={{ background: niche.is_active ? 'var(--accent-purple)' : 'var(--bg-card)' }}>
                          <span className="absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all"
                            style={{ left: niche.is_active ? 22 : 2 }} />
                        </button>
                        <button onClick={() => deleteNiche(niche.id)} className="text-xs p-1 rounded"
                          style={{ color: '#ef4444' }}>×</button>
                      </div>
                    </div>
                  ))}
                </div>

                <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>Add New Niche</h3>
                <div className="space-y-3">
                  <input value={newNiche} onChange={e => setNewNiche(e.target.value)}
                    placeholder="Niche name (e.g. Personal Finance)" className="input-field" />
                  <input value={newNicheDesc} onChange={e => setNewNicheDesc(e.target.value)}
                    placeholder="Description" className="input-field" />
                  <input value={newNicheKeywords} onChange={e => setNewNicheKeywords(e.target.value)}
                    placeholder="Keywords (comma separated)" className="input-field" />
                  <button onClick={addNiche} disabled={!newNiche.trim() || addingNiche} className="btn-primary text-sm">
                    {addingNiche ? 'Adding...' : '➕ Add Niche'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'api' && (
            <div className="space-y-4">
              <div className="glass rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>API Keys Configuration</h2>
                <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
                  API keys are configured via environment variables in your Vercel project settings.
                  Never enter keys directly in the UI for security.
                </p>

                {[
                  { name: 'Anthropic (Claude)', env: 'ANTHROPIC_API_KEY', required: 'For script generation & QA' },
                  { name: 'OpenAI (GPT)', env: 'OPENAI_API_KEY', required: 'Optional - for GPT models' },
                  { name: 'Google AI (Gemini)', env: 'GOOGLE_AI_API_KEY', required: 'Optional - for Gemini models' },
                  { name: 'Kie.ai', env: 'KIE_API_KEY', required: 'For Kie.ai models (Gemini, Claude, GPT at lower cost)' },
                  { name: 'ElevenLabs', env: 'Client-side (browser)', required: 'Enter in Voiceover Studio' },
                  { name: 'YouTube Data API', env: 'YOUTUBE_API_KEY', required: 'For channel integration' },
                ].map(api => (
                  <div key={api.name} className="flex items-center gap-3 p-3 rounded-lg mb-2"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                    <div className="flex-1">
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{api.name}</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{api.required}</p>
                    </div>
                    <code className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-card)', color: 'var(--accent-cyan-bright)' }}>
                      {api.env}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'models' && (
            <div className="space-y-4">
              <div className="glass rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Default Model per Feature</h2>
                <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
                  Choose which AI model each feature uses by default. You can still override per-session.
                </p>
                <div className="space-y-6">
                  {APP_FEATURES.map(feature => (
                    <div key={feature.id}>
                      <div className="mb-2">
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{feature.label}</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{feature.description}</p>
                      </div>
                      <ModelSelector
                        value={featureModels[feature.id]}
                        onChange={(id) => updateFeatureModel(feature.id, id)}
                        label=""
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'about' && (
            <div className="glass rounded-xl p-6">
              <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>System</h2>
              <div className="space-y-3">
                <div className="p-3 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Version</p>
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>YouTube Studio v1.0.0</p>
                </div>
                <div className="p-3 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Stack</p>
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>Next.js 14 · Vercel Postgres · Vercel Blob · ElevenLabs</p>
                </div>
                <button onClick={initDB} className="btn-secondary text-sm">
                  🗄️ Initialize / Reset Database Tables
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
