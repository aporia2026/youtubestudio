'use client';

import type { RecurrenceRule } from '@/lib/schedule';

type Props = {
  value: RecurrenceRule | null;
  hasChildren: boolean;
  onChange: (rule: RecurrenceRule | null) => void;
  onRegenerate: () => void;
};

const DAYS: Array<{ key: NonNullable<RecurrenceRule['byday']>[number]; label: string }> = [
  { key: 'MO', label: 'M' }, { key: 'TU', label: 'T' }, { key: 'WE', label: 'W' },
  { key: 'TH', label: 'T' }, { key: 'FR', label: 'F' }, { key: 'SA', label: 'S' }, { key: 'SU', label: 'S' },
];

export function RecurrenceEditor({ value, hasChildren, onChange, onRegenerate }: Props) {
  const rule: RecurrenceRule = value ?? { freq: 'WEEKLY', interval: 1 };
  const enabled = !!value;

  function patch(p: Partial<RecurrenceRule>) {
    onChange({ ...rule, ...p });
  }

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
        <input type="checkbox"
          checked={enabled}
          onChange={e => onChange(e.currentTarget.checked ? rule : null)}
        />
        Repeat this video slot
      </label>

      {enabled && (
        <>
          <div className="flex items-center gap-2 text-sm">
            <span style={{ color: 'var(--text-muted)' }}>Every</span>
            <input type="number" min={1} max={52}
              value={rule.interval ?? 1}
              onChange={e => patch({ interval: Math.max(1, parseInt(e.currentTarget.value) || 1) })}
              className="w-16 px-2 py-1 rounded"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
            <select value={rule.freq}
              onChange={e => patch({ freq: e.currentTarget.value as RecurrenceRule['freq'] })}
              className="px-2 py-1 rounded"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              <option value="DAILY">day(s)</option>
              <option value="WEEKLY">week(s)</option>
              <option value="MONTHLY">month(s)</option>
            </select>
          </div>

          {rule.freq === 'WEEKLY' && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-1.5"
                style={{ color: 'var(--text-muted)' }}>On days</div>
              <div className="flex gap-1">
                {DAYS.map(d => {
                  const on = (rule.byday ?? []).includes(d.key);
                  return (
                    <button key={d.key}
                      onClick={() => {
                        const cur = new Set(rule.byday ?? []);
                        if (cur.has(d.key)) cur.delete(d.key); else cur.add(d.key);
                        patch({ byday: Array.from(cur) });
                      }}
                      className="w-8 h-8 rounded text-xs font-semibold"
                      style={{
                        background: on ? 'var(--accent-purple-bright)' : 'var(--bg-tertiary)',
                        color: on ? 'white' : 'var(--text-muted)',
                        border: '1px solid var(--border)',
                      }}>
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-1.5"
                style={{ color: 'var(--text-muted)' }}>End after N</div>
              <input type="number" min={1} max={104}
                value={rule.count ?? ''}
                placeholder="∞"
                onChange={e => patch({ count: e.currentTarget.value ? parseInt(e.currentTarget.value) : undefined })}
                className="w-full px-3 py-2 rounded text-sm"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              />
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider mb-1.5"
                style={{ color: 'var(--text-muted)' }}>Or until date</div>
              <input type="date"
                value={rule.until ? rule.until.slice(0, 10) : ''}
                onChange={e => patch({ until: e.currentTarget.value || undefined })}
                className="w-full px-3 py-2 rounded text-sm"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              />
            </div>
          </div>

          {hasChildren && (
            <div className="p-3 rounded text-xs"
              style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' }}>
              Rule changes apply to future-generated children only. Click below to delete existing children and re-expand from this rule.
              <button onClick={onRegenerate} className="block mt-2 underline">Regenerate children</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
