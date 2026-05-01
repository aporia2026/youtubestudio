'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (res.ok) {
        router.push('/');
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Sign in failed. Try again.');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden cyber-grid">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-20"
          style={{ background: 'radial-gradient(circle, #7c3aed, transparent)', filter: 'blur(60px)' }} />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full opacity-15"
          style={{ background: 'radial-gradient(circle, #06b6d4, transparent)', filter: 'blur(60px)' }} />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-md mx-4"
      >
        <div className="gradient-border p-8">
          <div className="text-center mb-8">
            <motion.div
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="inline-flex items-center gap-3 mb-4"
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center pulse-glow"
                style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M8 5v14l11-7L8 5z" fill="white" />
                </svg>
              </div>
              <div className="text-left">
                <div className="text-xl font-bold gradient-text">YouTube Studio</div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>AI-Powered Content Engine</div>
              </div>
            </motion.div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              Sign in to your workspace
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="input-field"
                autoFocus
                autoComplete="email"
                required
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                  Password
                </label>
                <Link href="/forgot-password" className="text-xs hover:underline" style={{ color: 'var(--text-muted)' }}>
                  Forgot password?
                </Link>
              </div>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="input-field"
                autoComplete="current-password"
                required
              />
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="text-sm px-4 py-3 rounded-lg"
                style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}
              >
                {error}
              </motion.div>
            )}

            <button
              type="submit"
              disabled={loading || !email.trim() || !password}
              className="btn-primary w-full justify-center"
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {loading ? (
                <>
                  <div className="spinner" style={{ width: 16, height: 16 }} />
                  Signing in...
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />
                  </svg>
                  Sign In
                </>
              )}
            </button>
          </form>

          <div className="mt-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            Account access is managed by your administrator
          </div>
        </div>
      </motion.div>
    </div>
  );
}
