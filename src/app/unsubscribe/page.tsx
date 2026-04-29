'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

export default function UnsubscribePage() {
  return (
    <Suspense fallback={
      <div className="max-w-md w-full p-8 rounded-2xl text-center" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    }>
      <UnsubscribeInner />
    </Suspense>
  );
}

function UnsubscribeInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get('t');
  const [status, setStatus] = useState<'idle' | 'loading' | 'unsubscribed' | 'resubscribed' | 'error'>('idle');
  const [name, setName] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setStatus('error'); setErrorMsg('Missing unsubscribe token.'); return; }
    setStatus('loading');
    fetch('/api/notifications/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, enabled: false }),
    })
      .then(async r => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed');
        setName(data.name || null);
        setStatus('unsubscribed');
      })
      .catch((e) => { setStatus('error'); setErrorMsg(e.message); });
  }, [token]);

  async function resubscribe() {
    if (!token) return;
    setStatus('loading');
    try {
      const r = await fetch('/api/notifications/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, enabled: true }),
      });
      if (!r.ok) throw new Error('Failed');
      setStatus('resubscribed');
    } catch {
      setStatus('error');
      setErrorMsg('Failed to resubscribe');
    }
  }

  return (
    <div className="max-w-md w-full p-8 rounded-2xl text-center" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      </div>

      {status === 'loading' && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Updating your preferences…</p>
      )}

      {status === 'unsubscribed' && (
        <>
          <h1 className="text-xl font-bold mb-2">You&apos;re unsubscribed</h1>
          <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
            {name ? `${name}, you ` : 'You '}won&apos;t receive YT Studio email notifications anymore.
          </p>
          <button
            onClick={resubscribe}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white cursor-pointer"
            style={{ background: 'rgba(124,58,237,0.2)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.4)' }}
          >
            Changed your mind? Re-subscribe
          </button>
        </>
      )}

      {status === 'resubscribed' && (
        <>
          <h1 className="text-xl font-bold mb-2">You&apos;re back in</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            We&apos;ll resume sending you notifications.
          </p>
        </>
      )}

      {status === 'error' && (
        <>
          <h1 className="text-xl font-bold mb-2">Something went wrong</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{errorMsg}</p>
        </>
      )}
    </div>
  );
}
