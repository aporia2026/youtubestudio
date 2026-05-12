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
    if (!confirm('Delete this preset? Runs that already used it will still exist but the preset can\'t be re-selected.')) return;
    try {
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
    <div className="p-6 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <Link href="/pipeline" className="text-sm text-zinc-500 hover:underline">
            ← Pipeline
          </Link>
          <h1 className="text-2xl font-semibold mt-2">Pipeline presets</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Reusable batch configurations. Each batch picks a preset for its rules, score thresholds, model
            fallback chains, narrator deadline, editor + thumbnail template.
          </p>
        </div>
        <button
          onClick={() => setEditingId('new')}
          className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-4 py-2 rounded-md text-sm font-medium"
        >
          New preset
        </button>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm">
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
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : presets.length === 0 ? (
        <div className="border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg p-8 text-center text-sm text-zinc-500">
          No presets yet. Click <strong>New preset</strong> to create one.
        </div>
      ) : (
        <ul className="space-y-3">
          {presets.map((p) => (
            <li
              key={p.id}
              className="border border-zinc-200 dark:border-zinc-800 rounded-md p-4 flex items-start justify-between"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-zinc-500 mt-1 flex gap-3 flex-wrap">
                  {p.niche && <span>{p.niche}</span>}
                  <span>Defaults to {p.ideas_count_default} ideas</span>
                  <span>QA ≥ {p.qa_min_score}</span>
                  <span>Max {p.qa_max_iterations} retries</span>
                  <span>Script gate {p.script_gate_enabled ? 'on' : 'off'}</span>
                  <span>{p.narration_deadline_days}d narration deadline</span>
                  {p.video_editor_collaborator_id && <span>· editor configured</span>}
                  {p.thumbnail_template_id && <span>· thumbnail template configured</span>}
                </div>
              </div>
              <div className="ml-4 flex gap-2 shrink-0">
                <button
                  onClick={() => setEditingId(p.id)}
                  className="text-xs text-zinc-600 dark:text-zinc-400 hover:underline"
                >
                  Edit
                </button>
                <button
                  onClick={() => void deletePreset(p.id)}
                  className="text-xs text-red-600 dark:text-red-400 hover:underline"
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
