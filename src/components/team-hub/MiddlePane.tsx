'use client';

import { motion } from 'framer-motion';
import {
  type RosterEntry,
  type TeamHubTab,
  TEAM_HUB_TABS,
} from '@/lib/team-hub-types';

/**
 * Middle pane of /team-hub. Shows a header for the selected person plus
 * a tab strip. Each tab's content is delegated to a child component
 * passed in via `children` so the orchestrator (page.tsx) decides which
 * to mount based on `tab` state.
 *
 * When no person is selected, renders the empty state. The roster on
 * the left always has at least one entry once data has loaded — the
 * empty state appears only when the workspace genuinely has no one in
 * the roster yet.
 */

const TAB_LABELS: Record<TeamHubTab, string> = {
  'tasks': 'Tasks',
  'their-view': 'Their view',
  'activity': 'Activity',
  'settings': 'Settings',
};

const ROLE_CHIP_COLORS: Record<string, { bg: string; text: string }> = {
  narrator: { bg: 'rgba(124,58,237,0.15)', text: '#a78bfa' },
  editor: { bg: 'rgba(59,130,246,0.15)', text: '#60a5fa' },
  reviewer: { bg: 'rgba(6,182,212,0.15)', text: '#67e8f9' },
  client: { bg: 'rgba(234,179,8,0.15)', text: '#facc15' },
  channel_editor: { bg: 'rgba(245,158,11,0.15)', text: '#fbbf24' },
};

function timeAgo(s: string | null): string {
  if (!s) return 'Never accessed';
  const diff = Date.now() - new Date(s).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Build the team-member's portal URL. NULL when the entry doesn't have
 * one (channel editors don't have a personal portal).
 */
function portalUrl(entry: RosterEntry): string | null {
  if (entry.kind !== 'collaborator') return null;
  if (!entry.personal_token) return null;
  // Pick the URL most useful to the team member. Narrator portal first
  // (highest-traffic role); editor portal next; otherwise no portal.
  if (entry.roles.includes('narrator')) return `/narrator/${entry.personal_token}`;
  if (entry.roles.includes('editor')) return `/editor/${entry.personal_token}`;
  return null;
}

interface MiddlePaneProps {
  entry: RosterEntry | null;
  tab: TeamHubTab;
  onTabChange: (tab: TeamHubTab) => void;
  /** Tab-specific content rendered by the orchestrator. */
  children: React.ReactNode;
}

export function MiddlePane({ entry, tab, onTabChange, children }: MiddlePaneProps) {
  if (!entry) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <div className="text-center px-6">
          <div
            className="mx-auto mb-3 w-12 h-12 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(124,58,237,0.12)', color: '#a78bfa' }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            Pick someone from the roster
          </h3>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Their tasks, view, activity, and settings appear here.
          </p>
        </div>
      </div>
    );
  }

  const url = portalUrl(entry);

  return (
    <div className="flex-1 flex flex-col min-w-0" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div
        className="px-6 pt-5 pb-0 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
              style={{ background: entry.color }}
            >
              {(entry.name || '?')[0]?.toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  {entry.name}
                </h1>
                {entry.roles.map((r) => {
                  const cc = ROLE_CHIP_COLORS[r] || ROLE_CHIP_COLORS.client;
                  return (
                    <span
                      key={r}
                      className="text-[10px] px-2 py-0.5 rounded-full font-medium capitalize"
                      style={{ background: cc.bg, color: cc.text }}
                    >
                      {r === 'channel_editor' ? 'Channel editor' : r}
                    </span>
                  );
                })}
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {entry.email ?? 'No email'} · Last activity: {timeAgo(entry.last_activity)}
                {entry.channel_name ? ` · ${entry.channel_name}` : ''}
              </div>
            </div>
          </div>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] px-2.5 py-1 rounded-md font-medium shrink-0"
              style={{
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
              title="Open the team member's own portal in a new tab"
            >
              Open portal ↗
            </a>
          )}
        </div>

        {/* Tab strip */}
        <div className="flex gap-0">
          {TEAM_HUB_TABS.map((t) => {
            const active = tab === t;
            return (
              <button
                key={t}
                onClick={() => onTabChange(t)}
                className="relative text-xs px-3 py-2 font-medium transition-colors"
                style={{
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {TAB_LABELS[t]}
                {active && (
                  <motion.div
                    layoutId="team-hub-tab-underline"
                    className="absolute left-0 right-0 -bottom-px h-0.5"
                    style={{ background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
