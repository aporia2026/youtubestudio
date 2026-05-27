'use client';

/**
 * Command Center — client component.
 *
 * Top bar: channel multi-select, week selector, stage filter, search.
 * Left rail: per-channel-week summary cards.
 * Main: kanban with columns = STAGE_CHAIN stages, cards = videos.
 * Footer: stuck videos panel (cards with no transition in 48h).
 *
 * Drag-to-advance is wired to /api/videos/[id]/advance (the seam from
 * Wave 1). Auto-managed cards refuse the drag and toast the gate reason.
 *
 * Observability per standing rule 14: every state change and every
 * drag attempt logs to console with `[command-center *]` prefixes.
 */

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from '@dnd-kit/core';
import { STAGE_CHAIN, getStageDef, type VideoStageId } from '@/lib/video-stages';
import {
  filterCardsByWeek,
  summarizeByChannel,
  type CommandCenterCard,
  type IsoWeek,
  type PerChannelWeekSummary,
} from '@/lib/command-center';
import { NewVideoDialog } from './NewVideoDialog';
import { usePresenceSnapshot } from '@/components/video-context/use-presence';

// Sentinel key for the "No channel" virtual chip. Unchanneled cards
// (channel: null) used to leak past the filter because the old check
// short-circuited on card.channel?.id; making the sentinel explicit
// lets the user include or exclude them like any other channel.
const NO_CHANNEL_KEY = '__no_channel__';

interface ChannelOption {
  id: string;
  name: string;
  account_color: string | null;
}

interface Props {
  initialCards: CommandCenterCard[];
  /** True when the workspace has more non-archived projects than the
   *  loader returned. Renders a "Showing X of Y" hint in the footer. */
  truncated: boolean;
  /** Total non-archived projects in the workspace. */
  totalProjects: number;
  channels: ChannelOption[];
  initialWeek: IsoWeek;
  /** Hours since last stage change before a video shows in the Stuck
   *  panel. Comes from the workspace's QA settings (default 48h). */
  stuckThresholdHours: number;
  /** Soft per-stage WIP limit. Stages not in the map are unlimited. */
  wipLimits: Record<string, number>;
}

export function CommandCenterClient({ initialCards, truncated, totalProjects, channels, initialWeek, stuckThresholdHours, wipLimits }: Props) {
  const router = useRouter();
  const [cards, setCards] = useState<CommandCenterCard[]>(initialCards);
  // Default = every chip selected (incl. the No-channel sentinel), which
  // reads as "no filter — show everything." A partial set means the user
  // has narrowed the view; an empty set is disallowed (we reset to all
  // rather than show a blank kanban).
  const [channelFilter, setChannelFilter] = useState<Set<string>>(
    () => new Set<string>([...channels.map(c => c.id), NO_CHANNEL_KEY]),
  );
  const [stageFilter, setStageFilter] = useState<VideoStageId | 'all'>('all');
  const [search, setSearch] = useState('');
  const [weekOffset, setWeekOffset] = useState(0);
  const [newVideoOpen, setNewVideoOpen] = useState(false);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  // Workspace-wide presence snapshot, polled every 20s. The kanban
  // doesn't heartbeat itself (no one is "open" on the kanban — it's a
  // viewer). Cards render a tiny presence dot when teammates have the
  // video open.
  const presenceSnapshot = usePresenceSnapshot();

  // Keep local state in sync with server snapshots. router.refresh()
  // after a successful advance reruns the server page and pushes a new
  // initialCards prop; this effect reconciles the optimistic local copy
  // with the server's confirmed view.
  useEffect(() => {
    setCards(initialCards);
  }, [initialCards]);

  // Real-time polling: every 30s, fetch a fresh cards snapshot so
  // changes from the cron, narrator/editor portals, or other teammates
  // appear without the user reloading. Skipped while a drag is
  // in-flight so we don't clobber the optimistic state.
  useEffect(() => {
    let cancelled = false;
    const POLL_MS = 30_000;
    async function pull() {
      if (draggingCardId !== null) return; // don't fight an in-flight drag
      try {
        const res = await fetch('/api/command-center/cards');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data?.cards)) {
          setCards(data.cards);
        }
      } catch {
        // silent — polling is best-effort
      }
    }
    const timer = setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [draggingCardId]);

  const week = useMemo(() => shiftIsoWeek(initialWeek, weekOffset), [initialWeek, weekOffset]);

  // Whether any card in the current data set has no channel — drives
  // whether we render the No-channel chip at all (no point if every card
  // is channeled).
  const hasUnchanneled = useMemo(() => cards.some(c => !c.channel?.id), [cards]);

  // Every chip the user can click — real channels plus the No-channel
  // sentinel when applicable. Used to detect "all selected" and to reset.
  const allChannelKeys = useMemo<string[]>(
    () => [...channels.map(c => c.id), ...(hasUnchanneled ? [NO_CHANNEL_KEY] : [])],
    [channels, hasUnchanneled],
  );

  const allChannelsSelected =
    channelFilter.size === allChannelKeys.length &&
    allChannelKeys.every(k => channelFilter.has(k));

  // Filtered card set, in this order: week → channel → stage → search.
  const filteredCards = useMemo(() => {
    const byWeek = filterCardsByWeek(cards, week);
    return byWeek.filter(card => {
      const cardChannelKey = card.channel?.id ?? NO_CHANNEL_KEY;
      if (!channelFilter.has(cardChannelKey)) return false;
      if (stageFilter !== 'all' && card.current_stage !== stageFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!card.title.toLowerCase().includes(q) && !card.niche.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [cards, week, channelFilter, stageFilter, search]);

  const summary = useMemo(() => summarizeByChannel(filteredCards, stuckThresholdHours), [filteredCards, stuckThresholdHours]);
  const stuck = useMemo(() => {
    const cutoff = Date.now() - stuckThresholdHours * 3600 * 1000;
    return filteredCards.filter(c => Date.parse(c.last_moved_at) < cutoff && c.current_stage !== 'published');
  }, [filteredCards, stuckThresholdHours]);

  const cardsByStage = useMemo(() => {
    const map = new Map<VideoStageId, CommandCenterCard[]>();
    for (const stage of STAGE_CHAIN) map.set(stage.id, []);
    for (const card of filteredCards) {
      const bucket = map.get(card.current_stage);
      if (bucket) bucket.push(card);
    }
    return map;
  }, [filteredCards]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // Smooth drop animation: 220ms ease, with the original card dimming
  // back to 100% as the overlay settles into place. Matches the dnd-kit
  // default behaviour but with a hint shorter duration so rapid drags
  // feel snappy.
  const dropAnimation: DropAnimation = useMemo(
    () => ({
      duration: 220,
      easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
      sideEffects: defaultDropAnimationSideEffects({
        styles: { active: { opacity: '0.25' } },
      }),
    }),
    [],
  );

  function handleDragStart(event: DragStartEvent) {
    setDraggingCardId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDraggingCardId(null);
    const cardId = String(event.active.id);
    const overId = event.over?.id;
    if (!overId) return;
    const targetStageId = String(overId) as VideoStageId;
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    if (card.current_stage === targetStageId) return;

    console.info('[command-center drag]', {
      videoId: cardId,
      from_stage: card.current_stage,
      to_stage: targetStageId,
      is_auto_managed: card.is_auto_managed,
    });

    if (card.is_auto_managed) {
      toast.warning(`Auto-managed by the auto-pipeline. Use the Pipeline page to act on this video.`, { duration: 5000 });
      return;
    }

    // Optimistic update first; server response either confirms or we
    // roll back via a router.refresh() on failure.
    setCards(prev => prev.map(c => c.id === cardId ? { ...c, current_stage: targetStageId, current_stage_label: getStageDef(targetStageId).label, last_moved_at: new Date().toISOString() } : c));
    try {
      const res = await fetch(`/api/videos/${cardId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStage: targetStageId, source: 'kanban-drag' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((json as { error?: string }).error ?? 'Could not advance the video');
        startTransition(() => router.refresh());
        return;
      }
      toast.success(`Moved to ${getStageDef(targetStageId).label}`);
      // Refresh the server snapshot so the cards reflect the new server-side reality.
      startTransition(() => router.refresh());
    } catch (err) {
      console.error('[command-center drag] failed', err);
      toast.error('Could not advance the video');
      startTransition(() => router.refresh());
    }
  }

  // Click a chip = "show only this channel" (single-select).
  // Cmd/Ctrl+click = add or remove this chip from the current selection.
  // Click the only-active chip again = restore "all chips selected."
  // Empty set is disallowed (would render an empty kanban with no
  // discoverable way back) — we coerce that to "all."
  function selectChannel(id: string, additive: boolean) {
    setChannelFilter(prev => {
      let next: Set<string>;
      if (additive) {
        next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (next.size === 0) next = new Set(allChannelKeys);
      } else if (prev.size === 1 && prev.has(id)) {
        next = new Set(allChannelKeys);
      } else {
        next = new Set([id]);
      }
      console.info('[command-center channel-filter]', {
        clicked: id,
        additive,
        selected_count: next.size,
        all_selected: next.size === allChannelKeys.length,
      });
      return next;
    });
  }

  function resetChannelFilter() {
    setChannelFilter(new Set(allChannelKeys));
    console.info('[command-center channel-filter] reset');
  }

  return (
    <div className="h-full flex flex-col" data-testid="command-center">
      <header className="border-b px-4 py-3 flex items-center gap-3 flex-wrap" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>This Week</h1>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            ISO {week.year}-W{String(week.week).padStart(2, '0')}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <WeekButton label="◀" onClick={() => setWeekOffset(o => o - 1)} title="Previous week" />
          {weekOffset !== 0 && <WeekButton label="Today" onClick={() => setWeekOffset(0)} title="Back to this week" />}
          <WeekButton label="▶" onClick={() => setWeekOffset(o => o + 1)} title="Next week" />
        </div>
        <div className="flex-1" />
        <input
          type="search"
          placeholder="Search title or niche..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="text-sm px-3 py-1.5 rounded"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', minWidth: 220 }}
        />
        <select
          value={stageFilter}
          onChange={e => setStageFilter(e.target.value as VideoStageId | 'all')}
          className="text-sm px-3 py-1.5 rounded"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        >
          <option value="all">All stages</option>
          {STAGE_CHAIN.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <Link
          href="/pipeline/new"
          className="text-sm px-3 py-1.5 rounded font-medium"
          style={{ background: 'var(--accent-cyan)22', color: 'var(--accent-cyan-bright)', border: '1px solid var(--accent-cyan)44' }}
        >
          + New batch
        </Link>
        <button
          type="button"
          onClick={() => setNewVideoOpen(true)}
          className="text-sm px-3 py-1.5 rounded font-medium"
          style={{ background: 'var(--accent-purple)', color: 'white' }}
        >
          + New video
        </button>
      </header>

      <NewVideoDialog
        open={newVideoOpen}
        onClose={() => setNewVideoOpen(false)}
        channels={channels}
        onCreated={() => startTransition(() => router.refresh())}
      />

      {(channels.length > 1 || hasUnchanneled) && (
        <div className="border-b px-4 py-2 flex items-center gap-1.5 flex-wrap" style={{ borderColor: 'var(--border)' }}>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }} title="Click a chip to filter to that channel. ⌘/Ctrl+click to add more.">
            Channels:
          </span>
          {channels.map(ch => {
            const selected = channelFilter.has(ch.id);
            const color = ch.account_color || 'var(--accent-purple)';
            return (
              <button
                key={ch.id}
                type="button"
                onClick={e => selectChannel(ch.id, e.metaKey || e.ctrlKey)}
                title={`Click: filter to ${ch.name}. ⌘/Ctrl+click: toggle in selection.`}
                className="text-xs px-2.5 py-1 rounded-full inline-flex items-center gap-1.5 transition-colors"
                style={{
                  background: selected ? `${color}22` : 'transparent',
                  color: selected ? color : 'var(--text-muted)',
                  border: `1px solid ${selected ? color + '66' : 'var(--border)'}`,
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} aria-hidden />
                {ch.name}
              </button>
            );
          })}
          {hasUnchanneled && (() => {
            const selected = channelFilter.has(NO_CHANNEL_KEY);
            const color = 'var(--text-muted)';
            return (
              <button
                key={NO_CHANNEL_KEY}
                type="button"
                onClick={e => selectChannel(NO_CHANNEL_KEY, e.metaKey || e.ctrlKey)}
                title="Click: show only unchanneled videos. ⌘/Ctrl+click: toggle in selection."
                className="text-xs px-2.5 py-1 rounded-full inline-flex items-center gap-1.5 transition-colors"
                style={{
                  background: selected ? 'rgba(148,163,184,0.18)' : 'transparent',
                  color: selected ? 'var(--text-primary)' : 'var(--text-muted)',
                  border: `1px solid ${selected ? 'rgba(148,163,184,0.55)' : 'var(--border)'}`,
                  fontStyle: 'italic',
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: color, opacity: 0.6 }} aria-hidden />
                No channel
              </button>
            );
          })()}
          {!allChannelsSelected && (
            <button
              type="button"
              onClick={resetChannelFilter}
              title="Show every channel again"
              className="text-xs px-2 py-1 rounded transition-colors hover:underline"
              style={{ color: 'var(--text-muted)' }}
            >
              ↺ All
            </button>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* Left rail: per-channel-week summary. Hidden on small screens
            (mobile users filter via the channel chips at the top). */}
        <aside
          className="border-r overflow-y-auto hidden md:block"
          style={{ borderColor: 'var(--border)', width: 240, minWidth: 240 }}
        >
          <div className="p-3">
            <div className="text-xs uppercase tracking-wider mb-2 font-semibold" style={{ color: 'var(--text-muted)' }}>
              This week, by channel
            </div>
            {summary.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                No videos in scope. Adjust filters or create a new video.
              </p>
            )}
            <div className="space-y-2">
              {summary.map(s => {
                const key = s.channelId ?? NO_CHANNEL_KEY;
                return (
                  <SummaryRow
                    key={key}
                    s={s}
                    isActive={channelFilter.has(key)}
                    onClick={e => selectChannel(key, e.metaKey || e.ctrlKey)}
                  />
                );
              })}
            </div>
          </div>
        </aside>

        {/* Main kanban */}
        <main className="flex-1 min-w-0 flex flex-col">
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDraggingCardId(null)}
          >
            <div className="flex-1 overflow-x-auto overflow-y-hidden">
              <div className="flex h-full min-w-max">
                {STAGE_CHAIN.map(stage => (
                  <KanbanColumn
                    key={stage.id}
                    stageId={stage.id}
                    label={stage.label}
                    cards={cardsByStage.get(stage.id) ?? []}
                    presenceSnapshot={presenceSnapshot}
                    wipLimit={wipLimits[stage.id] ?? null}
                  />
                ))}
              </div>
            </div>
            <DragOverlay dropAnimation={dropAnimation}>
              {draggingCardId
                ? (() => {
                    const c = cards.find(x => x.id === draggingCardId);
                    return c ? <DragGhost card={c} /> : null;
                  })()
                : null}
            </DragOverlay>
          </DndContext>

          {/* Stuck panel */}
          <StuckPanel stuck={stuck} thresholdHours={stuckThresholdHours} />

          {truncated && (
            <div
              className="border-t px-4 py-2 text-xs flex items-center justify-between"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
            >
              <span>
                Showing <strong style={{ color: 'var(--text-primary)' }}>{cards.length}</strong> of <strong style={{ color: 'var(--text-primary)' }}>{totalProjects}</strong> projects.
                Older or archived projects are not displayed.
              </span>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function WeekButton({ label, onClick, title }: { label: string; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="text-xs px-2 py-1 rounded"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
    >
      {label}
    </button>
  );
}

function SummaryRow({ s, isActive, onClick }: { s: PerChannelWeekSummary; isActive: boolean; onClick: (e: React.MouseEvent) => void }) {
  const color = s.channelColor || 'var(--accent-purple)';
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Click: filter to ${s.channelName}. ⌘/Ctrl+click: toggle in selection.`}
      className="w-full text-left px-2.5 py-2 rounded transition-colors"
      style={{
        background: isActive ? `${color}11` : 'transparent',
        border: `1px solid ${isActive ? color + '44' : 'var(--border)'}`,
      }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} aria-hidden />
        <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{s.channelName}</span>
        <span className="ml-auto text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{s.totalThisWeek}</span>
      </div>
      <div className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
        <span title="Published this week">{s.doneThisWeek} done</span>
        {s.blockedThisWeek > 0 && (
          <span title="Blocked on narrator / editor / gate" style={{ color: 'var(--accent-yellow)' }}>{s.blockedThisWeek} blocked</span>
        )}
        {s.stuckThisWeek > 0 && (
          <span title="Not moved in 48h" style={{ color: 'var(--accent-pink)' }}>{s.stuckThisWeek} stuck</span>
        )}
      </div>
    </button>
  );
}

function KanbanColumn({ stageId, label, cards, presenceSnapshot, wipLimit }: { stageId: VideoStageId; label: string; cards: CommandCenterCard[]; presenceSnapshot: Record<string, Array<{ userId: string; name: string | null }>>; wipLimit: number | null }) {
  const { isOver, setNodeRef } = useDroppable({ id: stageId });
  const overLimit = wipLimit !== null && cards.length > wipLimit;
  return (
    <div
      ref={setNodeRef}
      className="flex flex-col border-r"
      style={{
        width: 280,
        minWidth: 280,
        borderColor: 'var(--border)',
        background: isOver ? 'var(--accent-purple)11' : 'transparent',
      }}
    >
      <header className="px-3 py-2 border-b sticky top-0" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>{label}</span>
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{
              color: overLimit ? 'white' : 'var(--text-muted)',
              background: overLimit ? 'var(--accent-pink)' : 'transparent',
            }}
            title={
              wipLimit !== null
                ? overLimit
                  ? `Over WIP limit (${cards.length}/${wipLimit}). Clear some cards before adding more.`
                  : `WIP limit ${wipLimit}`
                : undefined
            }
          >
            {cards.length}{wipLimit !== null ? `/${wipLimit}` : ''}
          </span>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {cards.length === 0 && (
          <div className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>—</div>
        )}
        {cards.map(card => (
          <KanbanCard key={card.id} card={card} presence={presenceSnapshot[card.id] ?? []} />
        ))}
      </div>
    </div>
  );
}

function KanbanCard({ card, presence }: { card: CommandCenterCard; presence: Array<{ userId: string; name: string | null }> }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id });
  const accent = card.channel?.account_color ?? 'var(--accent-purple)';
  const toolPath = getStageDef(card.current_stage).toolPath;
  const cardHref = `${toolPath}?videoId=${encodeURIComponent(card.id)}`;
  // While dragging, the original card stays in place but dims out;
  // the floating ghost (DragOverlay) follows the pointer. Cleaner than
  // moving the original because the column doesn't reflow mid-drag.
  const style: React.CSSProperties = {
    opacity: isDragging ? 0.25 : 1,
    background: 'var(--bg-primary)',
    border: `1px solid var(--border)`,
    cursor: 'grab',
    touchAction: 'none',
  };
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={style} className="rounded-lg p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        {card.channel && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{ background: `${accent}22`, color: accent, border: `1px solid ${accent}33` }}
          >
            <span className="w-1 h-1 rounded-full" style={{ background: accent }} aria-hidden />
            {card.channel.name}
          </span>
        )}
        {card.is_auto_managed && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'var(--accent-cyan)22', color: 'var(--accent-cyan-bright)' }} title="Auto-pipeline">
            AP
          </span>
        )}
        {presence.length > 0 && (
          <span
            className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold"
            style={{ background: 'var(--accent-cyan)', color: 'white' }}
            title={presence.map(p => p.name ?? 'Teammate').join(', ') + ' has this open'}
          >
            {presence.length}
          </span>
        )}
        {card.scheduled_for && (
          <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
            {new Date(card.scheduled_for).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
      <Link
        href={cardHref}
        onClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
        className="block font-medium text-sm line-clamp-2 hover:underline"
        style={{ color: 'var(--text-primary)' }}
      >
        {card.title || 'Untitled'}
      </Link>
      {card.blocker.kind !== 'none' && (
        <div
          className="text-[11px] px-1.5 py-0.5 rounded inline-block"
          style={{
            background: card.blocker.kind === 'gate' ? 'var(--accent-yellow)22' :
                       card.blocker.kind === 'ai' ? 'var(--accent-cyan)22' :
                       'var(--bg-secondary)',
            color: card.blocker.kind === 'gate' ? 'var(--accent-yellow)' :
                   card.blocker.kind === 'ai' ? 'var(--accent-cyan-bright)' :
                   'var(--text-muted)',
          }}
        >
          {card.blocker.label}
        </div>
      )}
      {card.latest_qa_score !== null && card.current_stage === 'qa' && (
        <div
          className="text-[10px] inline-block px-1.5 py-0.5 rounded ml-1"
          style={{
            color: card.latest_qa_score >= 100 ? 'var(--accent-green)' : 'var(--text-muted)',
          }}
        >
          QA {card.latest_qa_score}/100
        </div>
      )}
    </div>
  );
}

/** Visual stand-in shown by DragOverlay while a card is being dragged.
 *  Same shape as KanbanCard's rendering minus the interactive bits. The
 *  ghost feels lifted thanks to a stronger shadow and full opacity. */
function DragGhost({ card }: { card: CommandCenterCard }) {
  const accent = card.channel?.account_color ?? 'var(--accent-purple)';
  return (
    <div
      className="rounded-lg p-2.5 space-y-1.5"
      style={{
        width: 264, // match KanbanCard at col-width 280 minus padding
        background: 'var(--bg-primary)',
        border: `1px solid var(--accent-purple)`,
        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
        cursor: 'grabbing',
      }}
    >
      <div className="flex items-center gap-1.5">
        {card.channel && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{ background: `${accent}22`, color: accent, border: `1px solid ${accent}33` }}
          >
            <span className="w-1 h-1 rounded-full" style={{ background: accent }} aria-hidden />
            {card.channel.name}
          </span>
        )}
        {card.is_auto_managed && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'var(--accent-cyan)22', color: 'var(--accent-cyan-bright)' }}>
            AP
          </span>
        )}
        {card.scheduled_for && (
          <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
            {new Date(card.scheduled_for).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
      <div className="font-medium text-sm line-clamp-2" style={{ color: 'var(--text-primary)' }}>
        {card.title || 'Untitled'}
      </div>
    </div>
  );
}

function StuckPanel({ stuck, thresholdHours }: { stuck: CommandCenterCard[]; thresholdHours: number }) {
  if (stuck.length === 0) {
    return (
      <footer className="border-t px-4 py-2" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
        <span className="text-xs" style={{ color: 'var(--accent-green)' }}>
          ✓ Nothing stuck. Everything in flight has moved in the last {thresholdHours} hours.
        </span>
      </footer>
    );
  }
  return (
    <footer
      className="border-t px-4 py-2 flex items-center gap-2 overflow-x-auto"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
    >
      <span className="text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--accent-pink)' }}>
        {stuck.length} stuck (no move in {thresholdHours}h):
      </span>
      {stuck.slice(0, 10).map(card => (
        <Link
          key={card.id}
          href={`${getStageDef(card.current_stage).toolPath}?videoId=${encodeURIComponent(card.id)}`}
          className="text-xs px-2 py-1 rounded whitespace-nowrap"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        >
          {card.title.slice(0, 40)}{card.title.length > 40 ? '…' : ''}
          {' · '}
          <span style={{ color: 'var(--text-muted)' }}>{card.current_stage_label}</span>
        </Link>
      ))}
      {stuck.length > 10 && (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          + {stuck.length - 10} more
        </span>
      )}
    </footer>
  );
}

// Shift an ISO week by N weeks (positive = future, negative = past).
function shiftIsoWeek(base: IsoWeek, offset: number): IsoWeek {
  if (offset === 0) return base;
  const startMs = Date.parse(base.startISO) + offset * 7 * 24 * 3600 * 1000;
  // Reconstruct from a date inside the new week's Monday.
  const d = new Date(startMs + 3 * 24 * 3600 * 1000); // Thursday of that week
  d.setUTCHours(0, 0, 0, 0);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const year = d.getUTCFullYear();
  const monday = new Date(startMs);
  monday.setUTCHours(0, 0, 0, 0);
  const sunday = new Date(monday.getTime());
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { year, week, startISO: monday.toISOString(), endISO: sunday.toISOString() };
}
