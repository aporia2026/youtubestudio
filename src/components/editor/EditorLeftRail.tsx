'use client';

/**
 * Editor left rail — Phase 3 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Sits in the `leftRail` slot of `EditorChrome`. Collapsed to a
 * 64 px icon rail by default; clicking an icon expands the drawer
 * (the chrome grid switches columns to the wider layout via the
 * `editor:rail-toggle` custom event). Six tabs:
 *
 *   - Shots       — list of every shot with thumbnail + script
 *   - Media       — project's generated images + clips + VO + music
 *   - Audio       — voiceover picker, alignment, music
 *   - Captions    — caption summary + regen
 *   - AI Tools    — Drift report, Overlays, Regen captions, Regen VO,
 *                   Regen doc — the global AI affordances
 *   - Settings    — project flags (animateScenes, lower-thirds,
 *                   overlays-disabled)
 *
 * The component is intentionally thin — it owns the active-tab
 * state and the drawer chrome; tab bodies are passed in as
 * `slots`. EditorClient owns the live data; this component only
 * orchestrates which tab is visible.
 */

import { useEffect, useState } from 'react';
import {
  Settings as SettingsIcon,
  Film,
  Image as ImageIcon,
  Music2,
  Sparkles,
  Subtitles,
  type LucideIcon,
} from 'lucide-react';

export type LeftRailTabId = 'shots' | 'media' | 'audio' | 'captions' | 'ai' | 'settings';

export interface LeftRailTabSpec {
  id: LeftRailTabId;
  label: string;
  icon: LucideIcon;
}

const TABS: LeftRailTabSpec[] = [
  { id: 'shots', label: 'Shots', icon: Film },
  { id: 'media', label: 'Media', icon: ImageIcon },
  { id: 'audio', label: 'Audio', icon: Music2 },
  { id: 'captions', label: 'Captions', icon: Subtitles },
  { id: 'ai', label: 'AI Tools', icon: Sparkles },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

interface EditorLeftRailProps {
  /** Tab bodies, keyed by tab id. Only the active tab's body
   *  renders — others stay unmounted to avoid running effects in
   *  panels the user isn't looking at. */
  slots: Partial<Record<LeftRailTabId, React.ReactNode>>;
  /** Optional initial tab. Defaults to 'shots'. */
  initialTab?: LeftRailTabId;
}

export function EditorLeftRail({ slots, initialTab = 'shots' }: EditorLeftRailProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<LeftRailTabId>(initialTab);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Notify the chrome that the rail's drawer state changed so it
  // can swap the grid template column width. The chrome owns the
  // layout; this component owns the tab state.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('editor:rail-toggle', { detail: { open: drawerOpen } }),
    );
  }, [drawerOpen]);

  function onIconClick(tab: LeftRailTabId) {
    if (activeTab === tab && drawerOpen) {
      setDrawerOpen(false);
      console.info('[editor leftrail] close', { from: tab });
      return;
    }
    setActiveTab(tab);
    setDrawerOpen(true);
    console.info('[editor leftrail] switch', { to: tab });
  }

  return (
    <div className="h-full flex" style={{ minHeight: 0 }}>
      {/* Icon rail — always visible. 64px wide. */}
      <nav
        className="flex flex-col items-center py-2 gap-1"
        style={{ width: 56, flexShrink: 0 }}
        aria-label="Editor tools"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id && drawerOpen;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onIconClick(tab.id)}
              className="editor-icon-btn"
              aria-pressed={isActive}
              aria-label={tab.label}
              title={tab.label}
              style={{ width: 40, height: 40 }}
            >
              <Icon size={18} strokeWidth={2} />
            </button>
          );
        })}
      </nav>

      {/* Drawer — only renders when open. Its width is fixed by the
          chrome's grid template; this component fills it. */}
      {drawerOpen && (
        <div
          className="editor-scroll flex-1"
          style={{
            minWidth: 0,
            overflow: 'auto',
            borderLeft: '1px solid var(--editor-edge)',
            padding: 12,
          }}
        >
          <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--fg-muted)' }}>
            {TABS.find((t) => t.id === activeTab)?.label}
          </div>
          {slots[activeTab] ?? (
            <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>
              Nothing here yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
