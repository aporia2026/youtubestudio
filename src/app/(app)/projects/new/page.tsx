'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Link from 'next/link';

export default function NewProjectPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [niche, setNiche] = useState('');
  const [niches, setNiches] = useState<{ id: string; name: string }[]>([]);
  const [topic, setTopic] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch('/api/niches').then(r => r.json()).then(data => {
      setNiches(data.niches || []);
      if (data.niches?.length) setNiche(data.niches[0].name);
    });
  }, []);

  async function createProject() {
    if (!title.trim()) { toast.error('Enter a project title'); return; }
    setCreating(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, niche, topic }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      router.push(`/projects/${data.project.id}`);
    } catch {
      toast.error('Failed to create project');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="p-8 max-w-lg mx-auto">
      <Link href="/projects" className="text-xs flex items-center gap-1 mb-6" style={{ color: 'var(--text-muted)' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
        Back to Projects
      </Link>
      <h1 className="text-2xl font-bold mb-6" style={{ color: 'var(--text-primary)' }}>New Project</h1>
      <div className="glass rounded-xl p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Project Title *</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Best Antivirus 2024 Review" className="input-field" autoFocus />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Niche</label>
          <select value={niche} onChange={e => setNiche(e.target.value)} className="input-field" style={{ appearance: 'none' }}>
            {niches.map(n => <option key={n.id} value={n.name}>{n.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Topic / Video Idea <span style={{ color: 'var(--text-muted)' }}>(optional)</span></label>
          <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="Specific video topic or angle" className="input-field" />
        </div>
        <button onClick={createProject} disabled={creating || !title.trim()} className="btn-primary w-full justify-center" style={{ width: '100%', justifyContent: 'center' }}>
          {creating ? <><div className="spinner" style={{ width: 16, height: 16 }} />Creating...</> : 'Create Project'}
        </button>
      </div>
    </div>
  );
}
