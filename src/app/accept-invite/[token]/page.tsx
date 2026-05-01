'use client';

import { useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';

export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
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
      const res = await fetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        // Session cookie is set by the route — go straight to the dashboard.
        router.push('/');
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not accept invitation. The link may have expired.');
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
            <h1 className="text-xl font-bold gradient-text mb-2">Welcome to YT Studio</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              Choose a password to finish setting up your account.
            </p>
          </div>

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
              {loading ? 'Setting up...' : 'Accept invitation'}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
