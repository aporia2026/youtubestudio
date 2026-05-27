'use client';

/**
 * New video dialog — the Command Center's `+ New video` button.
 *
 * Two top-level tabs:
 *
 *   Create        — start a new video.
 *     Blank        — title + channel + optional publish date (default).
 *     From idea    — pick a saved idea; prefills title from the idea.
 *     From schedule — pick a Schedule item; jumps straight into the
 *                    generator's schedule-linked flow (no new project
 *                    created — the existing scheduleItemId path handles
 *                    the project link write-back).
 *
 *   Open existing — pick anything that already exists and jump to it.
 *     One search box, four grouped lists (Projects, Schedule, Ideas,
 *     Drafts). Picking a Project routes to its current-stage tool path
 *     via `getStageDef`; picking a Schedule item or Idea jumps into the
 *     generator with the appropriate context; picking a Draft opens the
 *     generator (drafts are localStorage-keyed in the existing UI).
 *
 * Workspace scoping: every list call is an authed endpoint
 * (`/api/command-center/cards`, `/api/schedule/picker`, `/api/ideas`,
 * `/api/drafts`); the dialog only ever sees the caller's workspace.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { getStageDef, isVideoStageId, type VideoStageId } from '@/lib/video-stages';

// Status → chip color lookup for Schedule items. Mirrors the same map
// in `/pipeline/new` and in the Schedule kanban — kept inlined because
// the underlying status vocabulary lives in db.ts (server-only).
const SCHEDULE_STATUS_COLOR: Record<string, string> = {
  idea: '#64748b',
  scripting: '#8b5cf6',
  recording: '#f59e0b',
  editing: '#06b6d4',
  ready: '#10b981',
  upload_queue: '#f97316',
  published: '#3b82f6',
};

// Stage → chip color lookup for Project rows in Open Existing. Keyed by
// VideoStageId; falls back to brand purple if a new stage shows up.
const STAGE_BADGE_COLOR: Record<string, string> = {
  idea: '#64748b',
  script: '#8b5cf6',
  qa: '#06b6d4',
  voiceover: '#f59e0b',
  production_doc: '#a78bfa',
  thumbnail: '#ec4899',
  edit: '#22d3ee',
  seo: '#10b981',
  scheduled: '#3b82f6',
  published: '#22c55e',
};

interface ChannelOption {
  id: string;
  name: string;
  account_color: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  channels: ChannelOption[];
  onCreated?: (videoId: string) => void;
}

type TopTab = 'create' | 'open';
type CreateMode = 'blank' | 'idea' | 'schedule';

interface IdeaRow {
  id: string;
  title: string;
  niche: string | null;
  hook: string | null;
}

interface ScheduleRow {
  id: string;
  title: string;
  status: string;
  scheduled_for: string | null;
  notes: string | null;
}

interface ProjectRow {
  id: string;
  title: string;
  niche: string;
  current_stage: string;
  current_stage_label: string;
  channel: { id: string; name: string; account_color: string | null } | null;
}

interface DraftRow {
  id: string;
  title: string;
  niche: string | null;
  step: string | null;
  updatedAt: number;
}

export function NewVideoDialog({ open, onClose, channels, onCreated }: Props) {
  const router = useRouter();
  const [topTab, setTopTab] = useState<TopTab>('create');
  const [createMode, setCreateMode] = useState<CreateMode>('blank');

  // Blank-mode form state.
  const [title, setTitle] = useState('');
  const [channelId, setChannelId] = useState<string>(channels[0]?.id ?? '');
  const [scheduledFor, setScheduledFor] = useState<string>(defaultScheduledFor());
  const [submitting, setSubmitting] = useState(false);

  // Open-existing search.
  const [search, setSearch] = useState('');

  // Source lists (lazy-loaded when their tab opens).
  const [ideas, setIdeas] = useState<IdeaRow[] | null>(null);
  const [scheduleItems, setScheduleItems] = useState<ScheduleRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingDrafts, setLoadingDrafts] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset + focus when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTopTab('create');
    setCreateMode('blank');
    setTitle('');
    setChannelId(channels[0]?.id ?? '');
    setScheduledFor(defaultScheduledFor());
    setSearch('');
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }, [open, channels]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  // Refocus search when switching to Open Existing.
  useEffect(() => {
    if (!open) return;
    if (topTab === 'open') {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    } else if (createMode === 'blank') {
      setTimeout(() => titleInputRef.current?.focus(), 0);
    }
  }, [open, topTab, createMode]);

  // Lazy-load each source list the first time its surface becomes visible.
  // Skips when already loaded; cheap if the user only ever uses Blank.
  useEffect(() => {
    if (!open) return;
    const needIdeas = (topTab === 'create' && createMode === 'idea') || topTab === 'open';
    const needSchedule = (topTab === 'create' && createMode === 'schedule') || topTab === 'open';
    const needProjects = topTab === 'open';
    const needDrafts = topTab === 'open';
    if (needIdeas && ideas === null && !loadingIdeas) {
      setLoadingIdeas(true);
      fetch('/api/ideas?limit=100', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : { ideas: [] })
        .then(d => setIdeas((d.ideas as IdeaRow[]) ?? []))
        .catch(() => setIdeas([]))
        .finally(() => setLoadingIdeas(false));
    }
    if (needSchedule && scheduleItems === null && !loadingSchedule) {
      setLoadingSchedule(true);
      fetch('/api/schedule/picker', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : { items: [] })
        .then(d => setScheduleItems((d.items as ScheduleRow[]) ?? []))
        .catch(() => setScheduleItems([]))
        .finally(() => setLoadingSchedule(false));
    }
    if (needProjects && projects === null && !loadingProjects) {
      setLoadingProjects(true);
      fetch('/api/command-center/cards', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : { cards: [] })
        .then(d => setProjects((d.cards as ProjectRow[]) ?? []))
        .catch(() => setProjects([]))
        .finally(() => setLoadingProjects(false));
    }
    if (needDrafts && drafts === null && !loadingDrafts) {
      setLoadingDrafts(true);
      fetch('/api/drafts', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : { drafts: [] })
        .then(d => setDrafts((d.drafts as DraftRow[]) ?? []))
        .catch(() => setDrafts([]))
        .finally(() => setLoadingDrafts(false));
    }
  }, [open, topTab, createMode, ideas, scheduleItems, projects, drafts, loadingIdeas, loadingSchedule, loadingProjects, loadingDrafts]);

  if (!open) return null;

  // Blank-form Create flow: pulls channel + scheduledFor from the form's
  // state. Idea-pick is a separate path because the user hasn't been
  // shown those fields and shouldn't be opted into a defaulted channel +
  // publish date silently.
  async function createBlank() {
    if (!title.trim()) {
      toast.error('Title is required');
      return;
    }
    await postCreate({
      mode: 'blank',
      title: title.trim(),
      channelId: channelId || null,
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
    });
  }

  async function postCreate(args: {
    mode: 'blank' | 'from-idea';
    title: string;
    channelId: string | null;
    scheduledFor: string | null;
  }) {
    setSubmitting(true);
    console.info('[command-center new-video] submit', {
      mode: args.mode,
      has_channel: !!args.channelId,
      has_schedule: !!args.scheduledFor,
    });
    try {
      const res = await fetch('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: args.title,
          channelId: args.channelId,
          scheduledFor: args.scheduledFor,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((json as { error?: string }).error ?? 'Failed to create video');
        return;
      }
      const newVideoId = (json as { videoId: string }).videoId;
      toast.success('Video created');
      onCreated?.(newVideoId);
      router.push(`/generator?videoId=${encodeURIComponent(newVideoId)}`);
      onClose();
    } catch (err) {
      console.error('[command-center new-video] error', err);
      toast.error('Failed to create video');
    } finally {
      setSubmitting(false);
    }
  }

  function pickIdea(idea: IdeaRow) {
    console.info('[command-center new-video] pick idea', { ideaId: idea.id });
    // No defaulted channel / publish date — those are only set when the
    // user explicitly fills them in the Blank form. The user can assign
    // channel + slot from the kanban once the project lands.
    void postCreate({
      mode: 'from-idea',
      title: idea.title,
      channelId: null,
      scheduledFor: null,
    });
  }

  function pickScheduleItem(item: ScheduleRow) {
    console.info('[command-center new-video] pick schedule', { itemId: item.id });
    // The generator's existing schedule-link flow takes over from here:
    // it fetches the item, prefills the script context, and on save it
    // writes back via writeBackToSchedule. Far cleaner than creating a
    // parallel project record — keeps the schedule item as the source
    // of truth for that video's identity.
    router.push(`/generator?scheduleItemId=${encodeURIComponent(item.id)}`);
    onClose();
  }

  function openProject(project: ProjectRow) {
    const stage: VideoStageId = isVideoStageId(project.current_stage) ? project.current_stage : 'script';
    const toolPath = getStageDef(stage).toolPath;
    console.info('[command-center new-video] open project', { projectId: project.id, stage });
    router.push(`${toolPath}?videoId=${encodeURIComponent(project.id)}`);
    onClose();
  }

  function openDraft(_draft: DraftRow) {
    // Drafts are localStorage-keyed in the generator's existing UI; the
    // generator's History & Drafts panel lets the user pick one. Jumping
    // to /generator surfaces that panel — a more invasive flow would
    // need a generator-side URL param to auto-activate the draft, which
    // is intentionally out of scope for this round.
    console.info('[command-center new-video] open draft', { draftId: _draft.id });
    router.push('/generator');
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={e => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Start or open a video"
    >
      <div
        className="w-full max-w-2xl rounded-lg flex flex-col"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', maxHeight: '85vh' }}
      >
        <header className="px-5 pt-4 pb-0">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {topTab === 'create' ? 'New video' : 'Open existing'}
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              aria-label="Close"
              className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-50"
              style={{ color: 'var(--text-muted)' }}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            {topTab === 'create'
              ? 'Start fresh, or pull from a saved idea or scheduled slot.'
              : 'Search across projects, scheduled items, ideas, and drafts.'}
          </p>

          {/* Top tabs */}
          <div className="mt-3 flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
            <TopTabBtn label="Create" active={topTab === 'create'} onClick={() => setTopTab('create')} />
            <TopTabBtn label="Open existing" active={topTab === 'open'} onClick={() => setTopTab('open')} />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {topTab === 'create' ? (
            <>
              {/* Sub-tabs */}
              <div className="flex gap-1.5 mb-4 flex-wrap">
                <SubTabBtn label="Blank" active={createMode === 'blank'} onClick={() => setCreateMode('blank')} />
                <SubTabBtn label="From idea" active={createMode === 'idea'} onClick={() => setCreateMode('idea')} />
                <SubTabBtn label="From schedule item" active={createMode === 'schedule'} onClick={() => setCreateMode('schedule')} />
              </div>

              {createMode === 'blank' && (
                <BlankForm
                  title={title}
                  setTitle={setTitle}
                  channels={channels}
                  channelId={channelId}
                  setChannelId={setChannelId}
                  scheduledFor={scheduledFor}
                  setScheduledFor={setScheduledFor}
                  submitting={submitting}
                  titleInputRef={titleInputRef}
                  onSubmit={() => void createBlank()}
                  onCancel={onClose}
                />
              )}

              {createMode === 'idea' && (
                <SourcePickerList
                  loading={loadingIdeas}
                  emptyHint="No saved ideas yet. Open the Ideas page to add some."
                  emptyHref="/ideas"
                  items={(ideas ?? []).map(i => ({
                    key: i.id,
                    primary: i.title,
                    secondary: [i.niche, i.hook].filter(Boolean).join(' · ') || null,
                    badge: 'IDEA',
                    badgeColor: '#64748b',
                    onPick: () => pickIdea(i),
                  }))}
                />
              )}

              {createMode === 'schedule' && (
                <SourcePickerList
                  loading={loadingSchedule}
                  emptyHint="No scheduled items yet. Add some from the Schedule page."
                  emptyHref="/schedule"
                  items={(scheduleItems ?? []).map(it => ({
                    key: it.id,
                    primary: it.title || 'Untitled scheduled item',
                    secondary: it.notes ?? null,
                    badge: (it.status || 'idea').toUpperCase(),
                    badgeColor: SCHEDULE_STATUS_COLOR[it.status] ?? '#64748b',
                    extra: it.scheduled_for ? new Date(it.scheduled_for).toLocaleDateString() : null,
                    onPick: () => pickScheduleItem(it),
                  }))}
                />
              )}
            </>
          ) : (
            <OpenExistingTab
              search={search}
              setSearch={setSearch}
              searchInputRef={searchInputRef}
              projects={projects}
              schedule={scheduleItems}
              ideas={ideas}
              drafts={drafts}
              loading={loadingProjects || loadingSchedule || loadingIdeas || loadingDrafts}
              onPickProject={openProject}
              onPickSchedule={pickScheduleItem}
              onPickIdea={pickIdea}
              onPickDraft={openDraft}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab buttons
// ---------------------------------------------------------------------------

function TopTabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm px-3 py-2 -mb-px border-b-2 font-medium transition-colors"
      style={{
        borderColor: active ? 'var(--accent-purple-bright)' : 'transparent',
        color: active ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
      }}
    >
      {label}
    </button>
  );
}

function SubTabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs px-2.5 py-1 rounded transition-colors"
      style={{
        background: active ? 'rgba(124,58,237,0.15)' : 'transparent',
        color: active ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
        border: `1px solid ${active ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Blank form — the original New Video flow, preserved unchanged.
// ---------------------------------------------------------------------------

function BlankForm({
  title,
  setTitle,
  channels,
  channelId,
  setChannelId,
  scheduledFor,
  setScheduledFor,
  submitting,
  titleInputRef,
  onSubmit,
  onCancel,
}: {
  title: string;
  setTitle: (v: string) => void;
  channels: ChannelOption[];
  channelId: string;
  setChannelId: (v: string) => void;
  scheduledFor: string;
  setScheduledFor: (v: string) => void;
  submitting: boolean;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-3"
    >
      <label className="block">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Title</span>
        <input
          ref={titleInputRef}
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={300}
          placeholder="What is this video about?"
          required
          className="mt-1 w-full px-3 py-2 rounded text-sm"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        />
      </label>

      {channels.length > 0 && (
        <label className="block">
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Channel</span>
          <select
            value={channelId}
            onChange={e => setChannelId(e.target.value)}
            className="mt-1 w-full px-3 py-2 rounded text-sm"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          >
            <option value="">No channel — assign later</option>
            {channels.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      )}

      <label className="block">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Publish date (optional)</span>
        <input
          type="date"
          value={scheduledFor}
          onChange={e => setScheduledFor(e.target.value)}
          className="mt-1 w-full px-3 py-2 rounded text-sm"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        />
        <span className="text-[11px] mt-1 inline-block" style={{ color: 'var(--text-muted)' }}>
          Sets the schedule slot. You can move or remove it from the Schedule later.
        </span>
      </label>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="text-sm px-3 py-1.5 rounded font-medium disabled:opacity-60"
          style={{ background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !title.trim()}
          className="text-sm px-3 py-1.5 rounded font-medium disabled:opacity-60"
          style={{ background: 'var(--accent-purple)', color: 'white' }}
        >
          {submitting ? 'Creating…' : 'Create + open script'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Generic source picker — used for ideas and schedule items.
// ---------------------------------------------------------------------------

interface PickerItem {
  key: string;
  primary: string;
  secondary?: string | null;
  badge?: string;
  badgeColor?: string;
  extra?: string | null;
  onPick: () => void;
}

function SourcePickerList({
  items,
  loading,
  emptyHint,
  emptyHref,
}: {
  items: PickerItem[];
  loading: boolean;
  emptyHint: string;
  emptyHref?: string;
}) {
  if (loading) {
    return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>;
  }
  if (items.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {emptyHint}
        {emptyHref && (
          <>
            {' '}
            <a href={emptyHref} className="underline" style={{ color: 'var(--accent-purple-bright)' }}>
              Open
            </a>
            .
          </>
        )}
      </p>
    );
  }
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--border)', maxHeight: 384, overflowY: 'auto' }}
    >
      <ul>
        {items.map((it, idx) => (
          <li
            key={it.key}
            onClick={it.onPick}
            className="px-3 py-2.5 cursor-pointer text-sm transition-colors hover:opacity-90"
            style={{
              borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
              background: 'transparent',
            }}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                {it.primary}
              </span>
              {it.badge && (
                <span
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                  style={{
                    background: `${it.badgeColor ?? '#64748b'}22`,
                    color: it.badgeColor ?? '#64748b',
                    border: `1px solid ${it.badgeColor ?? '#64748b'}55`,
                  }}
                >
                  {it.badge}
                </span>
              )}
              {it.extra && (
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>· {it.extra}</span>
              )}
            </div>
            {it.secondary && (
              <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                {it.secondary}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open Existing tab — unified search across projects + schedule + ideas + drafts.
// ---------------------------------------------------------------------------

function OpenExistingTab({
  search,
  setSearch,
  searchInputRef,
  projects,
  schedule,
  ideas,
  drafts,
  loading,
  onPickProject,
  onPickSchedule,
  onPickIdea,
  onPickDraft,
}: {
  search: string;
  setSearch: (v: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  projects: ProjectRow[] | null;
  schedule: ScheduleRow[] | null;
  ideas: IdeaRow[] | null;
  drafts: DraftRow[] | null;
  loading: boolean;
  onPickProject: (p: ProjectRow) => void;
  onPickSchedule: (s: ScheduleRow) => void;
  onPickIdea: (i: IdeaRow) => void;
  onPickDraft: (d: DraftRow) => void;
}) {
  const q = search.trim().toLowerCase();

  // Filters are inlined (not factored into a shared closure) so each
  // useMemo's dependency list is statically inferable — the React
  // Compiler refuses to memoize when a closed-over helper changes every
  // render. A tiny duplication beats a deopt.
  const filteredProjects = useMemo(
    () =>
      (projects ?? []).filter(p =>
        !q
          ? true
          : (p.title ?? '').toLowerCase().includes(q) ||
            (p.niche ?? '').toLowerCase().includes(q),
      ),
    [projects, q],
  );
  const filteredSchedule = useMemo(
    () =>
      (schedule ?? []).filter(s =>
        !q
          ? true
          : (s.title ?? '').toLowerCase().includes(q) ||
            (s.notes ?? '').toLowerCase().includes(q),
      ),
    [schedule, q],
  );
  const filteredIdeas = useMemo(
    () =>
      (ideas ?? []).filter(i =>
        !q
          ? true
          : (i.title ?? '').toLowerCase().includes(q) ||
            (i.niche ?? '').toLowerCase().includes(q) ||
            (i.hook ?? '').toLowerCase().includes(q),
      ),
    [ideas, q],
  );
  const filteredDrafts = useMemo(
    () =>
      (drafts ?? []).filter(d =>
        !q
          ? true
          : (d.title ?? '').toLowerCase().includes(q) ||
            (d.niche ?? '').toLowerCase().includes(q),
      ),
    [drafts, q],
  );

  const total =
    filteredProjects.length + filteredSchedule.length + filteredIdeas.length + filteredDrafts.length;

  return (
    <div className="space-y-3">
      <input
        ref={searchInputRef}
        type="search"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search projects, schedule, ideas, drafts…"
        className="w-full px-3 py-2 rounded text-sm"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
      />

      {loading && total === 0 && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>
      )}

      {!loading && total === 0 && (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {q ? `Nothing matches “${search}”.` : 'No existing items found in this workspace.'}
        </p>
      )}

      <ResultGroup
        title="Projects"
        href="/projects"
        items={filteredProjects.map(p => ({
          key: p.id,
          primary: p.title,
          secondary: p.niche || null,
          badge: p.current_stage_label || p.current_stage,
          badgeColor: STAGE_BADGE_COLOR[p.current_stage] ?? '#a78bfa',
          extra: p.channel?.name ?? null,
          onPick: () => onPickProject(p),
        }))}
      />
      <ResultGroup
        title="Schedule"
        href="/schedule"
        items={filteredSchedule.map(s => ({
          key: s.id,
          primary: s.title || 'Untitled scheduled item',
          secondary: s.notes ?? null,
          badge: (s.status || 'idea').toUpperCase(),
          badgeColor: SCHEDULE_STATUS_COLOR[s.status] ?? '#64748b',
          extra: s.scheduled_for ? new Date(s.scheduled_for).toLocaleDateString() : null,
          onPick: () => onPickSchedule(s),
        }))}
      />
      <ResultGroup
        title="Ideas"
        href="/ideas"
        items={filteredIdeas.map(i => ({
          key: i.id,
          primary: i.title,
          secondary: [i.niche, i.hook].filter(Boolean).join(' · ') || null,
          badge: 'IDEA',
          badgeColor: '#64748b',
          onPick: () => onPickIdea(i),
        }))}
      />
      <ResultGroup
        title="Drafts"
        href="/generator"
        items={filteredDrafts.map(d => ({
          key: d.id,
          primary: d.title || 'Untitled draft',
          secondary: d.niche || null,
          badge: (d.step || 'draft').toUpperCase(),
          badgeColor: '#8b5cf6',
          extra: new Date(d.updatedAt).toLocaleDateString(),
          onPick: () => onPickDraft(d),
        }))}
      />
    </div>
  );
}

function ResultGroup({
  title,
  items,
  href,
}: {
  title: string;
  items: PickerItem[];
  href: string;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="flex items-baseline justify-between mb-1.5">
        <h3 className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-muted)' }}>
          {title}
          <span className="ml-1.5 font-normal" style={{ color: 'var(--text-muted)' }}>({items.length})</span>
        </h3>
        <a href={href} className="text-xs hover:underline" style={{ color: 'var(--text-muted)' }}>
          See all →
        </a>
      </div>
      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <ul>
          {items.slice(0, 8).map((it, idx) => (
            <li
              key={it.key}
              onClick={it.onPick}
              className="px-3 py-2 cursor-pointer text-sm transition-colors"
              style={{
                borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                background: 'transparent',
              }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {it.primary}
                </span>
                {it.badge && (
                  <span
                    className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={{
                      background: `${it.badgeColor ?? '#64748b'}22`,
                      color: it.badgeColor ?? '#64748b',
                      border: `1px solid ${it.badgeColor ?? '#64748b'}55`,
                    }}
                  >
                    {it.badge}
                  </span>
                )}
                {it.extra && (
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>· {it.extra}</span>
                )}
              </div>
              {it.secondary && (
                <div className="text-xs mt-0.5 line-clamp-1" style={{ color: 'var(--text-muted)' }}>
                  {it.secondary}
                </div>
              )}
            </li>
          ))}
        </ul>
        {items.length > 8 && (
          <div
            className="px-3 py-1.5 text-[11px] text-center"
            style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
          >
            + {items.length - 8} more — refine your search to narrow this down.
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default to one week from today, formatted YYYY-MM-DD for the date input. */
function defaultScheduledFor(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
