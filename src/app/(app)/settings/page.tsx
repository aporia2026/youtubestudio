'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { ModelDefaultsPanel } from '@/components/settings/ModelDefaultsPanel';
import { TemplatesPanel } from '@/components/settings/TemplatesPanel';
import { EditorPrefsPanel } from '@/components/settings/EditorPrefsPanel';

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
  const [activeSection, setActiveSection] = useState<'niches' | 'api' | 'models' | 'templates' | 'editor' | 'notifications' | 'integrations' | 'about'>('niches');
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({});
  const [keyStatusLoading, setKeyStatusLoading] = useState(true);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [dbInitializing, setDbInitializing] = useState(false);
  const [perplexityKeyInput, setPerplexityKeyInput] = useState('');
  const [perplexityKeySaving, setPerplexityKeySaving] = useState(false);
  const [perplexityKeyClearing, setPerplexityKeyClearing] = useState(false);

  // ── Notification settings state ───────────────────────────────────────────
  const [notifSettings, setNotifSettings] = useState<{
    owner_email: string;
    enabled: boolean;
    on_review_comment: boolean;
    on_version_uploaded: boolean;
    on_status_changed: boolean;
    on_narrator_take: boolean;
    on_narrator_comment: boolean;
    on_assignment_received: boolean;
    on_comment_resolved: boolean;
    on_retake_requested: boolean;
  }>({
    owner_email: '',
    enabled: true,
    on_review_comment: true,
    on_version_uploaded: true,
    on_status_changed: true,
    on_narrator_take: true,
    on_narrator_comment: true,
    on_assignment_received: true,
    on_comment_resolved: true,
    on_retake_requested: true,
  });
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifTesting, setNotifTesting] = useState(false);

  useEffect(() => {
    if (activeSection !== 'notifications') return;
    setNotifLoading(true);
    fetch('/api/notifications/settings')
      .then(r => r.json())
      .then(data => setNotifSettings(prev => ({ ...prev, ...data, owner_email: data.owner_email || '' })))
      .catch(() => {})
      .finally(() => setNotifLoading(false));
  }, [activeSection]);

  async function saveNotifSettings() {
    setNotifSaving(true);
    try {
      const res = await fetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notifSettings),
      });
      if (!res.ok) throw new Error('Failed');
      toast.success('Notification settings saved');
    } catch {
      toast.error('Failed to save');
    } finally {
      setNotifSaving(false);
    }
  }

  async function sendTestEmail() {
    setNotifTesting(true);
    try {
      // Save first so the latest email is used
      await fetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner_email: notifSettings.owner_email }),
      });
      const res = await fetch('/api/notifications/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (data.sent) {
        toast.success(`Test email sent to ${data.to} — check your inbox`);
      } else if (data.skipped) {
        toast.error(data.message || 'Email skipped', { duration: 8000 });
      } else {
        toast.error(data.error || 'Failed to send', { duration: 8000 });
      }
    } catch {
      toast.error('Failed to send test email');
    } finally {
      setNotifTesting(false);
    }
  }
  const [googleAccount, setGoogleAccount] = useState<{ connected: boolean; email?: string } | null>(null);
  const [googleDisconnecting, setGoogleDisconnecting] = useState(false);

  async function loadKeyStatus() {
    setKeyStatusLoading(true);
    try {
      const res = await fetch('/api/settings/key-status');
      if (res.ok) setKeyStatus(await res.json());
    } catch {}
    setKeyStatusLoading(false);
  }

  async function loadGoogleAccount() {
    try {
      const res = await fetch('/api/google-account');
      if (res.ok) setGoogleAccount(await res.json());
    } catch {}
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
    loadGoogleAccount();
    // Handle Google OAuth redirect params
    const params = new URLSearchParams(window.location.search);
    const googleParam = params.get('google');
    if (googleParam === 'success') {
      toast.success('Google account connected successfully!');
      setActiveSection('api');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (googleParam === 'denied') {
      toast.error('Google account connection was denied.');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (googleParam === 'error') {
      toast.error('Google account connection failed — please try again.');
      window.history.replaceState({}, '', window.location.pathname);
    }
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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to add niche');
      }
      toast.success('Niche added!');
      setNewNiche(''); setNewNicheDesc(''); setNewNicheKeywords('');
      const data = await (await fetch('/api/niches')).json();
      setNiches(data.niches || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add niche');
    }
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
    { id: 'templates' as const, label: '📋 Templates' },
    { id: 'editor' as const, label: '🎬 Editor' },
    { id: 'notifications' as const, label: '📧 Notifications' },
    { id: 'integrations' as const, label: '🔌 Integrations & Usage' },
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
              {/* Google Account */}
              <div className="glass rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Google Account</h2>
                <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                  Connect your Google account to enable Export to Google Sheets from the Production Doc page.
                </p>
                {googleAccount?.connected ? (
                  <div className="flex items-center gap-3 p-3 rounded-lg"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(16,185,129,0.3)' }}>
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: '#10b981' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Connected</p>
                      <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{googleAccount.email}</p>
                    </div>
                    <button
                      onClick={async () => {
                        setGoogleDisconnecting(true);
                        try {
                          await fetch('/api/google-account', { method: 'DELETE' });
                          setGoogleAccount({ connected: false });
                          toast.success('Google account disconnected');
                        } catch { toast.error('Failed to disconnect'); }
                        setGoogleDisconnecting(false);
                      }}
                      disabled={googleDisconnecting}
                      className="btn-secondary text-xs px-3 py-1.5 shrink-0"
                    >
                      {googleDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-3 rounded-lg"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(239,68,68,0.3)' }}>
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: '#ef4444' }} />
                    <div className="flex-1">
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Not connected</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Sheets export requires a Google account</p>
                    </div>
                    <a
                      href="/api/auth/google-sheets"
                      className="btn-primary text-xs px-3 py-1.5 shrink-0"
                      style={{ textDecoration: 'none' }}
                    >
                      Connect Google
                    </a>
                  </div>
                )}
              </div>

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

          {activeSection === 'models' && <ModelDefaultsPanel />}
          {activeSection === 'editor' && <EditorPrefsPanel />}

          {activeSection === 'notifications' && (
            <div className="space-y-4">
              <div className="glass rounded-xl p-6">
                <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Email Notifications</h2>
                <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                  Get notified when collaborators comment, narrators submit takes, statuses change, etc. Powered by SendGrid.
                </p>

                {notifLoading ? (
                  <div className="py-6 text-center"><div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} /></div>
                ) : (
                  <>
                    {/* Owner email */}
                    <div className="mb-4">
                      <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Your email</label>
                      <input
                        type="email"
                        value={notifSettings.owner_email}
                        onChange={e => setNotifSettings(s => ({ ...s, owner_email: e.target.value }))}
                        placeholder="you@example.com"
                        className="w-full px-3 py-2 rounded-lg text-sm"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />
                    </div>

                    {/* Master toggle */}
                    <div className="flex items-center justify-between p-3 rounded-lg mb-3" style={{ background: 'var(--bg-secondary)' }}>
                      <div>
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>All notifications</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Master switch — turn off to disable everything</p>
                      </div>
                      <button
                        onClick={() => setNotifSettings(s => ({ ...s, enabled: !s.enabled }))}
                        className="relative w-10 h-5 rounded-full transition-colors cursor-pointer"
                        style={{ background: notifSettings.enabled ? '#7c3aed' : 'var(--border)' }}
                      >
                        <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: notifSettings.enabled ? '20px' : '2px' }} />
                      </button>
                    </div>

                    {/* Per-event toggles */}
                    <div className="space-y-2 mb-5">
                      {([
                        { key: 'on_review_comment', label: 'New comment on a review', sub: 'When a collaborator leaves a comment' },
                        { key: 'on_version_uploaded', label: 'Version uploaded', sub: 'When you upload a new cut (notifies collaborators, not you)' },
                        { key: 'on_status_changed', label: 'Project status changed', sub: 'In review → needs changes → approved' },
                        { key: 'on_narrator_take', label: 'Narrator uploaded a take', sub: 'When the narrator submits audio' },
                        { key: 'on_narrator_comment', label: 'Narrator comment', sub: 'When the narrator leaves a comment' },
                        { key: 'on_comment_resolved', label: 'Comment resolved', sub: 'Notifies the original commenter (not you)' },
                        { key: 'on_retake_requested', label: 'Retake requested', sub: 'Notifies the narrator (not you)' },
                        { key: 'on_assignment_received', label: 'Assignment created', sub: 'Notifies the narrator with portal link (not you)' },
                      ] as const).map(item => (
                        <div key={item.key} className="flex items-center justify-between p-2.5 rounded-lg" style={{ background: 'var(--bg-secondary)', opacity: notifSettings.enabled ? 1 : 0.5 }}>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{item.label}</p>
                            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{item.sub}</p>
                          </div>
                          <button
                            disabled={!notifSettings.enabled}
                            onClick={() => setNotifSettings(s => ({ ...s, [item.key]: !s[item.key] }))}
                            className="relative w-8 h-4 rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0 ml-3"
                            style={{ background: notifSettings[item.key] ? '#7c3aed' : 'var(--border)' }}
                          >
                            <span className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all" style={{ left: notifSettings[item.key] ? '17px' : '2px' }} />
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={saveNotifSettings}
                        disabled={notifSaving}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 cursor-pointer"
                        style={{ background: '#7c3aed' }}
                      >
                        {notifSaving ? 'Saving...' : 'Save preferences'}
                      </button>
                      <button
                        onClick={sendTestEmail}
                        disabled={notifTesting || !notifSettings.owner_email}
                        className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer"
                        style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }}
                      >
                        {notifTesting ? 'Sending…' : 'Send test email'}
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* SendGrid setup helper */}
              <div className="glass rounded-xl p-5">
                <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>SendGrid setup</h3>
                <ol className="text-xs space-y-1.5 list-decimal pl-4" style={{ color: 'var(--text-secondary)' }}>
                  <li>Sign up at <a href="https://sendgrid.com" target="_blank" rel="noreferrer" className="underline" style={{ color: '#a78bfa' }}>sendgrid.com</a> (free, no card)</li>
                  <li>Settings → Sender Authentication → <strong>Single Sender Verification</strong> → verify your email (yoavm7@gmail.com)</li>
                  <li>Settings → API Keys → Create API Key → <strong>Full Access</strong></li>
                  <li>In Vercel project → Environment Variables, add:<br />
                    <code className="block mt-1 px-2 py-1 rounded font-mono text-[11px]" style={{ background: 'var(--bg-primary)' }}>SENDGRID_API_KEY=SG.xxxxx</code>
                    <code className="block mt-1 px-2 py-1 rounded font-mono text-[11px]" style={{ background: 'var(--bg-primary)' }}>SENDGRID_FROM_EMAIL=yoavm7@gmail.com</code>
                  </li>
                  <li>Redeploy, then click <strong>Send test email</strong> above</li>
                </ol>
                <p className="text-[11px] mt-3" style={{ color: 'var(--text-muted)' }}>
                  Free tier: 100 emails/day forever. No domain required — emails go from your verified gmail to anyone.
                </p>
              </div>
            </div>
          )}

          {activeSection === 'templates' && <TemplatesPanel />}

          {activeSection === 'integrations' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                  Outbound integrations
                </h2>
                <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                  Push studio events into Slack, Discord, or any HTTPS endpoint. Set up once; the
                  rest of the app fires events to whatever you've configured.
                </p>
                <a
                  href="/webhooks"
                  className="glass rounded-xl p-4 block hover:bg-white/[0.02] transition-colors"
                  style={{ borderLeft: '3px solid #4ade80', textDecoration: 'none' }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        Webhooks
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        Slack / Discord / generic — per-event filters, encrypted URLs at rest, full delivery audit log
                      </div>
                    </div>
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                  </div>
                </a>
              </div>

              <div>
                <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                  Usage &amp; spend
                </h2>
                <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                  Per-call AI cost log across every Anthropic / OpenAI / Google call routed through
                  the studio. Auto-populated for opted-in features.
                </p>
                <a
                  href="/spend"
                  className="glass rounded-xl p-4 block hover:bg-white/[0.02] transition-colors"
                  style={{ borderLeft: '3px solid #c084fc', textDecoration: 'none' }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        AI spend
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        Total USD by feature, model, project, day · top 10 most-expensive calls · 7d / 30d / 90d windows
                      </div>
                    </div>
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                  </div>
                </a>
              </div>

              <div className="text-xs pt-2" style={{ color: 'var(--text-muted)' }}>
                These surfaces have their own routes (<code>/webhooks</code>, <code>/spend</code>) — bookmarks
                + deep links keep working. They live here in Settings instead of the main sidebar
                because they're rare-touch (configured once, then mostly ignored).
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
