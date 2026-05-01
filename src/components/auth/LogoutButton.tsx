'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
