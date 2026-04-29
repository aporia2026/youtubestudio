'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { useParams } from 'next/navigation';
import { formatBytes, countWords, estimateDuration, formatDuration } from '@/lib/utils';
import { ScriptVoiceoverPanel } from '@/components/ui/ScriptVoiceoverPanel';
import { NarrationTab } from '@/components/narrator/NarrationTab';
import Link from 'next/link';

type TabId = 'script' | 'voiceover' | 'media' | 'references' | 'narration';

interface Project {
  id: string;
  title: string;
  niche: string;
  topic: string;
  status: string;
}

interface Script {
  id: string;
  version: number;
  content: string;
  word_count: number;
  estimated_duration_seconds: number;
  ai_model: string;
  created_at: string;
  is_active: boolean;
}

interface MediaAsset {
  id: string;
  type: string;
  source: string;
  name: string;
  url: string;
  size_bytes: number;
  notes: string;
  created_at: string;
}

interface YoutubeRef {
  id: string;
  youtube_url: string;
  video_id: string;
  title: string;
  channel: string;
  view_count: number;
  thumbnail_url: string;
  notes: string;
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [refs, setRefs] = useState<YoutubeRef[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('script');
  const [loading, setLoading] = useState(true);
  const [editingScript, setEditingScript] = useState(false);
  const [scriptContent, setScriptContent] = useState('');
  const [savingScript, setSavingScript] = useState(false);
  const [addingMedia, setAddingMedia] = useState(false);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaName, setMediaName] = useState('');
  const [mediaType, setMediaType] = useState('image');
  const [mediaNotes, setMediaNotes] = useState('');
  const [ytUrl, setYtUrl] = useState('');
  const [ytNotes, setYtNotes] = useState('');
  const [addingRef, setAddingRef] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (id) fetchAll(); }, [id]);

  async function fetchAll() {
    setLoading(true);
    try {
      const [projRes, scriptsRes, mediaRes, refsRes] = await Promise.all([
        fetch(`/api/projects/${id}`),
        fetch(`/api/projects/${id}/scripts`),
        fetch(`/api/projects/${id}/media`),
        fetch(`/api/projects/${id}/references`),
      ]);
      const [proj, sc, med, ref] = await Promise.all([
        projRes.json(), scriptsRes.json(), mediaRes.json(), refsRes.json(),
      ]);
      setProject(proj.project);
      setScripts(sc.scripts || []);
      setMedia(med.assets || []);
      setRefs(ref.references || []);
      const active = sc.scripts?.find((s: Script) => s.is_active);
      if (active) setScriptContent(active.content);
    } catch {
      toast.error('Failed to load project');
    } finally {
      setLoading(false);
    }
  }

  async function saveScript() {
    if (!scriptContent.trim()) return;
    setSavingScript(true);
    try {
      await fetch(`/api/projects/${id}/scripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: scriptContent }),
      });
      toast.success('Script saved');
      setEditingScript(false);
      fetchAll();
    } catch { toast.error('Save failed'); }
    finally { setSavingScript(false); }
  }

  async function addMediaUrl() {
    if (!mediaUrl.trim()) return;
    setAddingMedia(true);
    try {
      await fetch(`/api/projects/${id}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'url', type: mediaType, url: mediaUrl, name: mediaName || mediaUrl.split('/').pop(), notes: mediaNotes }),
      });
      toast.success('Media added');
      setMediaUrl(''); setMediaName(''); setMediaNotes('');
      fetchAll();
    } catch { toast.error('Failed to add media'); }
    finally { setAddingMedia(false); }
  }

  async function uploadFile(file: File, type: string) {
    setUploadingFile(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('type', type);
      form.append('projectId', id);
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error('Upload failed');
      toast.success('File uploaded');
      fetchAll();
    } catch { toast.error('Upload failed'); }
    finally { setUploadingFile(false); }
  }

  async function addYoutubeRef() {
    if (!ytUrl.trim()) return;
    setAddingRef(true);
    try {
      await fetch(`/api/projects/${id}/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtube_url: ytUrl, notes: ytNotes }),
      });
      toast.success('Reference added');
      setYtUrl(''); setYtNotes('');
      fetchAll();
    } catch { toast.error('Failed to add reference'); }
    finally { setAddingRef(false); }
  }

  async function deleteMedia(assetId: string) {
    await fetch(`/api/media/${assetId}`, { method: 'DELETE' });
    setMedia(m => m.filter(a => a.id !== assetId));
    toast.success('Removed');
  }

  async function deleteRef(refId: string) {
    await fetch(`/api/references/${refId}`, { method: 'DELETE' });
    setRefs(r => r.filter(ref => ref.id !== refId));
    toast.success('Removed');
  }

  if (loading) return (
    <div className="p-8 flex items-center justify-center min-h-96">
      <div className="spinner" style={{ width: 32, height: 32 }} />
    </div>
  );

  if (!project) return (
    <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Project not found</div>
  );

  const activeScript = scripts.find(s => s.is_active);
  const words = countWords(scriptContent || activeScript?.content || '');
  const estDuration = estimateDuration(words);

  const TABS: { id: TabId; label: string; count?: number }[] = [
    { id: 'script', label: '📝 Script', count: scripts.length },
    { id: 'voiceover', label: '🎙️ Voiceover' },
    { id: 'media', label: '🎬 Media', count: media.length },
    { id: 'references', label: '🔗 References', count: refs.length },
    { id: 'narration', label: '🎤 Narration' },
  ];

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <Link href="/projects" className="text-xs flex items-center gap-1 mb-2" style={{ color: 'var(--text-muted)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
            All Projects
          </Link>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{project.title}</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{project.niche}</span>
            <span className="badge badge-purple text-xs">{project.status}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/qa?projectId=${id}`}>
            <button className="btn-secondary text-sm">🔬 QA Script</button>
          </Link>
          <Link href={`/generator?projectId=${id}`}>
            <button className="btn-secondary text-sm">✨ Regenerate</button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      {activeScript && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: 'Words', value: words.toLocaleString(), color: 'var(--accent-purple-bright)' },
            { label: 'Est. Duration', value: formatDuration(estDuration), color: 'var(--accent-cyan-bright)' },
            { label: 'Script Version', value: `v${activeScript.version}`, color: 'var(--accent-green)' },
          ].map(stat => (
            <div key={stat.label} className="glass rounded-xl p-4 text-center">
              <div className="text-xl font-bold" style={{ color: stat.color }}>{stat.value}</div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{stat.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
            style={{
              background: activeTab === tab.id ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
              border: `1px solid ${activeTab === tab.id ? 'var(--accent-purple)' : 'var(--border)'}`,
              color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}>
            {tab.label} {tab.count !== undefined && <span style={{ color: 'var(--text-muted)' }}>({tab.count})</span>}
          </button>
        ))}
      </div>

      {/* Script Tab */}
      {activeTab === 'script' && (
        <div className="glass rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              Script {activeScript ? `— Version ${activeScript.version}` : '(no script yet)'}
            </span>
            <div className="flex gap-2">
              {!editingScript && activeScript && (
                <button onClick={() => setEditingScript(true)} className="btn-secondary text-sm px-3 py-1.5">
                  ✏️ Edit
                </button>
              )}
              {editingScript && (
                <>
                  <button onClick={() => setEditingScript(false)} className="btn-secondary text-sm px-3 py-1.5">Cancel</button>
                  <button onClick={saveScript} disabled={savingScript} className="btn-primary text-sm px-3 py-1.5">
                    {savingScript ? <div className="spinner" style={{ width: 14, height: 14 }} /> : 'Save'}
                  </button>
                </>
              )}
              {activeScript && !editingScript && (
                <button onClick={() => { navigator.clipboard.writeText(activeScript.content); toast.success('Copied!'); }}
                  className="btn-secondary text-sm px-3 py-1.5">
                  Copy
                </button>
              )}
            </div>
          </div>
          <div className="p-6">
            {!activeScript && !editingScript ? (
              <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
                <p className="mb-4">No script yet</p>
                <button onClick={() => setEditingScript(true)} className="btn-primary">Paste Script</button>
              </div>
            ) : editingScript ? (
              <textarea
                value={scriptContent}
                onChange={e => setScriptContent(e.target.value)}
                className="input-field"
                style={{ minHeight: 500, fontFamily: 'var(--font-geist-mono)' }}
                placeholder="Paste or type your script here..."
              />
            ) : (
              <pre className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: 'var(--text-secondary)', maxHeight: 600, overflow: 'auto' }}>
                {activeScript?.content}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Voiceover Tab */}
      {activeTab === 'voiceover' && (
        <div className="space-y-4">
          {media.filter(m => m.type === 'voiceover').length > 0 ? (
            media.filter(m => m.type === 'voiceover').map(vo => (
              <div key={vo.id} className="glass rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="font-medium" style={{ color: 'var(--text-primary)' }}>{vo.name}</h3>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{vo.source === 'upload' ? 'Uploaded' : 'External URL'}</p>
                  </div>
                  <button onClick={() => deleteMedia(vo.id)} className="btn-danger text-xs px-2 py-1">Remove</button>
                </div>
                <audio controls src={vo.url} className="w-full" style={{ height: 40 }} />
                {vo.notes && <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{vo.notes}</p>}
              </div>
            ))
          ) : (
            <div className="glass rounded-xl p-12 text-center" style={{ color: 'var(--text-muted)' }}>
              <div className="text-5xl mb-4">🎙️</div>
              <p className="mb-2">No voiceover yet</p>
              <p className="text-xs">Upload a file or add a URL below</p>
            </div>
          )}

          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
              Add Voiceover
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Upload */}
              <div>
                <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Upload Audio File</p>
                <input ref={fileInputRef} type="file" accept="audio/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, 'voiceover'); }} />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingFile}
                  className="btn-secondary w-full justify-center"
                  style={{ justifyContent: 'center' }}
                >
                  {uploadingFile ? <><div className="spinner" style={{ width: 14, height: 14 }} />Uploading...</> : '⬆️ Upload File'}
                </button>
              </div>
              {/* URL */}
              <div>
                <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Or Add URL</p>
                <div className="flex gap-2">
                  <input value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} placeholder="https://..." className="input-field flex-1" />
                  <button onClick={addMediaUrl} className="btn-primary text-sm px-3">Add</button>
                </div>
              </div>
            </div>
            {/* Inline AI voiceover generation from script */}
            {activeScript?.content && (
              <ScriptVoiceoverPanel
                script={activeScript.content}
                tone="Engaging & Friendly"
                style="Explainer"
                targetDuration={Math.max(1, Math.round(estimateDuration(countWords(activeScript.content)) / 60))}
                projectId={id}
              />
            )}
            <div className="p-3 rounded-lg" style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)' }}>
              <p className="text-xs" style={{ color: 'var(--accent-purple-bright)' }}>
                💡 Need more control? Open the full <strong>Voiceover Studio</strong> for advanced options
              </p>
              <Link href={`/voiceover?projectId=${id}`}>
                <button className="mt-2 text-xs btn-primary py-1.5 px-3">Open Voiceover Studio</button>
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Media Tab */}
      {activeTab === 'media' && (
        <div className="space-y-4">
          {media.filter(m => m.type !== 'voiceover').length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {media.filter(m => m.type !== 'voiceover').map(asset => (
                <div key={asset.id} className="glass rounded-xl p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="badge badge-cyan text-xs">{asset.type}</span>
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{asset.source}</span>
                      </div>
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{asset.name}</p>
                      {asset.size_bytes > 0 && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{formatBytes(asset.size_bytes)}</p>}
                      {asset.notes && <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{asset.notes}</p>}
                    </div>
                    <div className="flex gap-1 ml-2">
                      <a href={asset.url} target="_blank" rel="noreferrer" className="p-1.5 rounded btn-secondary text-xs">View</a>
                      <button onClick={() => deleteMedia(asset.id)} className="p-1.5 rounded btn-danger text-xs">×</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add media form */}
          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Add Media Asset</h3>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-secondary)' }}>Type</label>
                <select value={mediaType} onChange={e => setMediaType(e.target.value)} className="input-field" style={{ appearance: 'none' }}>
                  <option value="image">Image</option>
                  <option value="video">Video Clip</option>
                  <option value="document">Document</option>
                </select>
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-secondary)' }}>Name</label>
                <input value={mediaName} onChange={e => setMediaName(e.target.value)} placeholder="Asset name..." className="input-field" />
              </div>
            </div>
            <div className="mb-3">
              <label className="text-xs mb-1 block" style={{ color: 'var(--text-secondary)' }}>URL</label>
              <input value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} placeholder="https://..." className="input-field" />
            </div>
            <div className="mb-3">
              <label className="text-xs mb-1 block" style={{ color: 'var(--text-secondary)' }}>Notes</label>
              <input value={mediaNotes} onChange={e => setMediaNotes(e.target.value)} placeholder="Usage notes..." className="input-field" />
            </div>
            <div className="flex gap-3">
              <button onClick={addMediaUrl} disabled={!mediaUrl.trim()} className="btn-primary text-sm">Add URL</button>
              <div>
                <input type="file" className="hidden" id="media-file"
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, mediaType); }} />
                <label htmlFor="media-file">
                  <span className="btn-secondary text-sm cursor-pointer">
                    {uploadingFile ? 'Uploading...' : '⬆️ Upload File'}
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* References Tab */}
      {activeTab === 'references' && (
        <div className="space-y-4">
          {refs.length > 0 && (
            <div className="space-y-3">
              {refs.map(ref => (
                <div key={ref.id} className="glass rounded-xl p-4 flex gap-4">
                  {ref.thumbnail_url && (
                    <img src={ref.thumbnail_url} alt="" className="w-24 h-14 object-cover rounded-lg shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{ref.title || ref.youtube_url}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{ref.channel}</p>
                    {ref.notes && <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{ref.notes}</p>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <a href={ref.youtube_url} target="_blank" rel="noreferrer" className="btn-secondary text-xs px-2 py-1">▶</a>
                    <button onClick={() => deleteRef(ref.id)} className="btn-danger text-xs px-2 py-1">×</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add YouTube reference */}
          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Add YouTube Reference</h3>
            <div className="mb-3">
              <label className="text-xs mb-1 block" style={{ color: 'var(--text-secondary)' }}>YouTube URL</label>
              <input value={ytUrl} onChange={e => setYtUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..." className="input-field" />
            </div>
            <div className="mb-3">
              <label className="text-xs mb-1 block" style={{ color: 'var(--text-secondary)' }}>Notes</label>
              <input value={ytNotes} onChange={e => setYtNotes(e.target.value)} placeholder="Why this reference is relevant..." className="input-field" />
            </div>
            <button onClick={addYoutubeRef} disabled={!ytUrl.trim() || addingRef} className="btn-primary text-sm">
              {addingRef ? <><div className="spinner" style={{ width: 14, height: 14 }} />Fetching...</> : '➕ Add Reference'}
            </button>
          </div>
        </div>
      )}

      {/* Narration Tab */}
      {activeTab === 'narration' && (
        <NarrationTab
          projectId={project!.id}
          scriptId={activeScript?.id || ''}
          scriptText={activeScript?.content || ''}
          scriptVersion={activeScript?.version || 1}
        />
      )}
    </div>
  );
}
