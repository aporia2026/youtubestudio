'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { AssignDialog } from './AssignDialog';
import { AudioPlayer } from './AudioPlayer';
import { TakeReview } from './TakeReview';
import { downloadCrossOriginFile } from '@/lib/download-file';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';

interface Assignment {
  id: string;
  project_id?: string;
  /** Collaborator id of the assigned narrator — used to deep-link the
   *  owner-side chat shortcut (`/messages?with=<id>`). */
  narrator_id?: string;
  narrator_name: string;
  narrator_color: string;
  status: string;
  share_token: string;
  deadline: string | null;
  created_at: string;
  /** Set when the narrator uploaded one audio file covering the whole
   *  script — owner reviews it via TakeReview. */
  full_audio_take_id?: string | null;
  full_audio_url?: string | null;
  full_audio_duration_seconds?: number | null;
  full_audio_comment_count?: number;
  full_audio_unresolved_count?: number;
  full_audio_has_unresolved_owner_feedback?: boolean;
}

interface Take {
  id: string;
  take_number: number;
  audio_url: string;
  duration_seconds: number | null;
  narrator_notes: string | null;
  owner_notes: string | null;
  rating: number | null;
  is_selected: boolean;
  /** Per-take comment counts embedded by the GET route. */
  comment_count?: number;
  unresolved_count?: number;
  has_owner_feedback?: boolean;
  has_unresolved_owner_feedback?: boolean;
}

interface Section {
  id: string;
  section_number: number;
  label: string | null;
  script_text: string;
  estimated_duration_seconds: number | null;
  status: string;
  approved_take_id: string | null;
  takes: Take[] | null;
}

/** True when the synthetic section_number=0 row (the full-audio holder)
 *  is already marked approved. Drives the owner-side "Approve" CTA on
 *  the full-narration card so it flips into a confirmation state. */
function isFullNarrationApproved(sections: Section[]): boolean {
  const fullAudioSection = sections.find(s => s.section_number === 0);
  return fullAudioSection?.status === 'approved';
}

// ─── Synced-player A/B mode ────────────────────────────────────────────────
//
// The "Synced (beta)" mode pipes real ElevenLabs forced-alignment timings
// into TakeReview's inner teleprompter so the highlighted word stays in
// lockstep with the audio (vs. the classic mode where words are spread
// evenly across the duration — a constant-rate approximation).
//
// Backed by localStorage so the owner's preference survives reloads
// without a DB column. Default 'classic' so existing users see no
// behavior change until they opt in.

type SyncMode = 'classic' | 'synced';

const SYNC_MODE_STORAGE_KEY = 'narration.syncMode.v1';

function readSyncMode(): SyncMode {
  if (typeof window === 'undefined') return 'classic';
  return window.localStorage.getItem(SYNC_MODE_STORAGE_KEY) === 'synced' ? 'synced' : 'classic';
}

type AlignmentStatus = 'pending' | 'running' | 'ready' | 'failed' | 'no-take';

interface AlignmentState {
  status: AlignmentStatus;
  error: string | null;
  alignment: ForcedAlignmentResponse | null;
  /** ISO timestamp from the server marking when the current 'running'
   *  claim was taken. The UI computes elapsed seconds from this so the
   *  reviewer can see how long the sync has been working. Null when not
   *  running. */
  startedAt: string | null;
}

/**
 * Format an elapsed-seconds count as M:SS — used by the "Building word-
 * level sync…" badge so the reviewer can decide whether to wait or hit
 * Stop. Caps the display at "10:00+" because anything past 10 minutes
 * is genuinely broken (function maxDuration is 5 minutes, stale-claim
 * reclaim is another 5).
 */
function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  if (seconds >= 600) return '10:00+';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface NarrationTabProps {
  projectId: string;
  scriptId: string;
  scriptText: string;
  scriptVersion: number;
  /** Used as the prefix when the owner downloads narration audio. */
  projectTitle?: string;
  /** Deep-link from the global comments inbox: auto-open the review
   *  panel for this take id. Matched against the active assignment's
   *  full-audio take and against every per-section take. */
  initialReviewTakeId?: string;
  /** Deep-link partner of `initialReviewTakeId`: scroll + highlight the
   *  matching comment once TakeReview has fetched its list. */
  initialCommentId?: string;
}

/** Sanitize a project title into a filename-safe base. */
function safeFilenameBase(s: string | undefined): string {
  const cleaned = (s || '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60);
  return cleaned || 'narration';
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: 'rgba(255,255,255,0.05)', text: 'var(--text-muted)' },
  recording: { bg: 'rgba(124,58,237,0.15)', text: '#7c3aed' },
  submitted: { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  approved: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
  retake: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
};

export function NarrationTab({ projectId, scriptId, scriptText, scriptVersion, projectTitle, initialReviewTakeId, initialCommentId }: NarrationTabProps) {
  const filenameBase = safeFilenameBase(projectTitle);
  const handleDownload = (takeId: string, name: string) => {
    downloadCrossOriginFile(`/api/narrator/takes/${takeId}/audio`, name)
      .catch(e => toast.error(`Download failed: ${e instanceof Error ? e.message : 'unknown error'}`));
  };
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAssign, setShowAssign] = useState(false);
  const [activeAssignment, setActiveAssignment] = useState<Assignment | null>(null);
  const [stitching, setStitching] = useState(false);
  // Which take is currently expanded into the Frame.io-style review panel.
  // One at a time so the page stays manageable on long scripts.
  const [reviewingTakeId, setReviewingTakeId] = useState<string | null>(null);
  const [approvingFull, setApprovingFull] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>('classic');
  const [alignmentState, setAlignmentState] = useState<AlignmentState>({
    status: 'pending',
    error: null,
    alignment: null,
    startedAt: null,
  });
  const [retryingAlignment, setRetryingAlignment] = useState(false);
  // Tick once a second while a run is in flight so the elapsed-time
  // badge stays accurate without the rest of the polling effect
  // refiring. Polling already runs every 3s but the timer needs 1s
  // granularity to feel live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (alignmentState.status !== 'running' || !alignmentState.startedAt) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [alignmentState.status, alignmentState.startedAt]);

  // Hydrate the sync-mode preference once on mount. Splitting this out of
  // the initial useState lets server-rendering pick 'classic' (matching
  // what the user sees before JS runs) without a hydration mismatch.
  useEffect(() => {
    setSyncMode(readSyncMode());
  }, []);

  function persistSyncMode(mode: SyncMode) {
    setSyncMode(mode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SYNC_MODE_STORAGE_KEY, mode);
    }
  }

  useEffect(() => { loadAssignments(); }, [projectId]);

  // Deep-link from the inbox: once the active assignment + its sections
  // are loaded, open the review panel for the requested take. We don't
  // re-trigger if the user manually closes the panel afterwards — the
  // ref guard ensures the auto-open fires exactly once per take id.
  const consumedTakeDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialReviewTakeId) return;
    if (consumedTakeDeepLinkRef.current === initialReviewTakeId) return;
    if (!activeAssignment) return;
    const isFullAudio = activeAssignment.full_audio_take_id === initialReviewTakeId;
    const inSection = sections.some(s => s.takes?.some(t => t.id === initialReviewTakeId));
    if (!isFullAudio && !inSection) return;
    consumedTakeDeepLinkRef.current = initialReviewTakeId;
    setReviewingTakeId(initialReviewTakeId);
  }, [initialReviewTakeId, activeAssignment, sections]);

  // Auto-open the assign dialog when arriving via ?assign=1 (e.g. from the
  // Script Generator's "Send to Narrator" button) — but only after data has
  // loaded so we don't pop a dialog over a loading skeleton, and only when
  // there's no existing assignment (otherwise we'd offer to create a duplicate).
  useEffect(() => {
    if (typeof window === 'undefined' || loading) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('assign') !== '1') return;
    if (!activeAssignment && scriptText) {
      setShowAssign(true);
    }
    // Clean the param so refresh doesn't reopen
    params.delete('assign');
    const newSearch = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${newSearch ? '?' + newSearch : ''}`);
  }, [loading, activeAssignment, scriptText]);

  async function loadAssignments() {
    try {
      const res = await fetch(`/api/narrator/assignments`);
      if (res.ok) {
        const all: Array<Assignment & { project_id?: string }> = await res.json();
        setAssignments(all);

        // Find assignment for this project and load its details
        const match = all.find(a => a.project_id === projectId);
        if (match) {
          const detailRes = await fetch(`/api/narrator/assignments/${match.id}`);
          if (detailRes.ok) {
            const data = await detailRes.json();
            setActiveAssignment(data.assignment);
            setSections(data.sections || []);
          }
        }
      }
    } catch {}
    finally { setLoading(false); }
  }

  function handleAssigned(token: string) {
    setShowAssign(false);
    navigator.clipboard.writeText(`${window.location.origin}/narrate/${token}`);
    toast.success('Assignment created — link copied to clipboard');
    loadAssignments();
  }

  async function handleApproveSection(sectionId: string, takeId: string) {
    if (!activeAssignment) return;
    try {
      await fetch(`/api/narrator/assignments/${activeAssignment.id}/sections/${sectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved', approved_take_id: takeId }),
      });
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, status: 'approved', approved_take_id: takeId } : s));
      toast.success('Section approved');
    } catch { toast.error('Failed to approve'); }
  }

  async function handleRetakeSection(sectionId: string) {
    if (!activeAssignment) return;
    const notes = prompt('What needs to be re-recorded?');
    if (!notes) return;
    try {
      await fetch(`/api/narrator/assignments/${activeAssignment.id}/sections/${sectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'retake', retake_notes: notes }),
      });
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, status: 'retake' } : s));
      toast.success('Retake requested');
    } catch { toast.error('Failed'); }
  }

  // Alignment fetch + polling. Issues a status read on every poll, a
  // one-shot full-payload read the moment status flips to 'ready', and a
  // one-time POST to kick off alignment when the status starts at
  // 'pending'. The kick matters for any take that was uploaded before
  // migration 0051 went live (or whose narrator-PATCH-side auto-trigger
  // never fired) — without it the status would loop "Sync queued…"
  // forever because nothing's actually running. Runs only when the
  // synced player is selected (no point spending API bandwidth on a
  // classic-mode user) and a full-audio take exists.
  useEffect(() => {
    if (syncMode !== 'synced') return;
    if (!activeAssignment?.id || !activeAssignment.full_audio_take_id) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let kicked = false; // Per-effect-instance: re-kick on assignment change but not on every poll.

    async function poll() {
      try {
        const res = await fetch(`/api/narrator/assignments/${activeAssignment!.id}/align`);
        if (!res.ok) {
          // 500 most commonly means migration 0051 hasn't run on this DB
          // (the alignment_* columns are missing). Surface it instead of
          // letting the UI sit at "Sync queued…" forever.
          if (!cancelled) {
            setAlignmentState({
              status: 'failed',
              error: `Sync endpoint error (HTTP ${res.status}). The alignment migration may not have run on this database — run \`npm run db:migrate\` and reload.`,
              alignment: null,
              startedAt: null,
            });
          }
          return;
        }
        const data: {
          status: AlignmentStatus;
          error: string | null;
          hasAlignment: boolean;
          startedAt?: string | null;
        } = await res.json();
        if (cancelled) return;

        // Surface the live status into the UI even when we don't have the
        // full alignment payload yet — drives the badge above the player.
        setAlignmentState((prev) => ({
          status: data.status,
          error: data.error,
          alignment: data.status === 'ready' ? prev.alignment : null,
          startedAt: data.status === 'running' ? data.startedAt ?? prev.startedAt : null,
        }));

        if (data.status === 'ready' && data.hasAlignment) {
          // Pull the full payload once; subsequent polls skip this branch
          // until status flips again.
          const fullRes = await fetch(
            `/api/narrator/assignments/${activeAssignment!.id}/align?include=alignment`,
          );
          if (fullRes.ok) {
            const full: { alignment?: ForcedAlignmentResponse } = await fullRes.json();
            if (!cancelled && full.alignment) {
              setAlignmentState({
                status: 'ready',
                error: null,
                alignment: full.alignment,
                startedAt: null,
              });
            }
          }
          // No need to keep polling once we have the alignment.
          return;
        }

        // One-time kick: if the take is sitting at 'pending' and nothing
        // has claimed it yet, POST to start the alignment now. The route
        // is idempotent — the orchestrator's atomic claim guards against
        // a double-trigger if the narrator's PATCH-side fire-and-forget
        // already ran but the status read raced ahead of the running
        // flip. Don't re-kick on subsequent pending polls (the orchestrator
        // will have moved status to 'running' by then anyway).
        if (data.status === 'pending' && !kicked) {
          kicked = true;
          fetch(`/api/narrator/assignments/${activeAssignment!.id}/align`, { method: 'POST' })
            .catch(() => {
              // Failures surface on the next status poll as 'failed' + error string.
            });
        }

        // Re-poll while still pending/running; back off when failed so the
        // user has time to read the error before we hammer the endpoint.
        if (data.status === 'pending' || data.status === 'running') {
          pollTimer = setTimeout(poll, 3000);
        }
      } catch {
        // Network blip — try again with the same cadence.
        if (!cancelled) pollTimer = setTimeout(poll, 5000);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [syncMode, activeAssignment?.id, activeAssignment?.full_audio_take_id]);

  async function handleRetryAlignment() {
    if (!activeAssignment || retryingAlignment) return;
    setRetryingAlignment(true);
    // Optimistic: the POST will claim 'running' on the server within a
    // few hundred ms. The next poll picks up the real startedAt; meanwhile
    // start the timer from now so the reviewer sees movement immediately.
    setAlignmentState({
      status: 'running',
      error: null,
      alignment: null,
      startedAt: new Date().toISOString(),
    });
    try {
      const res = await fetch(`/api/narrator/assignments/${activeAssignment.id}/align`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      // Polling effect picks up the result; surface the trigger immediately.
      toast.success('Sync retry started');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start retry');
      setAlignmentState({
        status: 'failed',
        error: err instanceof Error ? err.message : 'Retry failed',
        alignment: null,
        startedAt: null,
      });
    } finally {
      setRetryingAlignment(false);
    }
  }

  async function handleStopAlignment() {
    if (!activeAssignment) return;
    // Optimistic flip so the spinner disappears immediately. The polling
    // effect will pick up the server-side state on the next tick, but
    // there's no reason to make the reviewer watch the spinner one more
    // beat after they explicitly asked it to stop.
    setAlignmentState({
      status: 'failed',
      error: 'Cancelled by user',
      alignment: null,
      startedAt: null,
    });
    try {
      await fetch(`/api/narrator/assignments/${activeAssignment.id}/align`, { method: 'DELETE' });
      toast.success('Sync cancelled');
    } catch (err) {
      // Best-effort — the optimistic flip already moved the UI; surface
      // only as a toast so the reviewer knows the server-side cancel may
      // not have landed (the in-flight run will still wrap up on its own).
      toast.error(err instanceof Error ? err.message : 'Could not reach server to cancel');
    }
  }

  async function handleApproveFull() {
    if (!activeAssignment || approvingFull) return;
    if (!confirm('Approve this full narration? This marks the assignment complete and the narrator gets notified.')) return;
    setApprovingFull(true);
    try {
      const res = await fetch(`/api/narrator/assignments/${activeAssignment.id}/approve-full`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      // Reflect the new state locally so the button flips without a refetch.
      setSections(prev => prev.map(s => s.section_number === 0
        ? { ...s, status: 'approved', approved_take_id: activeAssignment.full_audio_take_id ?? s.approved_take_id }
        : s));
      setActiveAssignment(prev => prev ? { ...prev, status: 'completed' } : prev);
      toast.success('Narration approved — narrator notified');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setApprovingFull(false);
    }
  }

  async function handleStitch() {
    if (!activeAssignment) return;
    setStitching(true);
    try {
      const res = await fetch(`/api/narrator/assignments/${activeAssignment.id}/stitch`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Final voiceover created (${data.sections} sections stitched)`);
        setActiveAssignment(prev => prev ? { ...prev, status: 'completed' } : prev);
      } else {
        const err = await res.json();
        toast.error(err.error || 'Failed to stitch');
      }
    } catch { toast.error('Failed to stitch'); }
    finally { setStitching(false); }
  }

  async function handleRateTake(takeId: string, rating: number, sectionId: string) {
    if (!activeAssignment) return;
    try {
      await fetch(`/api/narrator/assignments/${activeAssignment.id}/sections/${sectionId}/takes/${takeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      setSections(prev => prev.map(s => {
        if (s.id !== sectionId || !s.takes) return s;
        return { ...s, takes: s.takes.map(t => t.id === takeId ? { ...t, rating } : t) };
      }));
    } catch {}
  }

  if (loading) {
    return <div className="py-10 text-center"><div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} /></div>;
  }

  if (!activeAssignment) {
    return (
      <div className="text-center py-16 glass rounded-xl">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3" style={{ color: 'var(--text-muted)' }}>
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        </svg>
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>No narrator assigned yet</p>
        <button onClick={() => setShowAssign(true)} disabled={!scriptText} className="btn-primary text-sm disabled:opacity-50">
          Assign to Narrator
        </button>
        {showAssign && scriptText && (
          <AssignDialog
            projectId={projectId}
            scriptId={scriptId}
            scriptText={scriptText}
            scriptVersion={scriptVersion}
            onClose={() => setShowAssign(false)}
            onAssigned={handleAssigned}
          />
        )}
      </div>
    );
  }

  // Section 0 is the synthetic "full narration" container — surfaced as its
  // own card, not in the per-section grid.
  const realSections = sections.filter(s => s.section_number !== 0);
  const approvedCount = realSections.filter(s => s.status === 'approved').length;
  const allApproved = approvedCount === realSections.length && realSections.length > 0;
  const progress = realSections.length > 0 ? Math.round((approvedCount / realSections.length) * 100) : 0;
  const fullNarrationApproved = isFullNarrationApproved(sections);

  return (
    <div className="space-y-4">
      {/* Assignment header */}
      <div className="glass rounded-xl p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white" style={{ background: activeAssignment.narrator_color }}>
            {(activeAssignment.narrator_name || '?')[0].toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{activeAssignment.narrator_name}</p>
            <p className="text-xs capitalize" style={{ color: 'var(--text-muted)' }}>{activeAssignment.status} — {approvedCount}/{realSections.length} approved</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Owner shortcut to open the 1:1 chat with this narrator. Goes
              straight to /messages with the right thread auto-selected,
              saving the trip through the sidebar collaborator list. */}
          {activeAssignment.narrator_id && (
            <a
              href={`/messages?with=${activeAssignment.narrator_id}`}
              className="text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5"
              style={{ background: 'rgba(6,182,212,0.1)', color: '#06b6d4' }}
              title={`Open chat with ${activeAssignment.narrator_name}`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Message
            </a>
          )}
          <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/narrate/${activeAssignment.share_token}`); toast.success('Link copied'); }}
            className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(124,58,237,0.1)', color: '#7c3aed' }}>
            Copy Link
          </button>
          {allApproved && activeAssignment.status !== 'completed' && (
            <button onClick={handleStitch} disabled={stitching} className="text-xs px-3 py-1.5 rounded-lg font-medium text-white disabled:opacity-50" style={{ background: '#22c55e' }}>
              {stitching ? 'Stitching...' : 'Stitch Final Voiceover'}
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #22c55e)' }} />
      </div>

      {/* Full-narration card — surfaces when the narrator chose to upload a
          single audio file covering the whole script. Owner reviews it via
          the same TakeReview component used per-take.

          Sync mode (A/B): the inner teleprompter switches between the
          classic constant-rate ScriptFollow and the word-accurate
          NarrationTeleprompter driven by ElevenLabs forced alignment.
          Defaults to classic so first-time owners see the existing
          behavior — flip the toggle above the player to opt in. */}
      {activeAssignment.full_audio_take_id && activeAssignment.full_audio_url && (
        <div className="glass rounded-xl p-4">
          {/* Sync-mode toggle + status badge. Lives outside the player row so
              the reviewer sees it whether or not they've expanded the review
              panel. Status badge only shows in 'synced' mode — pointless
              noise otherwise. */}
          <div className="flex items-center justify-between mb-2 pb-2" style={{ borderBottom: '1px dashed rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-1 text-[10px]">
              {(['classic', 'synced'] as SyncMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => persistSyncMode(m)}
                  className="px-2 py-0.5 rounded transition-colors cursor-pointer"
                  style={{
                    background: syncMode === m ? 'rgba(124,58,237,0.18)' : 'transparent',
                    color: syncMode === m ? '#a78bfa' : 'var(--text-muted)',
                    border: `1px solid ${syncMode === m ? 'rgba(124,58,237,0.3)' : 'rgba(255,255,255,0.06)'}`,
                  }}
                  title={
                    m === 'classic'
                      ? 'Constant-rate word highlight — works without alignment'
                      : 'Word-accurate sync from ElevenLabs forced alignment'
                  }
                >
                  {m === 'classic' ? 'Classic' : 'Synced (beta)'}
                </button>
              ))}
            </div>
            {syncMode === 'synced' && (
              <div className="flex items-center gap-2 text-[10px]">
                {alignmentState.status === 'pending' && (
                  <span style={{ color: 'var(--text-muted)' }}>Sync queued…</span>
                )}
                {alignmentState.status === 'running' && (
                  <span className="flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                    <span className="w-2.5 h-2.5 rounded-full border border-t-transparent animate-spin"
                      style={{ borderColor: '#a78bfa', borderTopColor: 'transparent' }} />
                    Building word-level sync…
                    {alignmentState.startedAt && (
                      <span className="font-mono ml-1" style={{ color: 'var(--text-muted)' }}>
                        {formatElapsed((nowMs - new Date(alignmentState.startedAt).getTime()) / 1000)}
                      </span>
                    )}
                  </span>
                )}
                {/* Stop button — visible while the sync is queued or in
                    flight so the reviewer is never trapped watching the
                    spinner. Cancels the server-side run; the in-flight
                    ElevenLabs fetch still wraps up on its own, but its
                    result is discarded by the status guard in
                    setTakeAlignmentReady. */}
                {(alignmentState.status === 'pending' || alignmentState.status === 'running') && (
                  <button
                    onClick={handleStopAlignment}
                    className="px-2 py-0.5 rounded transition-colors cursor-pointer"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      color: 'var(--text-muted)',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                    title="Stop the sync — you can retry later"
                  >
                    ✕ Stop
                  </button>
                )}
                {alignmentState.status === 'ready' && alignmentState.alignment && (
                  <span style={{ color: '#22c55e' }}>✓ Word-accurate sync ready</span>
                )}
                {alignmentState.status === 'failed' && (
                  <>
                    <span style={{ color: '#ef4444' }}>
                      {alignmentState.error === 'Cancelled by user'
                        ? 'Sync cancelled'
                        : 'Sync unavailable'}
                    </span>
                    <button
                      onClick={handleRetryAlignment}
                      disabled={retryingAlignment}
                      className="px-2 py-0.5 rounded transition-colors cursor-pointer disabled:opacity-50"
                      style={{
                        background: 'rgba(239,68,68,0.12)',
                        color: '#ef4444',
                        border: '1px solid rgba(239,68,68,0.3)',
                      }}
                    >
                      {retryingAlignment ? 'Retrying…' : '↻ Retry'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {/* When alignment fails, surface the actual reason directly under
              the toggle row. Hiding it in a tooltip means the reviewer
              can't see what's wrong without hovering — and on touch
              devices, can't see it at all. */}
          {syncMode === 'synced'
            && alignmentState.status === 'failed'
            && alignmentState.error
            && alignmentState.error !== 'Cancelled by user' && (
            <div
              className="mb-2 px-2 py-1.5 rounded text-[11px] leading-snug"
              style={{
                background: 'rgba(239,68,68,0.08)',
                color: '#fca5a5',
                border: '1px solid rgba(239,68,68,0.2)',
              }}
            >
              <span className="font-mono">{alignmentState.error}</span>
            </div>
          )}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Full narration</span>
              {activeAssignment.full_audio_duration_seconds && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  ~{Math.floor(activeAssignment.full_audio_duration_seconds / 60)}:{(Math.round(activeAssignment.full_audio_duration_seconds) % 60).toString().padStart(2, '0')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => activeAssignment.full_audio_take_id && handleDownload(activeAssignment.full_audio_take_id, `${filenameBase}-full-narration`)}
                className="text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer flex items-center gap-1"
                style={{ color: '#a78bfa', background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.3)' }}
                title="Download full narration"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download
              </button>
              <button
                onClick={() => setReviewingTakeId(reviewingTakeId === activeAssignment.full_audio_take_id ? null : (activeAssignment.full_audio_take_id || null))}
                className="text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer flex items-center gap-1.5"
                style={{
                  background: reviewingTakeId === activeAssignment.full_audio_take_id ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.1)',
                  color: '#a78bfa',
                  border: '1px solid rgba(124,58,237,0.3)',
                }}
              >
                {reviewingTakeId === activeAssignment.full_audio_take_id ? '▾ Hide review' : '▸ Review & comment'}
                {reviewingTakeId !== activeAssignment.full_audio_take_id && (activeAssignment.full_audio_unresolved_count ?? 0) > 0 && (
                  <span
                    className="text-[9px] px-1 py-0.5 rounded-full font-bold"
                    style={{ background: 'rgba(167,139,250,0.5)', color: '#fff', minWidth: 14, textAlign: 'center' }}
                  >
                    {activeAssignment.full_audio_unresolved_count}
                  </span>
                )}
              </button>
              {/* Approve CTA — flips to a confirmation chip once approved.
                  Disabled while in flight, hidden once the section_number=0
                  row is already 'approved' (and replaced with the chip) so
                  re-clicking can't double-fire the notification. */}
              {fullNarrationApproved ? (
                <span
                  className="text-[10px] px-2 py-0.5 rounded font-medium flex items-center gap-1"
                  style={{ background: 'rgba(34,197,94,0.18)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.4)' }}
                  title="Narrator notified"
                >
                  ✓ Approved
                </span>
              ) : (
                <button
                  onClick={handleApproveFull}
                  disabled={approvingFull}
                  className="text-[10px] px-2 py-0.5 rounded font-medium text-white cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                  style={{ background: '#22c55e' }}
                  title="Approve this narration and notify the narrator"
                >
                  {approvingFull ? 'Approving…' : '✓ Approve'}
                </button>
              )}
            </div>
          </div>
          {reviewingTakeId === activeAssignment.full_audio_take_id ? (
            <div className="pt-2">
              <TakeReview
                takeId={activeAssignment.full_audio_take_id}
                audioUrl={`/api/narrator/takes/${activeAssignment.full_audio_take_id}/audio`}
                scriptText={realSections.map(s => s.script_text).filter(Boolean).join('\n\n')}
                initialDurationMs={activeAssignment.full_audio_duration_seconds ? activeAssignment.full_audio_duration_seconds * 1000 : null}
                listUrl={`/api/narrator/takes/${activeAssignment.full_audio_take_id}/comments`}
                itemUrl={(id) => `/api/narrator/take-comments/${id}`}
                author={{ name: 'Owner', color: '#06b6d4', role: 'owner' }}
                canDeleteAny
                initialHighlightCommentId={
                  // Only pass the inbox deep-link target when this TakeReview
                  // matches the requested take — keeps the comment-highlight
                  // bound to the correct surface even if a per-section
                  // TakeReview is also mounted below.
                  initialReviewTakeId === activeAssignment.full_audio_take_id ? initialCommentId : undefined
                }
                teleprompterAlignment={
                  // In synced mode we always pass the new teleprompter
                  // (with `alignment: null` when not ready) so the
                  // reviewer never gets the classic ScriptFollow look
                  // mid-flight. Classic mode leaves this undefined.
                  syncMode === 'synced'
                    ? {
                        sections: realSections.map(s => ({ label: s.label, script_text: s.script_text })),
                        alignment: alignmentState.alignment,
                      }
                    : undefined
                }
              />
            </div>
          ) : (
            <AudioPlayer src={activeAssignment.full_audio_url} compact />
          )}
        </div>
      )}

      {/* Sections grid */}
      <div className="space-y-3">
        {realSections.map(section => {
          const sc = STATUS_COLORS[section.status] || STATUS_COLORS.pending;
          const takes = section.takes || [];
          return (
            <div key={section.id} className="glass rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>{section.section_number}</span>
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{section.label || `Section ${section.section_number}`}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>~{section.estimated_duration_seconds}s</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full capitalize" style={{ background: sc.bg, color: sc.text }}>{section.status}</span>
              </div>

              {/* Script preview */}
              <p className="text-xs mb-3 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{section.script_text.length > 150 ? section.script_text.slice(0, 150) + '...' : section.script_text}</p>

              {/* Takes */}
              {takes.length > 0 ? (
                <div className="space-y-2">
                  {takes.map((take: Take) => {
                    const reviewing = reviewingTakeId === take.id;
                    return (
                      <div key={take.id} className="rounded-lg" style={{ background: 'var(--bg-primary)', border: take.id === section.approved_take_id ? '1px solid #22c55e' : '1px solid transparent' }}>
                        <div className="flex items-center gap-2 p-2">
                          <AudioPlayer src={take.audio_url} label={`Take ${take.take_number}`} compact />
                          <div className="flex items-center gap-1">
                            {[1, 2, 3, 4, 5].map(star => (
                              <button key={star} onClick={() => handleRateTake(take.id, star, section.id)} className="text-xs cursor-pointer" style={{ color: take.rating && take.rating >= star ? '#eab308' : 'var(--text-muted)' }}>
                                {take.rating && take.rating >= star ? '★' : '☆'}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={() => handleDownload(take.id, `${filenameBase}-section-${section.section_number}-take-${take.take_number}`)}
                            className="text-[10px] px-1.5 py-0.5 rounded transition-colors cursor-pointer flex items-center"
                            style={{ color: '#a78bfa', background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.3)' }}
                            title={`Download Take ${take.take_number}`}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="7 10 12 15 17 10" />
                              <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                          </button>
                          <button
                            onClick={() => setReviewingTakeId(reviewing ? null : take.id)}
                            className="text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer flex items-center gap-1.5"
                            style={{
                              background: reviewing ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.1)',
                              color: '#a78bfa',
                              border: '1px solid rgba(124,58,237,0.3)',
                            }}
                            title={reviewing ? 'Close review panel' : `Open the timestamped review${(take.unresolved_count ?? 0) > 0 ? ` — ${take.unresolved_count} unresolved` : ''}`}
                          >
                            {reviewing ? '▾ Hide review' : '▸ Review & comment'}
                            {!reviewing && (take.unresolved_count ?? 0) > 0 && (
                              <span
                                className="text-[9px] px-1 py-0.5 rounded-full font-bold"
                                style={{
                                  background: 'rgba(167,139,250,0.5)',
                                  color: '#fff',
                                  minWidth: 14,
                                  textAlign: 'center',
                                }}
                              >
                                {take.unresolved_count}
                              </span>
                            )}
                          </button>
                          {section.status !== 'approved' && (
                            <button onClick={() => handleApproveSection(section.id, take.id)} className="text-[10px] px-2 py-0.5 rounded text-white cursor-pointer" style={{ background: '#22c55e' }}>Approve</button>
                          )}
                        </div>

                        {reviewing && (
                          <div className="px-3 pb-3" style={{ borderTop: '1px solid var(--border)' }}>
                            <div className="pt-3">
                              <TakeReview
                                takeId={take.id}
                                // Use the same-origin audio proxy so
                                // wavesurfer's fetch doesn't need R2 CORS
                                // configured, and so the URL doesn't carry
                                // a presign expiry mid-review-session.
                                audioUrl={`/api/narrator/takes/${take.id}/audio`}
                                scriptText={section.script_text}
                                initialDurationMs={take.duration_seconds ? take.duration_seconds * 1000 : null}
                                listUrl={`/api/narrator/takes/${take.id}/comments`}
                                itemUrl={(id) => `/api/narrator/take-comments/${id}`}
                                author={{ name: 'Owner', color: '#06b6d4', role: 'owner' }}
                                canDeleteAny
                                initialHighlightCommentId={
                                  initialReviewTakeId === take.id ? initialCommentId : undefined
                                }
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {section.status !== 'approved' && (
                    <button onClick={() => handleRetakeSection(section.id)} className="text-[10px] flex items-center gap-1 cursor-pointer" style={{ color: '#ef4444' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                      Request retake
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-xs italic" style={{ color: 'var(--text-muted)' }}>Waiting for narrator to upload...</p>
              )}
            </div>
          );
        })}
      </div>

      {showAssign && (
        <AssignDialog
          projectId={projectId}
          scriptId={scriptId}
          scriptText={scriptText}
          scriptVersion={scriptVersion}
          onClose={() => setShowAssign(false)}
          onAssigned={handleAssigned}
        />
      )}
    </div>
  );
}
