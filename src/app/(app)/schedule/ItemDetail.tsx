'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import type { ScheduleItem, ScheduleStatus, RecurrenceRule } from '@/lib/schedule';
import { statusColor } from '@/lib/schedule';
import type { Channel } from './types';
import { RecurrenceEditor } from './RecurrenceEditor';

type Props = {
  item: ScheduleItem;
  channels: Channel[];
  statuses: ScheduleStatus[];
  onClose: () => void;
  onPatch: (id: string, patch: Partial<ScheduleItem> & { channel_ids?: string[] }) => void;
  onDelete: (id: string, alsoChildren?: boolean) => void;
  onRefresh: () => void;
};

type ScriptRow = {
  id: string;
  version: number;
  content: string;
  word_count: number;
  estimated_duration_seconds: number;
  is_active: boolean;
  created_at: string;
};

function dtLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ItemDetail({ item, channels, statuses, onClose, onPatch, onDelete, onRefresh }: Props) {
  const [tab, setTab] = useState<'details' | 'script' | 'recurrence'>('details');
  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [scriptDraft, setScriptDraft] = useState('');
  const [savingScript, setSavingScript] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  // Track the last successfully saved text so blur+blur with no edit doesn't create duplicate versions.
  const lastSavedRef = useRef<string>('');

  const loadScripts = useCallback(async (projectId: string) => {
    const res = await fetch(`/api/projects/${projectId}/scripts`);
    const data = await res.json();
    const list: ScriptRow[] = data.scripts || [];
    setScripts(list);
    const pinned = list.find(s => s.id === item.script_id) ?? list.find(s => s.is_active) ?? list[0];
    setScriptDraft(pinned?.content ?? '');
    lastSavedRef.current = pinned?.content ?? '';
  }, [item.script_id]);

  useEffect(() => {
    if (item.project_id) loadScripts(item.project_id);
    else { setScripts([]); setScriptDraft(''); }
  }, [item.project_id, loadScripts]);

  async function ensureProject(): Promise<string | null> {
    if (item.project_id) return item.project_id;
    setCreatingProject(true);
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: item.title || 'Untitled', niche: '', topic: item.notes ?? '' }),
    });
    const data = await res.json();
    setCreatingProject(false);
    if (!res.ok || !data.project) {
      toast.error('Could not create project');
      return null;
    }
    onPatch(item.id, { project_id: data.project.id });
    return data.project.id;
  }

  async function saveScript(content: string) {
    const projectId = await ensureProject();
    if (!projectId) return;
    setSavingScript(true);
    const res = await fetch(`/api/projects/${projectId}/scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    setSavingScript(false);
    if (!res.ok) {
      toast.error('Save failed');
      return;
    }
    onPatch(item.id, { script_id: data.script.id });
    lastSavedRef.current = content;
    loadScripts(projectId);
    toast.success(`Saved as version ${data.script.version}`);
  }

  function onScriptBlur() {
    if (!scriptDraft) return;
    // Avoid creating a new version if the text matches what we just saved
    // (blur → focus → blur with no edit used to duplicate).
    if (scriptDraft === lastSavedRef.current) return;
    const current = scripts.find(s => s.id === item.script_id) ?? scripts.find(s => s.is_active);
    if (scriptDraft !== (current?.content ?? '')) {
      saveScript(scriptDraft);
    }
  }

  const channelIds = new Set((item.channels ?? []).map(c => c.id));

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.5)' }}
      />
      <motion.aside
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'tween', duration: 0.2 }}
        className="fixed top-0 right-0 h-screen w-full max-w-2xl z-50 flex flex-col"
        style={{ background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <select
            value={item.status}
            onChange={e => onPatch(item.id, { status: e.target.value })}
            className="px-2 py-1 rounded text-xs font-medium"
            style={{
              background: statusColor(statuses, item.status) + '22',
              color: statusColor(statuses, item.status),
              border: `1px solid ${statusColor(statuses, item.status)}55`,
            }}
          >
            {statuses.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <input
            defaultValue={item.title}
            onBlur={e => { if (e.currentTarget.value !== item.title) onPatch(item.id, { title: e.currentTarget.value }); }}
            placeholder="Untitled video"
            className="flex-1 bg-transparent text-lg font-semibold outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
          <button onClick={() => { onDelete(item.id, !!item.recurrence); }} title="Delete"
            className="p-1.5 rounded"
            style={{ color: 'var(--text-muted)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
            </svg>
          </button>
          <button onClick={onClose} className="p-1.5 rounded" style={{ color: 'var(--text-muted)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-3" style={{ borderBottom: '1px solid var(--border)' }}>
          {(['details', 'script', 'recurrence'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className="px-3 py-2 text-xs font-medium rounded-t"
              style={{
                color: tab === t ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                borderBottom: tab === t ? '2px solid var(--accent-purple-bright)' : '2px solid transparent',
              }}>
              {t === 'details' ? 'Details' : t === 'script' ? `Script ${scripts.length ? `· v${scripts.find(s=>s.is_active)?.version ?? scripts[0]?.version}` : ''}` : 'Recurrence'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'details' && (
            <div className="space-y-4">
              <Field label="Scheduled for">
                <input type="datetime-local"
                  defaultValue={dtLocal(item.scheduled_for)}
                  onBlur={e => {
                    const raw = e.currentTarget.value;
                    const iso = raw ? new Date(raw).toISOString() : null;
                    onPatch(item.id, { scheduled_for: iso });
                  }}
                  className="w-full px-3 py-2 rounded-md text-sm"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                />
              </Field>

              <Field label="Channels">
                <div className="flex flex-wrap gap-2">
                  {channels.map(c => {
                    const on = channelIds.has(c.id);
                    return (
                      <button key={c.id}
                        onClick={() => {
                          const next = on
                            ? Array.from(channelIds).filter(x => x !== c.id)
                            : [...Array.from(channelIds), c.id];
                          onPatch(item.id, { channel_ids: next });
                        }}
                        className="px-2 py-1 rounded-full text-xs"
                        style={{
                          background: on ? (c.account_color || '#7c3aed') + '33' : 'var(--bg-tertiary)',
                          color: on ? (c.account_color || 'white') : 'var(--text-muted)',
                          border: `1px solid ${on ? (c.account_color || '#7c3aed') : 'var(--border)'}`,
                        }}>
                        {c.name}
                      </button>
                    );
                  })}
                  {channels.length === 0 && (
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Add channels in <Link href="/channel" className="underline">Channels</Link>
                    </div>
                  )}
                </div>
              </Field>

              <Field label="Tags">
                <input
                  defaultValue={(item.tags ?? []).join(', ')}
                  placeholder="tag, tag, tag"
                  onBlur={e => {
                    const tags = e.currentTarget.value.split(',').map(t => t.trim()).filter(Boolean);
                    onPatch(item.id, { tags });
                  }}
                  className="w-full px-3 py-2 rounded-md text-sm"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                />
              </Field>

              <Field label="Notes">
                <textarea
                  defaultValue={item.notes ?? ''}
                  rows={5}
                  onBlur={e => onPatch(item.id, { notes: e.currentTarget.value })}
                  className="w-full px-3 py-2 rounded-md text-sm resize-y"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                />
              </Field>

              <Field label="Links">
                <div className="space-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {item.idea_id && (
                    <div>Source idea: <Link href={`/ideas`} className="underline">open ideas</Link></div>
                  )}
                  {item.project_id && (
                    <div>Project: <Link href={`/projects/${item.project_id}`} className="underline">open project</Link></div>
                  )}
                  <div>
                    Script generator: <Link href={`/generator${item.project_id ? `?projectId=${item.project_id}` : ''}`} className="underline">open</Link>
                  </div>
                </div>
              </Field>
            </div>
          )}

          {tab === 'script' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                {item.project_id ? (
                  <>
                    <span>{scripts.length} version{scripts.length === 1 ? '' : 's'}</span>
                    <span>·</span>
                    <Link href={`/generator?projectId=${item.project_id}`} className="underline">Generate with AI</Link>
                    {savingScript && <span>· saving…</span>}
                  </>
                ) : (
                  <span>No project yet — typing below will create one and save as v1.</span>
                )}
              </div>
              {scripts.length > 1 && (
                <select
                  defaultValue={item.script_id ?? (scripts.find(s => s.is_active)?.id ?? scripts[0]?.id)}
                  onChange={e => {
                    const s = scripts.find(x => x.id === e.target.value);
                    if (s) { setScriptDraft(s.content); onPatch(item.id, { script_id: s.id }); }
                  }}
                  className="w-full px-3 py-2 rounded-md text-sm"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                >
                  {scripts.map(s => (
                    <option key={s.id} value={s.id}>
                      v{s.version} · {s.word_count} words · {new Date(s.created_at).toLocaleDateString()}
                      {s.is_active ? ' · active' : ''}
                    </option>
                  ))}
                </select>
              )}
              <textarea
                value={scriptDraft}
                onChange={e => setScriptDraft(e.currentTarget.value)}
                onBlur={onScriptBlur}
                rows={20}
                placeholder={creatingProject ? 'Creating project…' : 'Paste or write the script here. Saved on blur as a new version.'}
                disabled={creatingProject}
                className="w-full px-3 py-3 rounded-md text-sm font-mono resize-y"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', minHeight: 360 }}
              />
            </div>
          )}

          {tab === 'recurrence' && (
            <RecurrenceEditor
              value={item.recurrence}
              hasChildren={!!item.recurrence}
              onChange={rule => onPatch(item.id, { recurrence: rule as RecurrenceRule | null })}
              onRegenerate={async () => {
                const res = await fetch(`/api/schedule/${item.id}/children`, { method: 'PUT' });
                const data = await res.json();
                if (!res.ok) { toast.error(data.error || 'Could not regenerate'); return; }
                toast.success(`Regenerated ${data.created ?? 0} children`);
                onRefresh();
              }}
            />
          )}
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider mb-1.5"
        style={{ color: 'var(--text-muted)' }}>{label}</div>
      {children}
    </div>
  );
}
