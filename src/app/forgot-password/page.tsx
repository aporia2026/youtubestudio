'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      // The endpoint always returns 200 — show the same confirmation
      // regardless of whether the email is registered, to avoid leaking
      // which addresses have accounts.
      if (res.ok) {
        setSubmitted(true);
      } else {
        setError('Something went wrong. Please try again.');
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
      </div>
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="relative z-10 w-full max-w-md mx-4"
      >
        <div className="gradient-border p-8">
          <div className="text-center mb-6">
            <h1 className="text-xl font-bold gradient-text mb-2">Reset your password</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              {submitted
                ? "If that email is registered, we've sent a reset link."
                : 'Enter your email and we’ll send a password reset link.'}
            </p>
          </div>

          {!submitted && (
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
                  required
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
                disabled={loading || !email.trim()}
                className="btn-primary w-full justify-center"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
          )}

          {submitted && (
            <div className="text-sm space-y-3" style={{ color: 'var(--text-secondary)' }}>
              <p>Check your inbox for an email from YT Studio. The link expires in an hour.</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                Didn’t get it? Check spam, or contact your administrator if you can’t access your email.
              </p>
            </div>
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
