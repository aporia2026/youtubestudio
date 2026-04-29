'use client';

import { useState } from 'react';

interface AuthorSetupProps {
  onSave: (name: string) => void;
}

export function AuthorSetup({ onSave }: AuthorSetupProps) {
  const [name, setName] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim()) onSave(name.trim());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <form
        onSubmit={handleSubmit}
        className="w-80 p-6 rounded-xl"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
      >
        <div className="text-center mb-4">
          <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>What's your name?</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>So others know who left the feedback</p>
        </div>
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your name"
          className="w-full px-3 py-2 rounded-lg text-sm mb-4"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="w-full py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
          style={{ background: '#7c3aed' }}
        >
          Continue
        </button>
      </form>
    </div>
  );
}
