'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { useParams, useSearchParams } from 'next/navigation';
import { formatBytes, countWords, estimateDuration, formatDuration } from '@/lib/utils';
import { ScriptVoiceoverPanel } from '@/components/ui/ScriptVoiceoverPanel';
import { NarrationTab } from '@/components/narrator/NarrationTab';
import { EditorTab } from '@/components/editor/EditorTab';
import { YouTubeDescriptionPanel } from '@/components/ui/YouTubeDescriptionPanel';
import { PublishToYoutubeModal } from '@/components/publishing/PublishToYoutubeModal';
import { downloadCrossOriginFile } from '@/lib/download-file';
import Link from 'next/link';

type TabId = 'script' | 'voiceover' | 'media' | 'references' | 'narration' | 'editor';

interface Project {
  id: string;
  title: string;
  niche: string;
  topic: string;
  status: string;
  youtube_description?: string | null;
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
  const searchParams = useSearchParams();
  // Deep-link targets from the global comments inbox. Captured once so the
  // values don't fluctuate when the inbox URL pollutes the project URL.
  const initialReviewTakeId = searchParams.get('take') ?? undefined;
  const initialCommentId = searchParams.get('comment') ?? undefined;
  const [project, setProject] = useState<Project | null>(null);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [refs, setRefs] = useState<YoutubeRef[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (typeof window === 'undefined') return 'script';
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab === 'narration' || tab === 'voiceover' || tab === 'media' || tab === 'references' || tab === 'script' || tab === 'editor') return tab;
    return 'script';
  });
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
      const active = sc.scripts?.find((s: Script) => s.is_active) ?? sc.scripts?.[0];
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
      const res = await fetch(`/api/projects/${id}/scripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: scriptContent }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Save failed (${res.status})`);
      }
      toast.success('Script saved');
      setEditingScript(false);
      fetchAll();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed'); }
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
    // Voiceover audio files routinely exceed Vercel's 4.5 MB API body cap,
    // so for that type we go browser → Blob directly with a server-issued
    // token. The other types (small images, etc.) keep using /api/upload.
    if (type === 'voiceover') {
      return uploadVoiceoverFile(file);
    }
    setUploadingFile(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('type', type);
      form.append('projectId', id);
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) {
        // Surface the server's actual error so failures aren't silent.
        const data = await res.json().catch(() => ({}));
        throw new Error((data && data.error) ? data.error : `Upload failed (${res.status})`);
      }
      toast.success('File uploaded');
      fetchAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    }
    finally { setUploadingFile(false); }
  }

  // Direct browser → Cloudflare R2 narration bucket upload for voiceover
  // files. Two-step: server hands back a presigned PUT URL, browser PUTs
  // the file straight to R2 (bypassing Vercel's 4.5 MB API body cap), and
  // we then register the asset via /media POST so the row inherits the
  // project's workspace_id and stores r2_bucket / r2_key for URL refresh.
  async function uploadVoiceoverFile(file: File) {
    setUploadingFile(true);
    try {
      const presignRes = await fetch(`/api/projects/${id}/voiceover-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type || 'audio/mpeg' }),
      });
      if (!presignRes.ok) {
        const data = await presignRes.json().catch(() => ({}));
        throw new Error((data && data.error) ? data.error : `Presign failed (${presignRes.status})`);
      }
      const { uploadUrl, downloadUrl, r2Key, r2Bucket } = await presignRes.json();

      // Direct PUT to R2 — file bytes never touch our API route.
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'audio/mpeg' },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`R2 upload failed (${putRes.status})`);
      }

      const res = await fetch(`/api/projects/${id}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'voiceover',
          source: 'upload',
          name: file.name,
          url: downloadUrl,
          r2_bucket: r2Bucket,
          r2_key: r2Key,
          size_bytes: file.size,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data && data.error) ? data.error : `Failed to register upload (${res.status})`);
      }
      toast.success('Voiceover uploaded');
      fetchAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploadingFile(false);
    }
  }

  // Picker modal state — lists existing workspace voiceovers (other projects
  // + narrator-approved full audio) so the user can attach one without
  // re-uploading. Attaching = INSERT a new media_assets row pointing at the
  // same r2_key, so the file lives in R2 once but each project gets its own
  // row (with its own workspace_id, project_id, etc.).
  const [showVoiceoverPicker, setShowVoiceoverPicker] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  type LibraryItem = {
    id: string;
    project_id: string;
    project_title: string | null;
    name: string | null;
    url: string | null;
    r2_bucket: string | null;
    r2_key: string | null;
    blob_pathname: string | null;
    size_bytes: number | null;
    duration_seconds: number | null;
    created_at: string;
  };
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [attaching, setAttaching] = useState<string | null>(null);

  async function openVoiceoverPicker() {
    setShowVoiceoverPicker(true);
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const res = await fetch(`/api/projects/${id}/voiceover-library`);
      if (!res.ok) throw new Error(`Failed to load library (${res.status})`);
      const data = await res.json();
      setLibrary(data.voiceovers || []);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : 'Failed to load library');
    } finally {
      setLibraryLoading(false);
    }
  }

  async function attachExistingVoiceover(item: LibraryItem) {
    if (attaching) return;
    setAttaching(item.id);
    try {
      const res = await fetch(`/api/projects/${id}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'voiceover',
          source: item.r2_key ? 'r2-link' : 'url',
          name: item.name || 'Linked voiceover',
          url: item.url,
          r2_bucket: item.r2_bucket,
          r2_key: item.r2_key,
          blob_pathname: item.blob_pathname,
          size_bytes: item.size_bytes,
          duration_seconds: item.duration_seconds,
          metadata: { linked_from_asset_id: item.id, linked_from_project_id: item.project_id },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data && data.error) ? data.error : `Failed to attach (${res.status})`);
      }
      toast.success('Voiceover attached');
      setShowVoiceoverPicker(false);
      fetchAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to attach');
    } finally {
      setAttaching(null);
    }
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

  // Self-heal for projects whose rows all have is_active=false (a prior bug
  // could leave the table in that state). Scripts are returned ORDER BY
  // version DESC, so [0] is the latest version and is what the user almost
  // certainly intended to see.
  const activeScript = scripts.find(s => s.is_active) ?? scripts[0];
  const words = countWords(scriptContent || activeScript?.content || '');
  const estDuration = estimateDuration(words);

  const TABS: { id: TabId; label: string; count?: number }[] = [
    { id: 'script', label: '📝 Script', count: scripts.length },
    { id: 'voiceover', label: '🎙️ Voiceover' },
    { id: 'media', label: '🎬 Media', count: media.length },
    { id: 'references', label: '🔗 References', count: refs.length },
    { id: 'narration', label: '🎤 Narration' },
    { id: 'editor', label: '🎬 Editor' },
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
          <Link href={`/production-doc?projectId=${id}`}>
            <button className="btn-secondary text-sm">🎬 Production Doc</button>
          </Link>
          <button
            onClick={() => setPublishOpen(true)}
            className="text-sm font-medium px-3 py-1.5 rounded-lg"
            style={{ background: '#ef4444', color: 'white' }}
          >
            🚀 Publish to YouTube
          </button>
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
        <div className="space-y-4">
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

        {/* YouTube description — shown after a script exists. Generate, edit,
            and save a SEO-tuned, human-voice description per project. */}
        {activeScript && project && (
          <YouTubeDescriptionPanel
            projectId={project.id}
            title={project.title}
            niche={project.niche}
            topic={project.topic}
            scriptContent={activeScript.content}
            initialDescription={project.youtube_description}
          />
        )}
        </div>
      )}

      {/* Voiceover Tab */}
      {activeTab === 'voiceover' && (
        <div className="space-y-4">
          {media.filter(m => m.type === 'voiceover').length > 0 ? (
            media.filter(m => m.type === 'voiceover').map(vo => (
              <div key={vo.id} className="glass rounded-xl p-5">
                <div className="flex items-center justify-between mb-3 gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{vo.name}</h3>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{vo.source === 'upload' ? 'Uploaded' : 'External URL'}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => downloadCrossOriginFile(vo.url, vo.name).catch(e => toast.error(`Download failed: ${e instanceof Error ? e.message : 'unknown error'}`))}
                      className="text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1 hover:bg-white/10"
                      style={{ color: '#a78bfa', background: 'rgba(124,58,237,0.12)' }}
                      title="Download voiceover file"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      Download
                    </button>
                    <button onClick={() => deleteMedia(vo.id)} className="btn-danger text-xs px-2 py-1">Remove</button>
                  </div>
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
              {/* Pick existing */}
              <div>
                <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Or Pick Existing</p>
                <button
                  onClick={openVoiceoverPicker}
                  className="btn-secondary w-full justify-center"
                  style={{ justifyContent: 'center' }}
                  title="Reuse an existing voiceover from elsewhere in your workspace"
                >
                  📚 From library
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
          projectTitle={project!.title}
          // Inbox deep-link: /projects/<id>?tab=narration&take=<id>&comment=<id>
          initialReviewTakeId={initialReviewTakeId}
          initialCommentId={initialCommentId}
        />
      )}

      {/* Editor Tab */}
      {activeTab === 'editor' && project && (
        <EditorTab projectId={project.id} />
      )}

      <PublishToYoutubeModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        defaultTitle={project?.title || ''}
        defaultDescription={project?.youtube_description || ''}
        defaultProjectId={id}
      />

      {/* Voiceover library picker — overlay modal listing other voiceovers in
          this workspace (any project). Clicking a row inserts a new
          media_assets row on this project pointing at the same R2 file. */}
      <AnimatePresence>
        {showVoiceoverPicker && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={() => setShowVoiceoverPicker(false)}
          >
            <motion.div
              initial={{ y: 8, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 8, opacity: 0 }}
              className="rounded-2xl w-[min(720px,92vw)] max-h-[85vh] flex flex-col"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Voiceover library</h3>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Pick an existing voiceover from another project to attach here.
                  </p>
                </div>
                <button
                  onClick={() => setShowVoiceoverPicker(false)}
                  className="text-xs px-2 py-1 rounded"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-3">
                {libraryLoading && (
                  <div className="flex items-center justify-center py-12">
                    <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin"
                      style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
                  </div>
                )}
                {!libraryLoading && libraryError && (
                  <p className="text-xs text-center py-8" style={{ color: '#ef4444' }}>{libraryError}</p>
                )}
                {!libraryLoading && !libraryError && library.length === 0 && (
                  <p className="text-xs text-center py-12" style={{ color: 'var(--text-muted)' }}>
                    No other voiceovers in your workspace yet.
                  </p>
                )}
                {!libraryLoading && !libraryError && library.length > 0 && (
                  <div className="space-y-2">
                    {library.map(item => {
                      const sizeMb = item.size_bytes ? (item.size_bytes / 1024 / 1024).toFixed(1) : null;
                      const dur = item.duration_seconds ? formatDuration(item.duration_seconds) : null;
                      return (
                        <div
                          key={item.id}
                          className="rounded-lg p-3"
                          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
                        >
                          <div className="flex items-start justify-between gap-3 mb-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                {item.name || 'Untitled'}
                              </p>
                              <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                                {item.project_title || '—'}
                                {dur && ` · ${dur}`}
                                {sizeMb && ` · ${sizeMb} MB`}
                              </p>
                            </div>
                            <button
                              onClick={() => attachExistingVoiceover(item)}
                              disabled={attaching === item.id}
                              className="btn-primary text-[11px] px-2.5 py-1 shrink-0"
                            >
                              {attaching === item.id ? 'Attaching…' : 'Attach'}
                            </button>
                          </div>
                          {item.url && (
                            <audio controls preload="none" src={item.url} className="w-full" style={{ height: 32 }} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
