'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

// Mirrors `DEFAULT_SCHEDULE_STATUSES` in `src/lib/db.ts` for the status
// pills in the scheduled-items picker. Inlined because db.ts pulls in
// server-only deps and a tiny color lookup doesn't earn its own module.
const SCHEDULE_STATUS_COLOR: Record<string, { label: string; color: string }> = {
  idea:         { label: 'Idea',         color: '#64748b' },
  scripting:    { label: 'Scripting',    color: '#8b5cf6' },
  recording:    { label: 'Recording',    color: '#f59e0b' },
  editing:      { label: 'Editing',      color: '#06b6d4' },
  ready:        { label: 'Ready',        color: '#10b981' },
  upload_queue: { label: 'Upload Queue', color: '#f97316' },
  published:    { label: 'Published',    color: '#3b82f6' },
};

interface PresetRow {
  id: string;
  name: string;
  niche: string | null;
  ideas_count_default: number;
  script_gate_enabled: boolean;
  qa_min_score: string;
  qa_max_iterations: number;
  narration_deadline_days: number;
  video_editor_collaborator_id: string | null;
  thumbnail_template_id: string | null;
}

interface IdeaRow {
  id: string;
  title: string;
  niche: string;
  hook: string | null;
  is_used: boolean;
}

interface ScheduleItemRow {
  id: string;
  title: string;
  status: string;
  scheduled_for: string | null;
  idea_id: string | null;
  notes: string | null;
  pillar: string | null;
  position: number;
  pipeline_run_video_id: string | null;
  // Set when the item is linked to a pipeline run — drives the
  // "In pipeline" chip's deep link to /pipeline/{runId}.
  pipeline_run_id: string | null;
}

type Mode = 'fresh' | 'existing' | 'scheduled' | 'continue';

interface ProjectRow {
  id: string;
  title: string;
  niche: string | null;
  script_id: string;
  script_word_count: number | null;
  script_updated_at: string;
}

export default function NewPipelinePage() {
  const router = useRouter();
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [ideas, setIdeas] = useState<IdeaRow[]>([]);
  const [scheduleItems, setScheduleItems] = useState<ScheduleItemRow[]>([]);
  const [presetId, setPresetId] = useState<string>('');
  const [mode, setMode] = useState<Mode>('fresh');
  const [count, setCount] = useState<number>(5);
  const [selectedIdeaIds, setSelectedIdeaIds] = useState<string[]>([]);
  const [selectedScheduleIds, setSelectedScheduleIds] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  // Picker search + filter state. Kept independent per mode so toggling
  // back-and-forth doesn't wipe what the user already typed/picked.
  const [ideaSearch, setIdeaSearch] = useState('');
  const [scheduleSearch, setScheduleSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  // Empty set = no filter (show all statuses). Storing the negative
  // (which statuses to *hide*) would be just as valid but harder to
  // read in the UI; we store which statuses are *kept* and treat
  // empty as "kept everything".
  const [scheduleStatusFilter, setScheduleStatusFilter] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preset quick-create form (inline, only shown when no presets exist).
  const [presetName, setPresetName] = useState('');
  const [presetNiche, setPresetNiche] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [presetsRes, ideasRes, scheduleRes, projectsRes] = await Promise.all([
          fetch('/api/auto-pipeline/presets', { cache: 'no-store' }),
          fetch('/api/ideas?saved=true&limit=100', { cache: 'no-store' }).catch(() => null),
          fetch('/api/schedule/picker', { cache: 'no-store' }).catch(() => null),
          fetch('/api/auto-pipeline/projects-picker', { cache: 'no-store' }).catch(() => null),
        ]);
        if (presetsRes.ok) {
          const data = await presetsRes.json();
          setPresets((data.presets as PresetRow[]) ?? []);
          if (data.presets?.[0]) setPresetId(data.presets[0].id);
        }
        let ideasCount = 0;
        let scheduleCount = 0;
        if (ideasRes && ideasRes.ok) {
          const data = await ideasRes.json();
          const rows = (data.ideas as IdeaRow[]) ?? [];
          const filtered = rows.filter((i) => !i.is_used);
          setIdeas(filtered);
          ideasCount = filtered.length;
        }
        if (scheduleRes && scheduleRes.ok) {
          const data = await scheduleRes.json();
          const rows = (data.items as ScheduleItemRow[]) ?? [];
          setScheduleItems(rows);
          scheduleCount = rows.length;
        }
        let projectsCount = 0;
        if (projectsRes && projectsRes.ok) {
          const data = await projectsRes.json();
          const rows = (data.projects as ProjectRow[]) ?? [];
          setProjects(rows);
          projectsCount = rows.length;
        }
        console.info('[pipeline batch] picker_loaded', {
          ideas: ideasCount,
          scheduled: scheduleCount,
          projects: projectsCount,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const selectedPreset = presets.find((p) => p.id === presetId);

  // Filtered ideas: case-insensitive substring match on title + hook.
  const filteredIdeas = useMemo(() => {
    const q = ideaSearch.trim().toLowerCase();
    if (!q) return ideas;
    return ideas.filter((i) => {
      return (
        i.title.toLowerCase().includes(q) ||
        (i.hook ?? '').toLowerCase().includes(q)
      );
    });
  }, [ideas, ideaSearch]);

  // Filtered projects: case-insensitive substring on title + niche.
  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      p.title.toLowerCase().includes(q) ||
      (p.niche ?? '').toLowerCase().includes(q),
    );
  }, [projects, projectSearch]);

  // Filtered scheduled items: combined search + status-filter chip.
  // Both filters intersect — the user gets back items that match the
  // search AND fall under the picked statuses (when any).
  const filteredScheduleItems = useMemo(() => {
    const q = scheduleSearch.trim().toLowerCase();
    return scheduleItems.filter((item) => {
      if (scheduleStatusFilter.size > 0 && !scheduleStatusFilter.has(item.status)) {
        return false;
      }
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        (item.notes ?? '').toLowerCase().includes(q) ||
        (item.pillar ?? '').toLowerCase().includes(q)
      );
    });
  }, [scheduleItems, scheduleSearch, scheduleStatusFilter]);

  // Status chips for the filter row. We surface only the statuses
  // present in the workspace's actual items (no point offering
  // "Published" if there are none), but we order them by the
  // canonical pipeline order from SCHEDULE_STATUS_COLOR.
  const availableStatuses = useMemo(() => {
    const present = new Set(scheduleItems.map((i) => i.status));
    const ordered = Object.keys(SCHEDULE_STATUS_COLOR).filter((s) => present.has(s));
    // Append any custom statuses the user defined that aren't in our
    // default color map — they still deserve a chip, just with the
    // fallback color.
    for (const s of present) {
      if (!ordered.includes(s)) ordered.push(s);
    }
    return ordered;
  }, [scheduleItems]);

  useEffect(() => {
    if (selectedPreset && selectedPreset.ideas_count_default) {
      setCount(selectedPreset.ideas_count_default);
    }
  }, [selectedPreset]);

  function toggleIdea(id: string) {
    setSelectedIdeaIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleScheduleItem(id: string) {
    setSelectedScheduleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleProject(id: string) {
    setSelectedProjectIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleStatusFilter(status: string) {
    setScheduleStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function changeMode(next: Mode) {
    if (next === mode) return;
    console.info('[pipeline batch] mode_changed', { from: mode, to: next });
    setMode(next);
  }

  async function submit() {
    setError(null);
    if (!presetId) {
      setError('Pick a preset first.');
      return;
    }
    if (mode === 'fresh' && (count < 1 || count > 50)) {
      setError('Count must be between 1 and 50.');
      return;
    }
    if (mode === 'existing' && selectedIdeaIds.length === 0) {
      setError('Pick at least one idea.');
      return;
    }
    if (mode === 'scheduled' && selectedScheduleIds.length === 0) {
      setError('Pick at least one scheduled item.');
      return;
    }
    if (mode === 'continue' && selectedProjectIds.length === 0) {
      setError('Pick at least one project to continue.');
      return;
    }

    setSubmitting(true);
    const countForLog =
      mode === 'fresh' ? count
      : mode === 'existing' ? selectedIdeaIds.length
      : mode === 'scheduled' ? selectedScheduleIds.length
      : selectedProjectIds.length;
    console.info('[pipeline batch] submit', { mode, count: countForLog, presetId });
    try {
      const body: Record<string, unknown> = { presetId };
      if (mode === 'fresh') body.countToGenerate = count;
      else if (mode === 'existing') body.existingIdeaIds = selectedIdeaIds;
      else if (mode === 'scheduled') body.existingScheduleItemIds = selectedScheduleIds;
      else body.existingProjectIds = selectedProjectIds;

      const res = await fetch('/api/auto-pipeline/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const { runId } = await res.json();
      router.push(`/pipeline/${runId}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to start batch';
      console.info('[pipeline batch] submit_error', { mode, message });
      setError(message);
      setSubmitting(false);
    }
  }

  async function createQuickPreset() {
    setError(null);
    if (!presetName.trim()) {
      setError('Preset name is required.');
      return;
    }
    try {
      const res = await fetch('/api/auto-pipeline/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: presetName.trim(),
          niche: presetNiche.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const { id } = await res.json();
      const listRes = await fetch('/api/auto-pipeline/presets', { cache: 'no-store' });
      if (listRes.ok) {
        const data = await listRes.json();
        setPresets((data.presets as PresetRow[]) ?? []);
        setPresetId(id);
      }
      setPresetName('');
      setPresetNiche('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create preset');
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-3xl text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <div className="mb-6">
        <Link
          href="/pipeline"
          className="text-sm hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          ← All batches
        </Link>
        <h1 className="text-2xl font-bold gradient-text mt-2">Start a batch</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Need to tune a preset?{' '}
          <Link href="/pipeline/presets" className="underline">
            Manage presets
          </Link>{' '}
          ·{' '}
          <Link href="/pipeline/thumbnail-templates" className="underline">
            Thumbnail templates
          </Link>
        </p>
      </div>

      {error && (
        <div
          className="mb-4 p-3 rounded text-sm"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
          {error}
        </div>
      )}

      {presets.length === 0 ? (
        <div className="glass rounded-xl p-6">
          <h2 className="text-sm font-semibold mb-2">Create your first preset</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            Presets bundle the rules and contexts every video in a batch uses — niche, script tone, QA score
            threshold, model choices, narrator deadline. You can refine them later from the same screen.
          </p>
          <div className="space-y-3">
            <Field label="Preset name">
              <input
                type="text"
                placeholder="e.g. 'Productivity 8-min explainers'"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                className="input-field"
              />
            </Field>
            <Field label="Niche (optional)">
              <input
                type="text"
                placeholder="e.g. productivity"
                value={presetNiche}
                onChange={(e) => setPresetNiche(e.target.value)}
                className="input-field"
              />
            </Field>
            <button onClick={createQuickPreset} className="btn-primary text-sm">
              Create preset
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <Section title="Preset">
            <select
              value={presetId}
              onChange={(e) => setPresetId(e.target.value)}
              className="input-field"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.niche ? `— ${p.niche}` : ''}
                </option>
              ))}
            </select>
            {selectedPreset && (
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                Script gate: {selectedPreset.script_gate_enabled ? 'on (you approve each script)' : 'off (fully unattended)'} ·
                QA threshold: {selectedPreset.qa_min_score}/100 ·
                Max retries: {selectedPreset.qa_max_iterations} ·
                Narration deadline: {selectedPreset.narration_deadline_days}d
              </p>
            )}
          </Section>

          <Section title="Mode">
            <div className="flex flex-col md:flex-row gap-3">
              <ModeCard
                active={mode === 'fresh'}
                onClick={() => changeMode('fresh')}
                title="Generate fresh ideas"
                subtitle="Brainstorm N new ideas, you drag-rank them once, the pipeline runs."
              />
              <ModeCard
                active={mode === 'existing'}
                onClick={() => changeMode('existing')}
                title="Use existing idea(s)"
                subtitle="Pick from your saved ideas. Skip idea-gen, go straight to script."
              />
              <ModeCard
                active={mode === 'scheduled'}
                onClick={() => changeMode('scheduled')}
                title="Use scheduled items"
                subtitle="Pull items straight from your Schedule. We bump them to Scripting and link the run."
              />
              <ModeCard
                active={mode === 'continue'}
                onClick={() => changeMode('continue')}
                title="Continue an existing video"
                subtitle="You already have a script + narration. Skip the writing & QA — the pipeline does production doc, thumbnail, editor handoff, and SEO."
              />
            </div>
          </Section>

          {mode === 'fresh' && (
            <Section title="How many ideas?">
              <input
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1)))}
                className="input-field"
                style={{ maxWidth: 140 }}
              />
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                {count} video{count !== 1 ? 's' : ''} will be created. After the ideas are generated,
                drag-rank them to set priority — the pipeline runs in that order.
              </p>
            </Section>
          )}

          {mode === 'existing' && (
            <Section title="Pick ideas">
              {ideas.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  No saved ideas in this workspace yet. Switch to fresh mode or save some ideas first from
                  the Ideas page.
                </p>
              ) : (
                <>
                  <SearchBox
                    placeholder={`Search ${ideas.length} idea${ideas.length === 1 ? '' : 's'}…`}
                    value={ideaSearch}
                    onChange={setIdeaSearch}
                  />
                  <p className="text-xs mb-2 mt-2" style={{ color: 'var(--text-muted)' }}>
                    Selected order = priority. {selectedIdeaIds.length} selected
                    {ideaSearch ? ` · ${filteredIdeas.length} of ${ideas.length} shown` : ''}.
                  </p>
                  <div
                    className="rounded-lg overflow-hidden"
                    style={{ border: '1px solid var(--border)', maxHeight: 384, overflowY: 'auto' }}
                  >
                    {filteredIdeas.length === 0 ? (
                      <p className="px-3 py-6 text-sm text-center" style={{ color: 'var(--text-muted)' }}>
                        No ideas match &ldquo;{ideaSearch}&rdquo;.
                      </p>
                    ) : (
                    <ul>
                      {filteredIdeas.map((idea, idx) => {
                        const selected = selectedIdeaIds.includes(idea.id);
                        const position = selected ? selectedIdeaIds.indexOf(idea.id) + 1 : null;
                        return (
                          <li
                            key={idea.id}
                            onClick={() => toggleIdea(idea.id)}
                            className="px-3 py-2 cursor-pointer text-sm flex items-start gap-3 transition-colors"
                            style={{
                              background: selected ? 'rgba(124,58,237,0.10)' : 'transparent',
                              borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                            }}
                          >
                            <div
                              className="w-6 shrink-0 text-xs font-mono pt-0.5"
                              style={{ color: selected ? 'var(--accent-purple-bright)' : 'var(--text-muted)' }}
                            >
                              {position ? `#${position}` : '·'}
                            </div>
                            <div className="flex-1">
                              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                {idea.title}
                              </div>
                              {idea.hook && (
                                <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                                  {idea.hook}
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    )}
                  </div>
                </>
              )}
            </Section>
          )}

          {mode === 'scheduled' && (
            <Section title="Pick scheduled items">
              {scheduleItems.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  No scheduled items in this workspace yet.{' '}
                  <Link href="/schedule" className="underline">
                    Open the Schedule
                  </Link>{' '}
                  to add some.
                </p>
              ) : (
                <>
                  <SearchBox
                    placeholder={`Search ${scheduleItems.length} scheduled item${scheduleItems.length === 1 ? '' : 's'}…`}
                    value={scheduleSearch}
                    onChange={setScheduleSearch}
                  />
                  {availableStatuses.length > 1 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {availableStatuses.map((s) => {
                        const meta = SCHEDULE_STATUS_COLOR[s] ?? { label: s, color: '#64748b' };
                        const active = scheduleStatusFilter.has(s);
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => toggleStatusFilter(s)}
                            className="text-[11px] uppercase tracking-wider px-2 py-1 rounded transition-colors"
                            style={{
                              background: active ? `${meta.color}33` : 'transparent',
                              color: active ? meta.color : 'var(--text-muted)',
                              border: `1px solid ${active ? meta.color : 'var(--border)'}`,
                            }}
                          >
                            {meta.label}
                          </button>
                        );
                      })}
                      {scheduleStatusFilter.size > 0 && (
                        <button
                          type="button"
                          onClick={() => setScheduleStatusFilter(new Set())}
                          className="text-[11px] uppercase tracking-wider px-2 py-1 rounded hover:underline"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  )}
                  <p className="text-xs mb-2 mt-2" style={{ color: 'var(--text-muted)' }}>
                    Selected order = priority. {selectedScheduleIds.length} selected
                    {scheduleSearch || scheduleStatusFilter.size > 0
                      ? ` · ${filteredScheduleItems.length} of ${scheduleItems.length} shown`
                      : ''}
                    . Items in <em>Idea</em> status get auto-bumped to <em>Scripting</em>; later statuses
                    are left as-is.
                  </p>
                  <div
                    className="rounded-lg overflow-hidden"
                    style={{ border: '1px solid var(--border)', maxHeight: 384, overflowY: 'auto' }}
                  >
                    {filteredScheduleItems.length === 0 ? (
                      <p className="px-3 py-6 text-sm text-center" style={{ color: 'var(--text-muted)' }}>
                        No scheduled items match the current filters.
                      </p>
                    ) : (
                    <ul>
                      {filteredScheduleItems.map((item, idx) => {
                        const selected = selectedScheduleIds.includes(item.id);
                        const position = selected ? selectedScheduleIds.indexOf(item.id) + 1 : null;
                        const statusMeta = SCHEDULE_STATUS_COLOR[item.status] ?? {
                          label: item.status,
                          color: '#64748b',
                        };
                        const alreadyInPipeline = item.pipeline_run_video_id != null;
                        const scheduledDate = item.scheduled_for
                          ? new Date(item.scheduled_for).toLocaleDateString()
                          : null;
                        return (
                          <li
                            key={item.id}
                            onClick={() => toggleScheduleItem(item.id)}
                            className="px-3 py-2 cursor-pointer text-sm flex items-start gap-3 transition-colors"
                            style={{
                              background: selected ? 'rgba(124,58,237,0.10)' : 'transparent',
                              borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                            }}
                          >
                            <div
                              className="w-6 shrink-0 text-xs font-mono pt-0.5"
                              style={{ color: selected ? 'var(--accent-purple-bright)' : 'var(--text-muted)' }}
                            >
                              {position ? `#${position}` : '·'}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                  {item.title || 'Untitled scheduled item'}
                                </span>
                                <span
                                  className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                                  style={{
                                    background: `${statusMeta.color}22`,
                                    color: statusMeta.color,
                                    border: `1px solid ${statusMeta.color}55`,
                                  }}
                                >
                                  {statusMeta.label}
                                </span>
                                {item.pillar && (
                                  <span
                                    className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                                    style={{
                                      background: 'rgba(148,163,184,0.10)',
                                      color: 'var(--text-muted)',
                                      border: '1px solid var(--border)',
                                    }}
                                  >
                                    {item.pillar}
                                  </span>
                                )}
                                {alreadyInPipeline && (
                                  item.pipeline_run_id ? (
                                    <Link
                                      href={`/pipeline/${item.pipeline_run_id}`}
                                      onClick={e => {
                                        // Don't also toggle the row's selection — the chip
                                        // is a navigation control, the row is a selection
                                        // control. Two clear affordances on one row.
                                        e.stopPropagation();
                                      }}
                                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded inline-flex items-center gap-1 hover:underline transition-colors"
                                      style={{
                                        background: 'rgba(239,68,68,0.10)',
                                        color: '#f87171',
                                        border: '1px solid rgba(239,68,68,0.35)',
                                      }}
                                      title="Open the pipeline run for this item — retry, stop, or inspect stages."
                                    >
                                      In pipeline
                                      <span aria-hidden style={{ marginLeft: 1 }}>→</span>
                                    </Link>
                                  ) : (
                                    <span
                                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(239,68,68,0.10)',
                                        color: '#f87171',
                                        border: '1px solid rgba(239,68,68,0.35)',
                                      }}
                                      title="Linked to a pipeline video but the run record is missing (likely a run that was deleted)."
                                    >
                                      In pipeline
                                    </span>
                                  )
                                )}
                                {scheduledDate && (
                                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    · {scheduledDate}
                                  </span>
                                )}
                              </div>
                              {item.notes && (
                                <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                                  {item.notes}
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    )}
                  </div>
                </>
              )}
            </Section>
          )}

          {mode === 'continue' && (
            <Section title="Pick projects to continue">
              {projects.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  No workspace projects with a saved script yet. Write + save a script in the{' '}
                  <Link href="/generator" className="underline">
                    Script Generator
                  </Link>{' '}
                  first, then come back here.
                </p>
              ) : (
                <>
                  <SearchBox
                    placeholder={`Search ${projects.length} project${projects.length === 1 ? '' : 's'}…`}
                    value={projectSearch}
                    onChange={setProjectSearch}
                  />
                  <p className="text-xs mb-2 mt-2" style={{ color: 'var(--text-muted)' }}>
                    Selected order = priority. {selectedProjectIds.length} selected
                    {projectSearch ? ` · ${filteredProjects.length} of ${projects.length} shown` : ''}.
                    Each pipeline run starts at <em>narration_complete</em> — make sure narration is
                    actually done before starting, or the editor handoff will get an empty audio packet.
                  </p>
                  <div
                    className="rounded-lg overflow-hidden"
                    style={{ border: '1px solid var(--border)', maxHeight: 384, overflowY: 'auto' }}
                  >
                    {filteredProjects.length === 0 ? (
                      <p className="px-3 py-6 text-sm text-center" style={{ color: 'var(--text-muted)' }}>
                        No projects match &ldquo;{projectSearch}&rdquo;.
                      </p>
                    ) : (
                      <ul>
                        {filteredProjects.map((project, idx) => {
                          const selected = selectedProjectIds.includes(project.id);
                          const position = selected ? selectedProjectIds.indexOf(project.id) + 1 : null;
                          const updated = project.script_updated_at
                            ? new Date(project.script_updated_at).toLocaleDateString()
                            : null;
                          return (
                            <li
                              key={project.id}
                              onClick={() => toggleProject(project.id)}
                              className="px-3 py-2 cursor-pointer text-sm flex items-start gap-3 transition-colors"
                              style={{
                                background: selected ? 'rgba(124,58,237,0.10)' : 'transparent',
                                borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                              }}
                            >
                              <div
                                className="w-6 shrink-0 text-xs font-mono pt-0.5"
                                style={{ color: selected ? 'var(--accent-purple-bright)' : 'var(--text-muted)' }}
                              >
                                {position ? `#${position}` : '·'}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                    {project.title || 'Untitled project'}
                                  </span>
                                  {project.niche && (
                                    <span
                                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(148,163,184,0.10)',
                                        color: 'var(--text-muted)',
                                        border: '1px solid var(--border)',
                                      }}
                                    >
                                      {project.niche}
                                    </span>
                                  )}
                                  {project.script_word_count != null && (
                                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                      {project.script_word_count} words
                                    </span>
                                  )}
                                  {updated && (
                                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                      · {updated}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </Section>
          )}

          <div className="flex justify-end">
            <button
              onClick={submit}
              disabled={submitting}
              className="btn-primary text-sm"
            >
              {submitting ? 'Starting…' : 'Start batch'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 px-4 py-3 rounded-lg text-left text-sm transition-all"
      style={{
        background: active ? 'rgba(124,58,237,0.10)' : 'var(--bg-card)',
        border: `1px solid ${active ? 'var(--accent-purple-bright)' : 'var(--border)'}`,
        boxShadow: active ? '0 0 0 3px rgba(124,58,237,0.15)' : 'none',
      }}
    >
      <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>
      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{subtitle}</div>
    </button>
  );
}

function SearchBox({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input-field pl-8"
        autoComplete="off"
      />
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
        style={{ color: 'var(--text-muted)' }}
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}
