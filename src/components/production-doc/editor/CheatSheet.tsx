'use client';

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface CheatSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Keyboard cheat-sheet overlay for the production-doc editor view.
 * Triggered by pressing `?` from anywhere in the editor; dismissed by
 * pressing `?` again, `Esc`, or clicking the backdrop. Lists every
 * editor-specific shortcut so power users don't have to guess.
 *
 * Renders into `document.body` via portal so it sits above the rest of
 * the page — including any tool that's taking over the stage.
 */
export const CheatSheet: React.FC<CheatSheetProps> = ({ open, onClose }) => {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const overlay = (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#0f1115',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.10)',
          width: 'min(560px, 95vw)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
              Editor keyboard shortcuts
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Press <Kbd>?</Kbd> any time to reopen. <Kbd>Esc</Kbd> closes this overlay.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        <div style={{ padding: 18, display: 'grid', gridTemplateColumns: '1fr', gap: 18 }}>
          <Group title="Navigation">
            <Row keys={['←', '→']} label="Previous / next section" />
            <Row keys={['Home', 'End']} label="First / last section" />
          </Group>
          <Group title="Inspector">
            <Row keys={['1']} label="Open B-roll & Image" />
            <Row keys={['2']} label="Open Overlay" />
            <Row keys={['3']} label="Open Section settings" />
          </Group>
          <Group title="Editing">
            <Row keys={['Cmd', 'Z']} altKeys={['Ctrl', 'Z']} label="Undo last field change" />
            <Row keys={['Cmd', '⇧', 'Z']} altKeys={['Ctrl', '⇧', 'Z']} label="Redo" />
          </Group>
          <Group title="Tools">
            <Row keys={['Esc']} label="Close stage tool / return to preview" />
            <Row keys={['?']} label="Show this cheat sheet" />
          </Group>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
};

const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <div
      style={{
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        color: 'var(--text-muted)',
        marginBottom: 6,
      }}
    >
      {title}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
  </div>
);

const Row: React.FC<{ keys: string[]; altKeys?: string[]; label: string }> = ({ keys, altKeys, label }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
    <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {keys.map((k, i) => (
        <React.Fragment key={`a-${i}`}>
          {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>+</span>}
          <Kbd>{k}</Kbd>
        </React.Fragment>
      ))}
      {altKeys && (
        <>
          <span style={{ color: 'var(--text-muted)', fontSize: 10, margin: '0 4px' }}>/</span>
          {altKeys.map((k, i) => (
            <React.Fragment key={`b-${i}`}>
              {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>+</span>}
              <Kbd>{k}</Kbd>
            </React.Fragment>
          ))}
        </>
      )}
    </span>
  </div>
);

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd
    style={{
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 11,
      padding: '2px 6px',
      borderRadius: 4,
      background: 'rgba(255,255,255,0.06)',
      color: 'var(--text)',
      border: '1px solid rgba(255,255,255,0.12)',
      boxShadow: '0 1px 0 rgba(0,0,0,0.4)',
      minWidth: 18,
      textAlign: 'center',
    }}
  >
    {children}
  </kbd>
);
