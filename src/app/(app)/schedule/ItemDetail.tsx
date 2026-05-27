'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import type { ScheduleItem, ScheduleStatus, RecurrenceRule, ChecklistItem } from '@/lib/schedule';
import { statusColor } from '@/lib/schedule';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import type { Channel } from './types';
import { RecurrenceEditor } from './RecurrenceEditor';
import { ChecklistSection } from './ChecklistSection';
import { ThumbnailSlots } from './ThumbnailSlots';
import { DependenciesSection } from './DependenciesSection';
import { SeriesPicker } from '@/components/ui/SeriesPicker';
import { EditorPicker } from './EditorPicker';
import { TeamMemberPicker } from './TeamMemberPicker';
import { SCHEDULE_LINK_PARAM } from '@/lib/schedule-link';
import { PublishToYoutubeModal } from '@/components/publishing/PublishToYoutubeModal';

type Props = {
  item: ScheduleItem;
  channels: Channel[];
  statuses: ScheduleStatus[];
  allItems: ScheduleItem[];
  onClose: () => void;
  onPatch: (id: string, patch: Partial<ScheduleItem> & { channel_ids?: string[] }) => void;
  onDelete: (id: string, alsoChildren?: boolean) => void;
  onRefresh: () => void;
  onSelectItem: (id: string) => void;
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

export function ItemDetail({ item, channels, statuses, allItems, onClose, onPatch, onDelete, onRefresh, onSelectItem }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<'details' | 'script' | 'recurrence'>('details');
  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [scriptDraft, setScriptDraft] = useState('');
  const [savingScript, setSavingScript] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [autoContinuing, setAutoContinuing] = useState(false);
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
    const data = await res.json().catch(() => ({}));
    setCreatingProject(false);
    if (!res.ok || !data.project) {
      const detail = data?.error ? `: ${data.error}` : '';
      toast.error(`Could not create project${detail}`);
      console.error('ensureProject failed', { status: res.status, data });
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
    const data = await res.json().catch(() => ({}));
    setSavingScript(false);
    if (!res.ok) {
      const detail = data?.error ? `: ${data.error}` : '';
      toast.error(`Save failed${detail}`);
      console.error('saveScript failed', { status: res.status, data });
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
  // Memoise the linked-channels array by stable identity so EditorPicker's
  // effect doesn't refetch the roster on every parent rerender (keystrokes
  // in the title input triggered N /api/channels/{id}/editors fetches).
  const linkedChannels = useMemo(
    () => (item.channels ?? []).map(c => ({ id: c.id, name: c.name, account_color: c.account_color })),
    // Item identity from the server is stable per render; channel set only
    // changes when channel_ids is patched, in which case we do want to refetch.
    [item.channels?.map(c => c.id).join(',')],
  );
  const [titleSuggestions, setTitleSuggestions] = useState<Array<{ title: string; angle: string; ctr_hint: string }> | null>(null);
  const [suggestingTitles, setSuggestingTitles] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  async function suggestTitles() {
    setSuggestingTitles(true);
    try {
      const res = await fetch('/api/schedule/ai/title-from-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_id: item.id,
          modelId: getFeatureDefaultModelId('schedule-title'),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setTitleSuggestions(data.titles || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI failed');
    } finally {
      setSuggestingTitles(false);
    }
  }

  /**
   * Spin up an auto-pipeline run for THIS schedule item's project,
   * starting at narration_complete. Skips idea/script/QA/narration
   * wait entirely — the cron picks it up and runs production doc →
   * thumbnail → editor handoff → SEO.
   *
   * Prerequisites: project_id + script_id must be set on the item.
   * Without them, the production-doc handler would immediately fail
   * its invariant guard; we surface that as a disabled button rather
   * than a 400 mid-fetch.
   *
   * Preset: defaults to the first preset in the workspace. If there
   * are none, route the user to /pipeline/presets to create one
   * (the pipeline run can't exist without one).
   */
  async function autoContinue() {
    if (!item.project_id || !item.script_id) {
      toast.error('Save a script to a project first.');
      return;
    }
    setAutoContinuing(true);
    try {
      const presetsRes = await fetch('/api/auto-pipeline/presets', { cache: 'no-store' });
      const presetsData = await presetsRes.json().catch(() => ({}));
      const presets = (presetsData.presets ?? []) as Array<{ id: string; name: string }>;
      if (presets.length === 0) {
        toast.error('No pipeline preset yet — create one first.', {
          action: { label: 'Open presets', onClick: () => router.push('/pipeline/presets') },
        });
        return;
      }
      const presetId = presets[0].id;
      console.info('[schedule auto-continue] submit', {
        item_id: item.id,
        project_id: item.project_id,
        preset_id: presetId,
      });
      const res = await fetch('/api/auto-pipeline/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId, existingProjectIds: [item.project_id] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      toast.success(`Auto-continuing under preset "${presets[0].name}"`);
      router.push(`/pipeline/${data.runId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start auto-continue';
      console.info('[schedule auto-continue] error', { item_id: item.id, error: msg });
      toast.error(msg);
    } finally {
      setAutoContinuing(false);
    }
  }

  async function prepareForYouTube() {
    const lines = [
      `Title: ${item.title || 'Untitled'}`,
      '',
      'Description:',
      item.yt_description || item.notes || '',
      '',
      `Tags: ${(item.yt_tags ?? item.tags ?? []).join(', ')}`,
      '',
      item.scheduled_for ? `Scheduled publish: ${new Date(item.scheduled_for).toLocaleString()}` : 'No scheduled date',
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      // Single open — the action button on the toast used to double-open a
      // tab because the line below it also eagerly called window.open.
      toast.success('Copied to clipboard', {
        action: { label: 'Open YouTube Studio', onClick: () => window.open('https://studio.youtube.com/channel/UC/videos/upload', '_blank') },
      });
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

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
          <button
            onClick={() => {
              // Recurrence parents cascade their children; warn about that in the prompt
              // so a one-click tap doesn't silently nuke the whole series.
              const msg = item.recurrence
                ? `Delete "${item.title || 'Untitled'}" and every recurrence child? This cannot be undone.`
                : `Delete "${item.title || 'Untitled'}"? This cannot be undone.`;
              if (window.confirm(msg)) onDelete(item.id, !!item.recurrence);
            }}
            title="Delete"
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

        {/* Quick actions row */}
        <div className="flex items-center gap-2 px-4 pt-2 pb-1 text-xs">
          <button onClick={suggestTitles} disabled={suggestingTitles || !item.project_id}
            title={item.project_id ? 'AI title candidates from the linked script' : 'Add a script first'}
            className="flex items-center gap-1 px-2 py-1 rounded"
            style={{
              background: 'rgba(124,58,237,0.1)',
              color: item.project_id ? '#7c3aed' : 'var(--text-muted)',
              opacity: item.project_id ? 1 : 0.5,
              border: '1px solid rgba(124,58,237,0.3)',
            }}>
            ✨ {suggestingTitles ? 'Thinking…' : 'AI titles'}
          </button>
          <button
            onClick={autoContinue}
            disabled={autoContinuing || !item.project_id || !item.script_id}
            title={
              !item.project_id || !item.script_id
                ? 'Save a script to this item first — the pipeline starts at production doc and needs one to work from.'
                : 'Start an auto-pipeline run for THIS video at narration_complete. Skips idea/script/QA — runs production doc, thumbnail, editor handoff, and SEO.'
            }
            className="flex items-center gap-1 px-2 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: 'rgba(6,182,212,0.10)',
              color: '#06b6d4',
              border: '1px solid rgba(6,182,212,0.35)',
            }}
          >
            🤖 {autoContinuing ? 'Starting…' : 'Auto-continue'}
          </button>
          <button onClick={prepareForYouTube}
            className="flex items-center gap-1 px-2 py-1 rounded"
            style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
            📺 Prepare for YouTube
          </button>
          <button onClick={() => setPublishOpen(true)}
            className="flex items-center gap-1 px-2 py-1 rounded"
            style={{ background: '#ef4444', color: 'white', border: '1px solid #ef4444' }}>
            🚀 Publish
          </button>
        </div>

        {/* Send to another feature — propagates the scheduleItemId so the
            target page can preload context and write back on completion. */}
        <div className="flex items-center gap-1 px-4 pt-2 pb-1 text-xs overflow-x-auto"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="text-[10px] uppercase tracking-wider font-semibold shrink-0 mr-1" style={{ color: 'var(--text-muted)' }}>
            Send to
          </span>
          <SendToButton label="💡 Ideas" href={`/ideas?${SCHEDULE_LINK_PARAM}=${item.id}`}
            title={item.series_id ? 'Generate next ideas in this series' : 'Open Idea Generator seeded with this niche'} />
          <SendToButton label="🧠 Script" href={`/generator?${SCHEDULE_LINK_PARAM}=${item.id}`} />
          <SendToButton label="🔬 QA"     href={`/qa?${SCHEDULE_LINK_PARAM}=${item.id}`} disabled={!item.project_id}
            title={item.project_id ? 'Open QA Engine with this item linked' : 'Generate or paste a script first'} />
          <SendToButton label="🎬 Production Doc" href={`/production-doc?${SCHEDULE_LINK_PARAM}=${item.id}`} />
          <SendToButton label="🔍 SEO" href={`/seo?${SCHEDULE_LINK_PARAM}=${item.id}`} />
          <SendToButton label="🎙️ Voiceover" href={`/voiceover?${SCHEDULE_LINK_PARAM}=${item.id}`} disabled={!item.project_id}
            title={item.project_id ? 'Open Voiceover with this item linked' : 'Link a script first'} />
          <SendToButton label="🎨 Thumbnail" href={`/thumbnails?${SCHEDULE_LINK_PARAM}=${item.id}`} />

          {/* Start a video review — creates a review_project and jumps straight
              to its detail page where you can upload the cut + share with the
              editor. The review project's id is stored in custom_fields so a
              subsequent click reuses the same review project instead of
              creating a duplicate. */}
          <ActionButton
            label="🎞️ Video Review"
            onClick={async () => {
              const cf = item.custom_fields as Record<string, string> | undefined;
              const existing = cf?.review_project_id;
              if (existing) { window.location.href = `/reviews/${existing}`; return; }
              try {
                const res = await fetch('/api/review/projects', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ title: item.title || 'Untitled', description: item.notes || undefined }),
                });
                if (!res.ok) throw new Error('Failed to create review project');
                const { project } = await res.json();
                // Persist the link so future clicks deep-link directly + the
                // ListView badge can pick it up. custom_fields_merge does a
                // jsonb || merge server-side instead of replacing the whole field.
                await fetch(`/api/schedule/${item.id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ custom_fields_merge: { review_project_id: project.id } }),
                });
                window.location.href = `/reviews/${project.id}`;
              } catch { toast.error('Could not start video review'); }
            }}
          />

          {/* Start a narration review — needs a script + a Team narrator
              picked above. Creates the narrator_assignment and lands on the
              project's Narration tab where takes can be reviewed as they're
              submitted. */}
          <ActionButton
            label="🎤 Narration Review"
            disabled={!item.project_id || !item.script_id || !item.narrator_collaborator_id}
            title={
              !item.project_id || !item.script_id ? 'Save a script to a project first' :
              !item.narrator_collaborator_id ? 'Pick a Narrator (from Team) above first' :
              'Create the narrator assignment + open the review tab'
            }
            onClick={async () => {
              if (!item.project_id || !item.script_id || !item.narrator_collaborator_id) return;
              try {
                // Fetch the script content to pass to the assignment splitter
                const scriptRes = await fetch(`/api/projects/${item.project_id}/scripts`);
                if (!scriptRes.ok) throw new Error('Failed to load script');
                const scriptsData = await scriptRes.json();
                const scripts = Array.isArray(scriptsData) ? scriptsData : (scriptsData.scripts || []);
                const script = scripts.find((s: { id: string }) => s.id === item.script_id) || scripts[0];
                if (!script?.content) throw new Error('Script content empty');
                const res = await fetch('/api/narrator/assignments', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    project_id: item.project_id,
                    script_id: item.script_id,
                    narrator_id: item.narrator_collaborator_id,
                    script_text: script.content,
                    script_version: script.version,
                  }),
                });
                if (!res.ok) {
                  const err = await res.json().catch(() => ({}));
                  throw new Error(err.error || 'Failed to create assignment');
                }
                toast.success('Narrator assigned — opening review');
                window.location.href = `/projects/${item.project_id}?tab=narration`;
              } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not start narration review'); }
            }}
          />
        </div>

        {titleSuggestions && (
          <div className="px-4 pt-2 pb-2 space-y-1" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-muted)' }}>
              AI title candidates
            </div>
            {titleSuggestions.map((t, i) => (
              <button key={i} onClick={() => { onPatch(item.id, { title: t.title }); toast.success('Title updated'); setTitleSuggestions(null); }}
                className="w-full text-left px-2 py-1.5 rounded text-xs"
                style={{ background: 'var(--bg-tertiary)' }}>
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{t.title}</div>
                <div style={{ color: 'var(--text-muted)' }}>{t.angle} · {t.ctr_hint}</div>
              </button>
            ))}
            <button onClick={() => setTitleSuggestions(null)} className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Dismiss
            </button>
          </div>
        )}

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

              <Field label="Editor (from Team)">
                <TeamMemberPicker
                  role="editor"
                  selectedId={item.editor_collaborator_id ?? null}
                  selectedName={item.editor_collaborator_name ?? null}
                  selectedColor={item.editor_collaborator_color ?? null}
                  selectedToken={item.editor_collaborator_token ?? null}
                  onChange={id => onPatch(item.id, { editor_collaborator_id: id })}
                />
              </Field>

              <Field label="Narrator (from Team)">
                <TeamMemberPicker
                  role="narrator"
                  selectedId={item.narrator_collaborator_id ?? null}
                  selectedName={item.narrator_collaborator_name ?? null}
                  selectedColor={item.narrator_collaborator_color ?? null}
                  selectedToken={item.narrator_collaborator_token ?? null}
                  onChange={async id => {
                    // Always update the pointer first so the UI reflects the pick.
                    onPatch(item.id, { narrator_collaborator_id: id });

                    // Auto-create the actual narrator_assignment so the picked
                    // person sees the project in their dashboard immediately —
                    // previously this required a separate "🎤 Narration Review"
                    // button click and was easy to miss. Conditions:
                    //   - we're picking someone (not clearing)
                    //   - the schedule item already has project_id + script_id
                    //   - no assignment for this (project, narrator) exists yet
                    // Failures are intentionally silent — if the script isn't
                    // ready or the assignment can't be built, the manual button
                    // is still there as the explicit path.
                    if (!id || !item.project_id || !item.script_id) return;
                    try {
                      const existingRes = await fetch('/api/narrator/assignments');
                      if (existingRes.ok) {
                        const all: Array<{ project_id?: string; narrator_id?: string }> = await existingRes.json();
                        const dup = all.find(a => a.project_id === item.project_id && a.narrator_id === id);
                        if (dup) return; // assignment already exists, nothing to do
                      }
                      const scriptsRes = await fetch(`/api/projects/${item.project_id}/scripts`);
                      if (!scriptsRes.ok) return;
                      const scriptsData = await scriptsRes.json();
                      const scripts = Array.isArray(scriptsData) ? scriptsData : (scriptsData.scripts || []);
                      const script = scripts.find((s: { id: string }) => s.id === item.script_id) || scripts[0];
                      if (!script?.content) return;
                      const created = await fetch('/api/narrator/assignments', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          project_id: item.project_id,
                          script_id: item.script_id,
                          narrator_id: id,
                          script_text: script.content,
                          script_version: script.version,
                        }),
                      });
                      if (created.ok) {
                        toast.success('Narrator assigned, sections sent to their dashboard');
                      }
                    } catch {
                      // Silent — pointer is saved, user can retry via the
                      // 🎤 Narration Review action button.
                    }
                  }}
                />
              </Field>

              <Field label="Channel-roster editor (legacy)">
                <EditorPicker
                  linkedChannels={linkedChannels}
                  selectedEditorId={item.editor_id ?? null}
                  onChange={editorId => onPatch(item.id, { editor_id: editorId })}
                  onRosterChanged={onRefresh}
                />
              </Field>

              <Field label="Series">
                <SeriesPicker
                  seriesId={item.series_id ?? null}
                  partNumber={item.part_number ?? 1}
                  onChange={({ seriesId, seriesTitle, partNumber }) => {
                    // Forward series_title into the optimistic patch too so the
                    // card badge updates immediately; PATCH server-side ignores
                    // it (no column update for series_title — it's derived).
                    onPatch(item.id, {
                      series_id: seriesId,
                      part_number: seriesId ? partNumber : null,
                      series_title: seriesId ? (seriesTitle ?? null) : null,
                    });
                  }}
                  compact
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Pillar (content bucket)">
                  <input
                    defaultValue={item.pillar ?? ''}
                    placeholder="e.g. tutorials, reviews, deep-dive"
                    onBlur={e => {
                      const v = e.currentTarget.value.trim();
                      onPatch(item.id, { pillar: v || null });
                    }}
                    className="w-full px-3 py-2 rounded-md text-sm"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  />
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
              </div>

              <ChecklistSection
                items={(item.checklist ?? []) as ChecklistItem[]}
                onChange={next => onPatch(item.id, { checklist: next })}
              />

              <ThumbnailSlots
                item={item}
                onPatch={patch => onPatch(item.id, patch)}
              />

              <DependenciesSection
                itemId={item.id}
                allItems={allItems}
                onSelectItem={onSelectItem}
              />

              <Field label="Notes">
                <textarea
                  defaultValue={item.notes ?? ''}
                  rows={5}
                  onBlur={e => onPatch(item.id, { notes: e.currentTarget.value })}
                  className="w-full px-3 py-2 rounded-md text-sm resize-y"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                />
              </Field>

              <Field label="YouTube URL (after publishing)">
                <div className="flex gap-2">
                  <input
                    defaultValue={item.youtube_url ?? ''}
                    placeholder="https://www.youtube.com/watch?v=…"
                    onBlur={e => {
                      const v = e.currentTarget.value.trim() || null;
                      if (v !== (item.youtube_url ?? null)) onPatch(item.id, { youtube_url: v });
                    }}
                    className="flex-1 px-3 py-2 rounded-md text-sm"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  />
                  <button
                    onClick={async () => {
                      if (!item.youtube_url) { toast.error('Save a YouTube URL first'); return; }
                      toast.message('Pulling from YouTube…');
                      const res = await fetch(`/api/schedule/${item.id}/pull-youtube-metadata`, { method: 'POST' });
                      const data: {
                        error?: string;
                        applied?: { title: string; description: string; tags: string[] };
                        wrote?: { title: boolean; description: boolean; tags: boolean };
                      } = await res.json();
                      if (!res.ok) { toast.error(data.error || 'Pull failed'); return; }
                      // Server preserves user-curated fields; only sync what it
                      // actually wrote so the optimistic patch matches.
                      if (data.applied) {
                        onPatch(item.id, {
                          title: data.applied.title,
                          yt_description: data.applied.description,
                          yt_tags: data.applied.tags,
                        });
                      }
                      const wrote = data.wrote ?? { title: false, description: false, tags: false };
                      const writtenParts = [
                        wrote.title && 'title',
                        wrote.description && 'description',
                        wrote.tags && 'tags',
                      ].filter(Boolean);
                      if (writtenParts.length === 0) {
                        toast.message('Already up to date — your curated fields were preserved');
                      } else {
                        toast.success(`Pulled ${writtenParts.join(', ')} from YouTube`);
                      }
                    }}
                    disabled={!item.youtube_url}
                    className="text-xs px-3 py-2 rounded-md whitespace-nowrap"
                    style={{
                      background: item.youtube_url ? 'rgba(239,68,68,0.15)' : 'var(--bg-tertiary)',
                      color: item.youtube_url ? '#ef4444' : 'var(--text-muted)',
                      border: `1px solid ${item.youtube_url ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                      opacity: item.youtube_url ? 1 : 0.6,
                    }}>
                    Pull metadata
                  </button>
                </div>
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
      <PublishToYoutubeModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        defaultChannelId={(item.channels ?? [])[0]?.id}
        defaultTitle={item.title || ''}
        defaultDescription={item.yt_description || item.notes || ''}
        defaultTags={item.yt_tags ?? item.tags ?? []}
        defaultScheduleItemId={item.id}
        defaultProjectId={item.project_id ?? undefined}
      />
    </AnimatePresence>
  );
}

function SendToButton({ label, href, disabled, title }: { label: string; href: string; disabled?: boolean; title?: string }) {
  const body = (
    <span
      className="flex items-center gap-1 px-2 py-1 rounded shrink-0 whitespace-nowrap"
      style={{
        background: disabled ? 'var(--bg-tertiary)' : 'rgba(124,58,237,0.08)',
        color: disabled ? 'var(--text-muted)' : 'var(--accent-purple-bright)',
        border: `1px solid ${disabled ? 'var(--border)' : 'rgba(124,58,237,0.25)'}`,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {label}
    </span>
  );
  if (disabled) return <span title={title}>{body}</span>;
  return <Link href={href} title={title}>{body}</Link>;
}

/** Like SendToButton but invokes an async handler instead of navigating —
 *  used for "Start video review" / "Start narration review" which create
 *  resources before redirecting. */
function ActionButton({ label, onClick, disabled, title }: { label: string; onClick: () => void | Promise<void>; disabled?: boolean; title?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title={title}
      disabled={disabled || busy}
      onClick={async () => {
        if (busy || disabled) return;
        setBusy(true);
        try { await onClick(); } finally { setBusy(false); }
      }}
      className="flex items-center gap-1 px-2 py-1 rounded shrink-0 whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
      style={{
        background: disabled ? 'var(--bg-tertiary)' : 'rgba(124,58,237,0.08)',
        color: disabled ? 'var(--text-muted)' : 'var(--accent-purple-bright)',
        border: `1px solid ${disabled ? 'var(--border)' : 'rgba(124,58,237,0.25)'}`,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {busy ? '⏳ Starting…' : label}
    </button>
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
