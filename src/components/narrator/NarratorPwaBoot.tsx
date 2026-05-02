"use client";

/**
 * Narrator portal PWA bootstrapper.
 *
 * Runs once on portal mount:
 *   1. Registers `/narrator-sw.js` with scope `/narrator/` so the worker
 *      ONLY intercepts narrator-portal traffic. The rest of the app is
 *      untouched — important because narrators and the main editor app
 *      have very different caching needs.
 *   2. Listens for `beforeinstallprompt` (Android / desktop Chromium).
 *      When fired, shows a small "Install" pill that triggers the native
 *      prompt on click.
 *   3. Detects iOS Safari and shows the "tap Share → Add to Home Screen"
 *      hint instead — iOS doesn't expose beforeinstallprompt at all.
 *   4. Suppresses the install hint when already in standalone mode
 *      (display-mode: standalone OR navigator.standalone on iOS).
 *
 * Renders a single small install pill in the top-right when applicable.
 * Returns null otherwise — does NOT render any visible content unless
 * an install path is available.
 */
import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function NarratorPwaBoot() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [installed, setInstalled] = useState(false);

  // 1. Register the service worker.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        await navigator.serviceWorker.register('/narrator-sw.js', { scope: '/narrator/' });
      } catch {
        // SW registration failure is non-fatal — the portal still works.
      }
    })();
    return () => ctrl.abort();
  }, []);

  // 2. Are we already running as an installed app?
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      // iOS reports standalone via this non-standard property.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (navigator as any).standalone === true;
    setInstalled(Boolean(standalone));
  }, []);

  // 3. Capture the native install prompt (Chromium).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    const onInstalled = () => {
      setInstalled(true);
      setInstallEvent(null);
    };
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // 4. iOS detection — beforeinstallprompt isn't fired on Safari; show
  //    a hint instead. We only show the hint once per device (cleared
  //    by the user clicking "got it" — stored in localStorage).
  useEffect(() => {
    if (typeof window === 'undefined' || installed) return;
    const ua = navigator.userAgent || '';
    const isIos = /iPhone|iPad|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    if (!isIos) return;
    try {
      if (window.localStorage.getItem('narrator_pwa_ios_hint_dismissed') === '1') return;
    } catch {
      /* private mode — show the hint anyway */
    }
    setIosHint(true);
  }, [installed]);

  if (installed) return null;

  if (installEvent) {
    return (
      <button
        type="button"
        onClick={async () => {
          try {
            await installEvent.prompt();
            const choice = await installEvent.userChoice;
            if (choice.outcome === 'accepted') setInstallEvent(null);
          } catch {
            /* user dismissed */
          }
        }}
        className="fixed top-3 right-3 z-50 text-xs px-3 py-1.5 rounded-full"
        style={{
          background: 'rgba(168,85,247,0.18)',
          color: '#c084fc',
          border: '1px solid rgba(168,85,247,0.4)',
          backdropFilter: 'blur(6px)',
        }}
      >
        ＋ Install app
      </button>
    );
  }

  if (iosHint) {
    return (
      <div
        className="fixed bottom-3 left-3 right-3 z-50 rounded-lg p-3 text-xs"
        style={{
          background: 'rgba(13,13,18,0.95)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          backdropFilter: 'blur(8px)',
          maxWidth: 380,
          margin: '0 auto',
        }}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <div className="font-semibold mb-0.5">Install for offline narration</div>
            <div style={{ color: 'var(--text-muted)' }}>
              Tap the Share icon in Safari, then <strong>Add to Home Screen</strong>. The portal will work offline for any script you&apos;ve already opened.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              try {
                window.localStorage.setItem('narrator_pwa_ios_hint_dismissed', '1');
              } catch {
                /* ignore */
              }
              setIosHint(false);
            }}
            className="text-xs px-2 py-1 rounded shrink-0"
            style={{ background: 'rgba(120,120,120,0.15)', color: 'var(--text-secondary)' }}
          >
            Got it
          </button>
        </div>
      </div>
    );
  }

  return null;
}
