'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { TakeReview } from '@/components/narrator/TakeReview';
import { ReviewPage } from '@/components/review/ReviewPage';
import { EditorTab } from '@/components/editor/EditorTab';
import type { SurfaceDescriptor } from '@/lib/team-hub-types';
import type { RosterEntry } from '@/lib/team-hub-types';

/**
 * Mounts the right-pane content for a given SurfaceDescriptor. Each kind
 * of surface delegates to a pre-existing prop-driven component:
 *
 *   - takes:<takeId>      → <TakeReview ... />, hydrated via /api/team-hub/takes/[takeId]
 *   - review:<projectId>  → <ReviewPage ownerProjectId={...} />
 *                            (the descriptor stores the PROJECT id here, not the
 *                            version id, because ReviewPage internally lists every
 *                            version + lets the user pick. Surfacing a single
 *                            version would lock the user out of their own version
 *                            history.)
 *   - editor-tab:<projId> → <EditorTab projectId={...} />
 *   - script:<projectId>  → iframe of /projects/<projectId> (the project page
 *                            is where script editing happens today; iframe is the
 *                            zero-refactor embed strategy committed in plan §
 *                            "Embeddable-component refactor list" with the
 *                            adjustment landed in commit 2 once the components
 *                            were verified prop-driven).
 *
 * The owner-side caller passes the right action context (acting as
 * themselves by default). The "Act as <name>" escalation lands in
 * commit 9 by adding a per-action toggle inside TakeReview / ReviewPage.
 */

interface SurfaceMounterProps {
  surface: SurfaceDescriptor;
  /** Owner identity passed through to embedded surfaces that need to label
   *  the comment author. */
  owner: { name: string; color: string };
  /** Currently selected roster entry. Used to gate + parameterise the
   *  "Act as <name>" escalation — only collaborators with the right role
   *  for the surface kind can be acted as. NULL = no act-as control. */
  targetEntry: RosterEntry | null;
}

export function SurfaceMounter({ surface, owner, targetEntry }: SurfaceMounterProps) {
  switch (surface.kind) {
    case 'takes':
      return <TakeMount takeId={surface.id} owner={owner} targetEntry={targetEntry} />;
    case 'review':
      return <ReviewMount projectId={surface.id} />;
    case 'editor-tab':
      return <EditorMount projectId={surface.id} />;
    case 'script':
      return <ScriptIframe projectId={surface.id} />;
  }
}

// ── Take surface ────────────────────────────────────────────────────

interface TakeBundle {
  take: { id: string; audio_url: string; duration_ms: number | null };
  section: { label: string | null; number: number; script_text: string };
  assignment: { id: string };
  narrator: { name: string; color: string };
}

function TakeMount({
  takeId,
  owner,
  targetEntry,
}: {
  takeId: string;
  owner: { name: string; color: string };
  targetEntry: RosterEntry | null;
}) {
  const [bundle, setBundle] = useState<TakeBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Act as them" toggle. Only available when the selected roster entry
  // is a collaborator with the narrator role — that's whose comments live
  // on take threads. Channel editors / reviewers don't post here.
  const canActAs = !!(
    targetEntry &&
    targetEntry.kind === 'collaborator' &&
    targetEntry.roles.includes('narrator')
  );
  const [actingAs, setActingAs] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBundle(null);
    setError(null);
    setActingAs(false); // reset whenever the take changes
    fetch(`/api/team-hub/takes/${takeId}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as TakeBundle;
        if (!cancelled) setBundle(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed');
      });
    return () => {
      cancelled = true;
    };
  }, [takeId]);

  if (error) {
    return (
      <div className="p-6 text-xs" style={{ color: '#fda4af' }}>
        {error}
      </div>
    );
  }
  if (!bundle) {
    return (
      <div className="p-6 text-xs" style={{ color: 'var(--text-muted)' }}>
        Loading take…
      </div>
    );
  }

  // URL/author selection — drives whether posts go through the team-hub
  // act-as routes (audited, written as the target) or the standard
  // owner-side routes (written as the owner).
  const listUrl = actingAs && targetEntry
    ? `/api/team-hub/act-as/${targetEntry.id}/takes/${bundle.take.id}/comments`
    : `/api/narrator/takes/${bundle.take.id}/comments`;
  const itemUrl = actingAs && targetEntry
    ? (commentId: string) => `/api/team-hub/act-as/${targetEntry.id}/take-comments/${commentId}`
    : (commentId: string) => `/api/narrator/take-comments/${commentId}`;
  const author =
    actingAs && targetEntry
      ? { name: targetEntry.name, color: targetEntry.color, role: 'narrator' as const }
      : { name: owner.name, color: owner.color, role: 'owner' as const };

  return (
    <div className="p-4">
      {canActAs && (
        <ActAsToggle
          targetName={targetEntry!.name}
          on={actingAs}
          onChange={(next) => {
            if (next) {
              const ok = window.confirm(
                `Acting as ${targetEntry!.name}. Every post + resolution in this panel will be written as them and recorded in the team-hub audit log. Continue?`,
              );
              if (!ok) return;
              toast.message(`Now acting as ${targetEntry!.name}`);
            }
            setActingAs(next);
          }}
        />
      )}
      <div className="mb-3">
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {bundle.section.label || `Section ${bundle.section.number}`} · {bundle.narrator.name}
        </div>
      </div>
      <TakeReview
        takeId={bundle.take.id}
        audioUrl={bundle.take.audio_url}
        scriptText={bundle.section.script_text}
        initialDurationMs={bundle.take.duration_ms}
        listUrl={listUrl}
        itemUrl={itemUrl}
        author={author}
        canDeleteAny={!actingAs}
      />
    </div>
  );
}

interface ActAsToggleProps {
  targetName: string;
  on: boolean;
  onChange: (next: boolean) => void;
}

function ActAsToggle({ targetName, on, onChange }: ActAsToggleProps) {
  return (
    <motion.div
      layout
      transition={{ type: 'spring', stiffness: 400, damping: 32 }}
      className="mb-3 rounded-lg p-3 flex items-center justify-between gap-3"
      style={{
        background: on ? 'rgba(239,68,68,0.08)' : 'var(--bg-secondary)',
        border: on ? '1px solid rgba(239,68,68,0.4)' : '1px solid var(--border)',
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold" style={{ color: on ? '#fda4af' : 'var(--text-primary)' }}>
          {on ? `⚠ Acting as ${targetName}` : `Post as you, or act as ${targetName}?`}
        </div>
        <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {on
            ? 'Every action here is logged in the audit trail as posted by you on their behalf.'
            : 'Toggle on to post comments and resolutions in their name.'}
        </div>
      </div>
      <button
        onClick={() => onChange(!on)}
        className="text-[11px] px-2.5 py-1 rounded-md font-medium shrink-0"
        style={{
          background: on ? '#ef4444' : 'rgba(255,255,255,0.04)',
          color: on ? '#fff' : 'var(--text-primary)',
          border: `1px solid ${on ? '#ef4444' : 'var(--border)'}`,
        }}
      >
        {on ? 'Stop acting' : `Act as ${targetName}`}
      </button>
    </motion.div>
  );
}

// ── Review surface ──────────────────────────────────────────────────

function ReviewMount({ projectId }: { projectId: string }) {
  return <ReviewPage ownerProjectId={projectId} />;
}

// ── Editor-tab surface ──────────────────────────────────────────────

function EditorMount({ projectId }: { projectId: string }) {
  return (
    <div className="p-4">
      <EditorTab projectId={projectId} />
    </div>
  );
}

// ── Script iframe ───────────────────────────────────────────────────

function ScriptIframe({ projectId }: { projectId: string }) {
  // Iframe the existing project page where script editing already lives.
  // The ?team-hub-embed=1 hint lets the page hide top-level chrome later
  // (no-op for now — page ignores unknown params).
  return (
    <iframe
      src={`/projects/${projectId}?team-hub-embed=1`}
      className="w-full h-full"
      style={{ border: 0, background: 'var(--bg-primary)' }}
      title="Project script editor"
    />
  );
}
