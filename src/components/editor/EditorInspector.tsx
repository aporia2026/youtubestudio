'use client';

/**
 * Tabbed inspector — Phase 4 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Sits in the `inspector` slot of `EditorChrome`. Three tabs:
 *
 *   - Shot       — every per-shot field (script, prompts, image,
 *                  clip, overlay). The existing `ShotInspector`
 *                  body lives here. Active when a shot tile is
 *                  selected.
 *   - Audio      — voiceover URL, alignment status, mute master,
 *                  music URL. Active when the timeline's audio
 *                  lane is selected (Phase 5).
 *   - Captions   — caption count, regen, per-segment edit. Active
 *                  when a caption pill is selected (Phase 5).
 *
 * The tab auto-switches based on the selection kind: a shot
 * selection picks Shot, an audio-lane click picks Audio, a
 * caption-pill click picks Captions. Manual tab switching is
 * always possible via the tab strip — auto-switch just sets the
 * default. The user can override by clicking a tab.
 *
 * Per-project doc settings (animateScenes, lower-thirds, etc.)
 * surface behind a kebab `⋮` menu in the inspector header, not as
 * a tab. Confirmed by the plan's resolved open-questions section.
 */

import { useEffect, useState } from 'react';
import { MoreVertical } from 'lucide-react';

export type InspectorTabId = 'shot' | 'audio' | 'captions';

interface EditorInspectorProps {
  /** Tab bodies. Only the active one renders. */
  slots: Partial<Record<InspectorTabId, React.ReactNode>>;
  /** The kind of selection currently active. Drives the
   *  auto-selected tab on each transition. `null` means "no
   *  selection" — the inspector renders an empty-state. */
  selectionKind: InspectorTabId | null;
  /** Optional: render extra content inside the kebab popover. The
   *  parent assembles the doc-level controls (flag toggles etc.)
   *  and passes them in so the inspector stays presentational. */
  kebabContent?: React.ReactNode;
}

const TABS: Array<{ id: InspectorTabId; label: string }> = [
  { id: 'shot', label: 'Shot' },
  { id: 'audio', label: 'Audio' },
  { id: 'captions', label: 'Captions' },
];

export function EditorInspector({
  slots,
  selectionKind,
  kebabContent,
}: EditorInspectorProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<InspectorTabId>('shot');
  const [manualOverride, setManualOverride] = useState(false);
  const [kebabOpen, setKebabOpen] = useState(false);

  // Auto-switch to the tab matching the selection kind UNLESS the
  // user has manually overridden the tab during this selection.
  // Selection-kind changes reset the override so a new selection
  // gets the natural default tab again.
  useEffect(() => {
    if (selectionKind && !manualOverride) {
      setActiveTab(selectionKind);
      console.info('[editor inspector tab] switch', {
        to: selectionKind,
        trigger: 'selection',
      });
    }
  }, [selectionKind, manualOverride]);

  // Reset the override when the selection kind changes.
  useEffect(() => {
    setManualOverride(false);
  }, [selectionKind]);

  // Close the kebab popover on outside-click / Escape.
  useEffect(() => {
    if (!kebabOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setKebabOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kebabOpen]);

  return (
    <div className="h-full flex flex-col" style={{ minHeight: 0 }}>
      {/* Inspector header — tab strip + kebab. */}
      <div
        className="flex items-center px-2 h-9 shrink-0"
        style={{ borderBottom: '1px solid var(--editor-edge)' }}
      >
        <div role="tablist" className="flex items-center gap-1 flex-1">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  setManualOverride(true);
                  console.info('[editor inspector tab] switch', {
                    to: tab.id,
                    trigger: 'manual',
                  });
                }}
                className="text-[11px] px-2.5 py-1 rounded-md transition-colors"
                style={{
                  color: isActive ? 'var(--editor-accent)' : 'var(--fg-muted)',
                  background: isActive ? 'var(--editor-accent-soft)' : 'transparent',
                  fontWeight: isActive ? 600 : 500,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {kebabContent && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setKebabOpen((v) => !v)}
              className="editor-icon-btn"
              aria-label="Project settings"
              aria-expanded={kebabOpen}
              title="Project settings"
              style={{ width: 28, height: 28 }}
            >
              <MoreVertical size={14} strokeWidth={2} />
            </button>
            {kebabOpen && (
              <>
                {/* Click-away catcher — covers the rest of the
                    viewport so clicking outside closes the popover.
                    z-index keeps it above other inspector content
                    but below the popover itself. */}
                <div
                  className="fixed inset-0"
                  style={{ zIndex: 40 }}
                  onClick={() => setKebabOpen(false)}
                />
                <div
                  className="absolute right-0 mt-1 editor-panel p-2"
                  style={{
                    width: 280,
                    zIndex: 50,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                  }}
                  role="menu"
                >
                  {kebabContent}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Active tab body — scrollable region. */}
      <div className="flex-1 editor-scroll" style={{ overflow: 'auto', minHeight: 0 }}>
        {slots[activeTab] ?? (
          <div className="p-4 text-xs text-center" style={{ color: 'var(--fg-muted)' }}>
            {activeTab === 'shot'
              ? 'Select a shot on the timeline to inspect or edit it.'
              : activeTab === 'audio'
                ? 'Click the audio lane on the timeline to inspect the voiceover.'
                : 'Click a caption pill on the timeline to inspect or edit its text.'}
          </div>
        )}
      </div>
    </div>
  );
}
