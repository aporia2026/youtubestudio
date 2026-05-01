'use client';

import { useState, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';

export default function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        setDone(true);
        setTimeout(() => router.push('/login'), 2000);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not reset password. The link may have expired.');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden cyber-grid">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="relative z-10 w-full max-w-md mx-4"
      >
        <div className="gradient-border p-8">
          <div className="text-center mb-6">
            <h1 className="text-xl font-bold gradient-text mb-2">
              {done ? 'Password updated' : 'Choose a new password'}
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              {done ? 'Redirecting you to sign in…' : 'Pick something at least 12 characters long.'}
            </p>
          </div>

          {!done && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                  New password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="input-field"
                  autoFocus
                  autoComplete="new-password"
                  required
                  minLength={12}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                  Confirm password
                </label>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  className="input-field"
                  autoComplete="new-password"
                  required
                  minLength={12}
                />
              </div>

              {error && (
                <div className="text-sm px-4 py-3 rounded-lg"
                  style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || password.length < 12 || password !== confirm}
                className="btn-primary w-full justify-center"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {loading ? 'Saving...' : 'Set new password'}
              </button>
            </form>
          )}

          <div className="mt-6 text-center text-xs">
            <Link href="/login" style={{ color: 'var(--text-muted)' }} className="hover:underline">
              ← Back to sign in
            </Link>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
