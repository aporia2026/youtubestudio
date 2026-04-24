'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { listSeries, createSeries, type Series } from '@/lib/series';

interface Props {
  seriesId: string | null;
  partNumber: number;
  onChange: (next: { seriesId: string | null; seriesTitle?: string; partNumber: number }) => void;
  niche?: string;
  compact?: boolean;
}

/** Reusable series picker — used on the Script Generator and Idea Generator.
 *  Two-state UI: off (a single "Part of a series" toggle) or on (dropdown +
 *  create-new + part-number input). Auto-suggests the next part number when a
 *  series with existing parts is selected. */
export function SeriesPicker({ seriesId, partNumber, onChange, niche, compact }: Props) {
  const [enabled, setEnabled] = useState<boolean>(Boolean(seriesId));
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    listSeries({ niche })
      .then(s => setSeries(s))
      .finally(() => setLoading(false));
  }, [niche]);

  useEffect(() => {
    // If the seriesId prop changes from outside (e.g. draft resume), sync the toggle.
    setEnabled(Boolean(seriesId));
  }, [seriesId]);

  async function handleCreate() {
    const title = newTitle.trim();
    if (!title) { toast.error('Enter a series title'); return; }
    setCreating(true);
    const created = await createSeries({ title, niche });
    setCreating(false);
    if (!created) { toast.error('Could not create series'); return; }
    const fresh = await listSeries({ force: true, niche });
    setSeries(fresh);
    setNewTitle('');
    onChange({ seriesId: created.id, seriesTitle: created.title, partNumber: 1 });
    toast.success(`Series "${created.title}" created — this will be Part 1`);
  }

  function handleSelectChange(id: string) {
    if (id === '__create__') return; // handled separately
    if (!id) { onChange({ seriesId: null, seriesTitle: '', partNumber: 1 }); return; }
    const s = series.find(x => x.id === id);
    const nextPart = (s?.part_count || 0) + 1;
    onChange({ seriesId: id, seriesTitle: s?.title, partNumber: nextPart });
  }

  if (!enabled) {
    return (
      <div className={compact ? '' : 'mt-2'}>
        <button
          type="button"
          onClick={() => setEnabled(true)}
          className="text-xs font-medium"
          style={{ color: 'var(--accent-purple-bright)' }}
        >
          📺 Part of a series? Link it here
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Series</label>
        <button
          type="button"
          onClick={() => { setEnabled(false); onChange({ seriesId: null, seriesTitle: '', partNumber: 1 }); }}
          className="text-xs" style={{ color: 'var(--text-muted)' }}
        >
          ✕ unlink
        </button>
      </div>

      <select
        className="input-field w-full"
        style={{ fontSize: 13, padding: '6px 10px' }}
        value={seriesId || ''}
        onChange={e => handleSelectChange(e.target.value)}
        disabled={loading}
      >
        <option value="">— Select a series —</option>
        {series.map(s => (
          <option key={s.id} value={s.id}>
            {s.title}{typeof s.part_count === 'number' ? ` (${s.part_count} parts)` : ''}
            {s.niche ? ` · ${s.niche}` : ''}
          </option>
        ))}
      </select>

      <div className="flex gap-2">
        <input
          type="text"
          className="input-field flex-1"
          style={{ fontSize: 13, padding: '6px 10px' }}
          placeholder="…or create new series"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating || !newTitle.trim()}
          className="btn-secondary text-xs px-3"
        >
          {creating ? '…' : '+ New'}
        </button>
      </div>

      {seriesId && (
        <div className="flex items-center gap-2">
          <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Part #</label>
          <input
            type="number"
            min={1}
            className="input-field"
            style={{ width: 80, fontSize: 13, padding: '6px 10px' }}
            value={partNumber}
            onChange={e => onChange({ seriesId, partNumber: Math.max(1, parseInt(e.target.value) || 1) })}
          />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {partNumber > 1 ? 'Previous parts will be included as continuity context.' : 'First part — no continuity context.'}
          </span>
        </div>
      )}
    </div>
  );
}
