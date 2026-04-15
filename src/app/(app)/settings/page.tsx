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

type KeyStatus = Record<string, boolean>;
type TestResult = { status: 'idle' | 'testing' | 'success' | 'error'; message?: string };

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
    'competitor-analysis': AI_MODELS[0].id,
    'channel-naming': AI_MODELS[0].id,
    'seo-optimizer': AI_MODELS[0].id,
    'production-doc': AI_MODELS[0].id,
  });
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({});
  const [keyStatusLoading, setKeyStatusLoading] = useState(true);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [dbInitializing, setDbInitializing] = useState(false);
  const [perplexityKeyInput, setPerplexityKeyInput] = useState('');
  const [perplexityKeySaving, setPerplexityKeySaving] = useState(false);
  const [perplexityKeyClearing, setPerplexityKeyClearing] = useState(false);

  async function loadKeyStatus() {
    setKeyStatusLoading(true);
    try {
      const res = await fetch('/api/settings/key-status');
      if (res.ok) setKeyStatus(await res.json());
    } catch {}
    setKeyStatusLoading(false);
  }

  async function testConnection(provider: string) {
    setTestResults(prev => ({ ...prev, [provider]: { status: 'testing' } }));
    try {
      const res = await fetch('/api/settings/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      if (data.ok) {
        const creditMsg = data.credits?.data ? `${Number(data.credits.data).toLocaleString()} credits remaining` : null;
        setTestResults(prev => ({ ...prev, [provider]: { status: 'success', message: creditMsg || (data.model ? `Model: ${data.model}` : 'Connected') } }));
        toast.success(`${provider} connection successful`);
      } else {
        setTestResults(prev => ({ ...prev, [provider]: { status: 'error', message: data.error } }));
        toast.error(data.error);
      }
    } catch (err: unknown) {
      setTestResults(prev => ({ ...prev, [provider]: { status: 'error', message: err instanceof Error ? err.message : 'Failed' } }));
    }
  }

  useEffect(() => {
    fetch('/api/niches').then(r => r.json()).then(data => setNiches(data.niches || []));
    loadKeyStatus();
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

  function updateFeatureModel(feature: AppFeature, modelId: string) {
    const updated = { ...featureModels, [feature]: modelId };
    setFeatureModels(updated);
    localStorage.setItem('feature_model_defaults', JSON.stringify(updated));
    toast.success('Default model updated');
  }

  async function savePerplexityKey() {
    if (!perplexityKeyInput.trim()) return;
    setPerplexityKeySaving(true);
    try {
      const res = await fetch('/api/settings/perplexity-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: perplexityKeyInput.trim() }),
      });
      if (!res.ok) throw new Error();
      setPerplexityKeyInput('');
      await loadKeyStatus();
      toast.success('Perplexity API key saved');
    } catch { toast.error('Failed to save key'); }
    finally { setPerplexityKeySaving(false); }
  }

  async function clearPerplexityKey() {
    setPerplexityKeyClearing(true);
    try {
      await fetch('/api/settings/perplexity-key', { method: 'DELETE' });
      await loadKeyStatus();
      toast.success('Perplexity API key cleared');
    } catch { toast.error('Failed to clear key'); }
    finally { setPerplexityKeyClearing(false); }
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
              {/* Infrastructure */}
              <div className="glass rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Infrastructure</h2>
                <div className="space-y-2 mb-4">
                  {[
                    { key: 'postgres', name: 'Database (Postgres)', desc: 'Required — stores all project data', env: 'POSTGRES_URL' },
                    { key: 'blob', name: 'File Storage (Vercel Blob)', desc: 'Required — stores voiceovers and media', env: 'BLOB_READ_WRITE_TOKEN' },
                  ].map(svc => {
                    const configured = keyStatus[svc.key];
                    const test = testResults[svc.key];
                    return (
                      <div key={svc.key} className="flex items-center gap-3 p-3 rounded-lg"
                        style={{ background: 'var(--bg-secondary)', border: `1px solid ${configured ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: keyStatusLoading ? 'var(--text-muted)' : configured ? '#10b981' : '#ef4444' }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{svc.name}</p>
                          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {test?.status === 'success' ? test.message : test?.status === 'error' ? test.message : svc.desc}
                          </p>
                        </div>
                        <code className="text-xs px-2 py-1 rounded hidden sm:block" style={{ background: 'var(--bg-card)', color: 'var(--accent-cyan-bright)' }}>
                          {svc.env}
                        </code>
                        <button
                          onClick={() => testConnection(svc.key)}
                          disabled={!configured || test?.status === 'testing'}
                          className="btn-secondary text-xs px-3 py-1.5 shrink-0"
                          style={{ opacity: configured ? 1 : 0.4 }}
                        >
                          {test?.status === 'testing' ? <div className="spinner" style={{ width: 12, height: 12 }} /> : test?.status === 'success' ? '✓' : test?.status === 'error' ? '✗ Retry' : 'Test'}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={async () => {
                    setDbInitializing(true);
                    try {
                      const res = await fetch('/api/db/init', { method: 'POST' });
                      if (res.ok) toast.success('Database tables initialized!');
                      else toast.error('Database init failed — is POSTGRES_URL configured?');
                    } catch { toast.error('Database init failed'); }
                    setDbInitializing(false);
                  }}
                  disabled={dbInitializing}
                  className="btn-primary text-sm w-full justify-center"
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  {dbInitializing ? <><div className="spinner" style={{ width: 14, height: 14 }} /> Initializing...</> : '🗄️ Initialize Database Tables'}
                </button>
              </div>

              {/* AI Providers */}
              <div className="glass rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>AI Providers</h2>
                <div className="space-y-2">
                  {[
                    { key: 'anthropic', name: 'Anthropic (Claude)', desc: 'For script generation & QA', env: 'ANTHROPIC_API_KEY' },
                    { key: 'openai', name: 'OpenAI (GPT)', desc: 'Optional — for GPT models', env: 'OPENAI_API_KEY' },
                    { key: 'google', name: 'Google AI (Gemini)', desc: 'Optional — for Gemini models', env: 'GOOGLE_AI_API_KEY' },
                    { key: 'kie', name: 'Kie.ai', desc: 'Gemini, Claude, GPT at lower cost', env: 'KIE_API_KEY' },
                  ].map(provider => {
                    const configured = keyStatus[provider.key];
                    const test = testResults[provider.key];
                    return (
                      <div key={provider.key} className="flex items-center gap-3 p-3 rounded-lg"
                        style={{ background: 'var(--bg-secondary)', border: `1px solid ${configured ? 'rgba(16,185,129,0.3)' : 'var(--border)'}` }}>
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: keyStatusLoading ? 'var(--text-muted)' : configured ? '#10b981' : '#6b7280' }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{provider.name}</p>
                          <p className="text-xs" style={{ color: test?.status === 'success' ? '#10b981' : test?.status === 'error' ? '#ef4444' : 'var(--text-muted)' }}>
                            {test?.status === 'success' ? test.message : test?.status === 'error' ? test.message : configured ? 'Configured' : provider.desc}
                          </p>
                        </div>
                        <code className="text-xs px-2 py-1 rounded hidden sm:block" style={{ background: 'var(--bg-card)', color: 'var(--accent-cyan-bright)' }}>
                          {provider.env}
                        </code>
                        {configured ? (
                          <button
                            onClick={() => testConnection(provider.key)}
                            disabled={test?.status === 'testing'}
                            className="btn-secondary text-xs px-3 py-1.5 shrink-0"
                          >
                            {test?.status === 'testing' ? <div className="spinner" style={{ width: 12, height: 12 }} /> : test?.status === 'success' ? '✓ Connected' : test?.status === 'error' ? '✗ Retry' : 'Test Connection'}
                          </button>
                        ) : (
                          <span className="text-xs px-3 py-1.5 rounded-lg shrink-0" style={{ background: 'rgba(107,114,128,0.15)', color: 'var(--text-muted)' }}>
                            Not set
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Other Services */}
              <div className="glass rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Other Services</h2>
                <div className="space-y-2">
                  {/* Perplexity */}
                  {(() => {
                    const configured = keyStatus['perplexity'];
                    const test = testResults['perplexity'];
                    return (
                      <div className="rounded-lg overflow-hidden"
                        style={{ border: `1px solid ${configured ? 'rgba(16,185,129,0.3)' : 'var(--border)'}` }}>
                        <div className="flex items-center gap-3 p-3"
                          style={{ background: 'var(--bg-secondary)' }}>
                          <div className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: keyStatusLoading ? 'var(--text-muted)' : configured ? '#10b981' : '#6b7280' }} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Perplexity (Web Search AI)</p>
                            <p className="text-xs" style={{ color: test?.status === 'success' ? '#10b981' : test?.status === 'error' ? '#ef4444' : 'var(--text-muted)' }}>
                              {test?.status === 'success' ? test.message || 'Connected' : test?.status === 'error' ? test.message : configured ? 'Key configured — stored in browser session' : 'Enter your key below to enable Sonar models'}
                            </p>
                          </div>
                          {configured && (
                            <button
                              onClick={() => testConnection('perplexity')}
                              disabled={test?.status === 'testing'}
                              className="btn-secondary text-xs px-3 py-1.5 shrink-0"
                            >
                              {test?.status === 'testing' ? <div className="spinner" style={{ width: 12, height: 12 }} /> : test?.status === 'success' ? '✓ Connected' : test?.status === 'error' ? '✗ Retry' : 'Test'}
                            </button>
                          )}
                        </div>
                        <div className="px-3 pb-3 pt-2" style={{ background: 'var(--bg-secondary)', borderTop: '1px solid var(--border)' }}>
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={perplexityKeyInput}
                              onChange={e => setPerplexityKeyInput(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && savePerplexityKey()}
                              placeholder="pplx-..."
                              className="input-field flex-1 text-sm"
                              style={{ padding: '0.4rem 0.75rem' }}
                            />
                            <button
                              onClick={savePerplexityKey}
                              disabled={!perplexityKeyInput.trim() || perplexityKeySaving}
                              className="btn-primary text-xs px-3 shrink-0"
                            >
                              {perplexityKeySaving ? '...' : 'Save'}
                            </button>
                            {configured && (
                              <button
                                onClick={clearPerplexityKey}
                                disabled={perplexityKeyClearing}
                                className="btn-secondary text-xs px-3 shrink-0"
                                style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}
                              >
                                {perplexityKeyClearing ? '...' : 'Clear'}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                  {/* ElevenLabs */}
                  <div className="flex items-center gap-3 p-3 rounded-lg"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: '#f59e0b' }} />
                    <div className="flex-1">
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>ElevenLabs (Voiceover)</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>API key entered in browser — stored locally</p>
                    </div>
                    <a href="/voiceover" className="btn-secondary text-xs px-3 py-1.5 shrink-0">
                      Open Voiceover Studio
                    </a>
                  </div>
                  {/* YouTube */}
                  {(() => {
                    const configured = keyStatus['youtube'];
                    const test = testResults['youtube'];
                    return (
                      <div className="flex items-center gap-3 p-3 rounded-lg"
                        style={{ background: 'var(--bg-secondary)', border: `1px solid ${configured ? 'rgba(16,185,129,0.3)' : 'var(--border)'}` }}>
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: keyStatusLoading ? 'var(--text-muted)' : configured ? '#10b981' : '#6b7280' }} />
                        <div className="flex-1">
                          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>YouTube Data API</p>
                          <p className="text-xs" style={{ color: test?.status === 'success' ? '#10b981' : test?.status === 'error' ? '#ef4444' : 'var(--text-muted)' }}>
                            {test?.status === 'success' ? 'Connected' : test?.status === 'error' ? test.message : configured ? 'Configured' : 'For channel integration'}
                          </p>
                        </div>
                        <code className="text-xs px-2 py-1 rounded hidden sm:block" style={{ background: 'var(--bg-card)', color: 'var(--accent-cyan-bright)' }}>
                          YOUTUBE_API_KEY
                        </code>
                        {configured ? (
                          <button onClick={() => testConnection('youtube')} disabled={test?.status === 'testing'} className="btn-secondary text-xs px-3 py-1.5 shrink-0">
                            {test?.status === 'testing' ? <div className="spinner" style={{ width: 12, height: 12 }} /> : test?.status === 'success' ? '✓' : 'Test'}
                          </button>
                        ) : (
                          <span className="text-xs px-3 py-1.5 rounded-lg shrink-0" style={{ background: 'rgba(107,114,128,0.15)', color: 'var(--text-muted)' }}>
                            Not set
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Help text */}
              <div className="p-4 rounded-lg" style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)' }}>
                <p className="text-xs font-semibold mb-1" style={{ color: 'var(--accent-purple-bright)' }}>How to add API keys</p>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  Go to your Vercel Dashboard → Project Settings → Environment Variables. Add each key and redeploy.
                  Or run <code style={{ color: 'var(--accent-cyan-bright)' }}>vercel env add KEY_NAME production</code> in your terminal.
                </p>
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
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Database and infrastructure can be managed in the API Keys tab.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
