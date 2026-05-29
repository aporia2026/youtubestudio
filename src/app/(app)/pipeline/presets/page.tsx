'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import PresetForm from './PresetForm';

interface PresetRow {
  id: string;
  name: string;
  niche: string | null;
  ideas_count_default: number;
  qa_min_score: string;
  qa_max_iterations: number;
  script_gate_enabled: boolean;
  narration_deadline_days: number;
  video_editor_collaborator_id: string | null;
  thumbnail_template_id: string | null;
  seo_template_id: string | null;
  updated_at: string;
}

export default function PresetsListPage() {
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch('/api/auto-pipeline/presets', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPresets((data.presets as PresetRow[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function deletePreset(id: string) {
    if (
      !confirm(
        "Delete this preset? Runs that already used it will still exist but the preset can't be re-selected.",
      )
    )
      return;
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
      const res = await fetch(`/api/auto-pipeline/presets/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="flex items-start justify-between mb-6 gap-3 flex-wrap">
        <div>
          <Link
            href="/pipeline"
            className="text-sm hover:underline"
            style={{ color: 'var(--text-muted)' }}
          >
            ← Pipeline
          </Link>
          <h1 className="text-2xl font-bold gradient-text mt-2">Pipeline presets</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Reusable batch configurations. A pipeline preset bundles one feature preset per stage
            (script · QA · narration · idea) plus model fallback chains, editor handoff, and
            thumbnail/SEO templates.
          </p>
          <nav
            className="mt-3 flex gap-2 flex-wrap text-xs"
            aria-label="Manage feature presets"
          >
            <span style={{ color: 'var(--text-muted)' }}>Manage feature presets:</span>
            <Link
              href="/pipeline/presets/script"
              className="hover:underline"
              style={{ color: 'var(--accent-purple-bright)' }}
            >
              Script
            </Link>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <Link
              href="/pipeline/presets/qa"
              className="hover:underline"
              style={{ color: 'var(--accent-purple-bright)' }}
            >
              QA
            </Link>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <Link
              href="/pipeline/presets/narration"
              className="hover:underline"
              style={{ color: 'var(--accent-purple-bright)' }}
            >
              Narration
            </Link>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <Link
              href="/pipeline/presets/idea"
              className="hover:underline"
              style={{ color: 'var(--accent-purple-bright)' }}
            >
              Idea-gen
            </Link>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <Link
              href="/pipeline/thumbnail-templates"
              className="hover:underline"
              style={{ color: 'var(--accent-purple-bright)' }}
            >
              Thumbnail templates
            </Link>
          </nav>
        </div>
        <button onClick={() => setEditingId('new')} className="btn-primary text-sm">
          ＋ New preset
        </button>
      </div>

      {error && (
        <div
          className="mb-4 p-3 rounded text-sm"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
          {error}
        </div>
      )}

      {editingId !== null && (
        <PresetForm
          presetId={editingId === 'new' ? null : editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            void refresh();
          }}
          onError={setError}
        />
      )}

      {loading ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading…
        </div>
      ) : presets.length === 0 ? (
        <div className="glass rounded-xl p-10 text-center" style={{ borderStyle: 'dashed' }}>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            No presets yet. Click <strong>New preset</strong> to create one.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {presets.map((p) => (
            <li key={p.id} className="glass rounded-xl p-4 flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {p.name}
                </div>
                <div
                  className="text-xs mt-1 flex gap-3 flex-wrap"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {p.niche && <span>{p.niche}</span>}
                  <span>Defaults to {p.ideas_count_default} ideas</span>
                  <span>QA ≥ {p.qa_min_score}</span>
                  <span>Max {p.qa_max_iterations} retries</span>
                  <span>Script gate {p.script_gate_enabled ? 'on' : 'off'}</span>
                  <span>{p.narration_deadline_days}d narration deadline</span>
                </div>
                <div className="mt-2 flex gap-2 flex-wrap">
                  {p.video_editor_collaborator_id && <Pill color="green">Editor configured</Pill>}
                  {p.thumbnail_template_id && <Pill color="cyan">Thumbnail template</Pill>}
                  {p.seo_template_id && <Pill color="purple">SEO template</Pill>}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => setEditingId(p.id)}
                  className="btn-secondary text-xs"
                  style={{ padding: '6px 12px' }}
                >
                  Edit
                </button>
                <button
                  onClick={() => void deletePreset(p.id)}
                  className="btn-danger text-xs"
                  style={{ padding: '6px 12px' }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Pill({ children, color }: { children: React.ReactNode; color: 'green' | 'cyan' | 'purple' }) {
  const palette: Record<'green' | 'cyan' | 'purple', { bg: string; color: string }> = {
    green: { bg: 'rgba(16,185,129,0.15)', color: '#34d399' },
    cyan: { bg: 'rgba(6,182,212,0.15)', color: '#22d3ee' },
    purple: { bg: 'rgba(124,58,237,0.15)', color: '#a78bfa' },
  };
  const s = palette[color];
  return (
    <span
      className="text-xs px-2 py-0.5 rounded font-medium"
      style={{ background: s.bg, color: s.color }}
    >
      {children}
    </span>
  );
}
