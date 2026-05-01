'use client';

import { use } from 'react';
import { ChatThread } from '@/components/messages/ChatThread';

/**
 * Collaborator-side inbox — straight chat-with-the-owner view, reachable
 * via their personal_token. Linked from the dashboard (narrator/editor)
 * and from email CTAs.
 */
export default function InboxPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return (
    <div className="max-w-3xl mx-auto p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Messages</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Direct chat with the project owner.
        </p>
      </header>
      <div className="rounded-xl overflow-hidden h-[70vh]" style={{ border: '1px solid var(--border)' }}>
        <ChatThread
          loadUrl={`/api/messages/inbox/${token}`}
          postUrl={`/api/messages/inbox/${token}`}
        />
      </div>
    </div>
  );
}
