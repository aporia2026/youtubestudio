'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { wipeHistoryCaches } from '@/lib/history';

/**
 * POST /api/auth/logout, then push to /login. The route already clears the
 * session cookie server-side; the router.refresh() makes any cached server
 * components re-render under the now-absent session so private pages don't
 * briefly flash to the user mid-redirect.
 */
export function LogoutButton({
  className,
  style,
  label = 'Sign out',
}: {
  className?: string;
  style?: React.CSSProperties;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    // Wipe history caches BEFORE the logout fetch so even a fast
    // navigation can't leak the previous user's cached entries to
    // the next person on this browser. Defense-in-depth alongside
    // the per-cache scope envelope.
    wipeHistoryCaches();
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore — proceed to /login regardless */
    }
    router.push('/login');
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={className}
      style={style}
    >
      {busy ? 'Signing out…' : label}
    </button>
  );
}
