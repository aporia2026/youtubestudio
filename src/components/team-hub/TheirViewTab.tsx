'use client';

import { useMemo, useState } from 'react';
import type { RosterEntry } from '@/lib/team-hub-types';

/**
 * Their view tab — embeds the team member's actual portal in an iframe
 * so the owner can sanity-check what they see. Read-only preview by
 * default per the plan; the per-action "Act as them" escalation lives
 * inside the heavy embedded surfaces (commit 9), not here.
 *
 * Per role:
 *   - narrator: /narrator/[personal_token] (their full portal)
 *   - editor:   /editor/[personal_token]   (their assignment list)
 *   - reviewer / client: no personal portal; their access is per-project
 *     review share links. Show an explanation pointing back to the Tasks
 *     tab where each link is listed and individually previewable.
 *   - channel_editor: no portal; render a placeholder linking to
 *     /schedule?editor=<id> — the closest thing to "their view" is the
 *     filtered schedule.
 *
 * iframe sandbox keeps scripts + same-origin (so cookies the portal
 * needs survive) + forms (so toggles in their portal still work for
 * preview purposes), but blocks `allow-top-navigation` so a malicious
 * portal page can't redirect the parent window.
 */

type PortalTarget =
  | { kind: 'iframe'; url: string; label: string }
  | { kind: 'no-portal'; reason: string };

function resolvePortalTarget(entry: RosterEntry): PortalTarget {
  if (entry.kind === 'channel_editor') {
    // Channel editors don't have a personal portal — the closest thing
    // is the schedule view filtered to them. Strip the synthetic
    // composite id back to the underlying channel_editors.id (left of
    // the '@'). team-hub-db.ts produced the composite as `<editor>@<channel>`.
    const [editorId] = entry.id.split('@');
    return {
      kind: 'iframe',
      url: editorId ? `/schedule?editor=${editorId}` : '/schedule',
      label: 'Their schedule slice',
    };
  }
  if (!entry.personal_token) {
    return { kind: 'no-portal', reason: 'This collaborator has no personal token yet.' };
  }
  if (entry.roles.includes('narrator')) {
    return { kind: 'iframe', url: `/narrator/${entry.personal_token}`, label: 'Narrator portal' };
  }
  if (entry.roles.includes('editor')) {
    return { kind: 'iframe', url: `/editor/${entry.personal_token}`, label: 'Editor portal' };
  }
  return {
    kind: 'no-portal',
    reason:
      'Reviewers and clients have per-project review links instead of a personal portal. Open the Tasks tab to see and visit each link.',
  };
}

interface TheirViewTabProps {
  entry: RosterEntry;
}

export function TheirViewTab({ entry }: TheirViewTabProps) {
  const target = useMemo(() => resolvePortalTarget(entry), [entry]);
  const [reloadKey, setReloadKey] = useState(0);

  if (target.kind === 'no-portal') {
    return (
      <div className="px-6 py-10">
        <div
          className="rounded-xl p-6 text-center"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        >
          <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            No personal portal
          </h3>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {target.reason}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col">
      {/* Header strip with the read-only pill, the URL, and a reload button. */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded"
            style={{ background: 'rgba(124,58,237,0.22)', color: '#c4b5fd', border: '1px solid rgba(124,58,237,0.4)' }}
          >
            Read-only preview
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {target.label}
          </span>
          <code className="text-[11px] truncate" style={{ color: 'var(--text-muted)', maxWidth: 320 }}>
            {target.url}
          </code>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="text-[11px] px-2 py-1 rounded-md font-medium"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            title="Refresh the preview"
          >
            Reload
          </button>
          <a
            href={target.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] px-2 py-1 rounded-md font-medium"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            title="Open the portal in a new tab"
          >
            Open ↗
          </a>
        </div>
      </div>

      {/* The iframe itself.
          - sandbox lets the portal load and run as it does in a real
            browser tab (scripts, forms, same-origin so cookies / fetch
            work) but blocks top-nav escape and popups.
          - referrerPolicy is no-referrer so the portal can't infer it's
            being embedded by team-hub from a Referer header. */}
      <iframe
        key={reloadKey}
        src={target.url}
        title={target.label}
        sandbox="allow-same-origin allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="flex-1 w-full"
        style={{ border: 0, background: 'var(--bg-primary)' }}
      />
    </div>
  );
}
