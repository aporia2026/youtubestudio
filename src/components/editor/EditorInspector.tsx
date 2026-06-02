'use client';

/**
 * Tabbed inspector — Phase 4 of
 * `_plans/2026-05-19-editor-real-nle-look.md`.
 *
 * Sits in the `inspector` slot of `EditorChrome`. Four tabs:
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
 *   - History    — chronological log of every B-roll (animation)
 *                  generation kickoff for this project. Read
 *                  from `/api/edit/[projectId]/generation-events`.
 *                  Click an entry to jump to that scene. Added
 *                  per `_plans/2026-05-23-editor-generation-history-log.md`.
 *
 * The tab auto-switches based on the selection kind: a shot
 * selection picks Shot, an audio-lane click picks Audio, a
 * caption-pill click picks Captions. Manual tab switching is
 * always possible via the tab strip — auto-switch just sets the
 * default. The user can override by clicking a tab.
 *
 * The History tab has no selection kind (it's not driven by a
 * timeline click); the parent uses `switchToTab` to fire a
 * one-time programmatic switch on the first generation of a
 * session — see header for that prop.
 *
 * Per-project doc settings (animateScenes, lower-thirds, etc.)
 * surface behind a kebab `⋮` menu in the inspector header, not as
 * a tab. Confirmed by the plan's resolved open-questions section.
 */

import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

export type InspectorTabId = 'shot' | 'audio' | 'captions' | 'history' | 'live';

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
  /** One-time programmatic tab switch. When `nonce` changes to a
   *  new value, the inspector force-switches to `tab` and clears
   *  the manual-override flag. Used by the parent to trigger
   *  signal-driven switches that don't come from a selection
   *  change (e.g. "open History on the first generate of the
   *  session"). The parent assigns a fresh nonce each time it
   *  wants the switch to fire; reusing the same nonce is a no-op,
   *  so a re-render of the parent without a new intent will not
   *  override the user's current tab choice. */
  switchToTab?: { tab: InspectorTabId; nonce: number } | null;
}

const TABS: Array<{ id: InspectorTabId; label: string }> = [
  { id: 'shot', label: 'Shot' },
  { id: 'live', label: 'Live' },
  { id: 'audio', label: 'Audio' },
  { id: 'captions', label: 'Captions' },
  { id: 'history', label: 'History' },
];

export function EditorInspector({
  slots,
  selectionKind,
  kebabContent,
  switchToTab,
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

  // Programmatic switch driven by `switchToTab.nonce`. The nonce
  // (not the whole object) is the dep — a parent re-render that
  // passes an unchanged nonce will not re-fire the switch, so the
  // user's manual tab choice survives unrelated re-renders. Also
  // clears the manual-override flag so a follow-up selection-kind
  // change can still auto-switch.
  const lastSwitchNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!switchToTab) return;
    if (lastSwitchNonceRef.current === switchToTab.nonce) return;
    lastSwitchNonceRef.current = switchToTab.nonce;
    setActiveTab(switchToTab.tab);
    setManualOverride(false);
    console.info('[editor inspector tab] switch', {
      to: switchToTab.tab,
      trigger: 'programmatic',
      nonce: switchToTab.nonce,
    });
  }, [switchToTab]);

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

      {/* Active tab body — scrollable region. A small framer-motion
          fade on tab change makes the inspector feel responsive
          without distracting on rapid toggles. */}
      <div className="flex-1 editor-scroll" style={{ overflow: 'auto', minHeight: 0 }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            {slots[activeTab] ?? (
              <div className="p-4 text-xs text-center" style={{ color: 'var(--fg-muted)' }}>
                {activeTab === 'shot'
                  ? 'Select a shot on the timeline to inspect or edit it.'
                  : activeTab === 'audio'
                    ? 'Click the audio lane on the timeline to inspect the voiceover.'
                    : activeTab === 'captions'
                      ? 'Click a caption pill on the timeline to inspect or edit its text.'
                      : 'No generations yet. Click Generate on any scene to start.'}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
