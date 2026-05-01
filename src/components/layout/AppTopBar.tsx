import Link from 'next/link';
import { ChannelSwitcher, type ChannelOption } from './ChannelSwitcher';
import { LogoutButton } from '@/components/auth/LogoutButton';

export interface AppTopBarUser {
  id: string;
  name: string;
  email: string | null;
  system_role: 'admin' | 'user';
}

/**
 * Slim chrome row that sits between the sidebar and the page content.
 * Holds the channel switcher (left), and identity / admin link / sign-out
 * (right). Pure server component — no client state lives here; the
 * ChannelSwitcher is the only interactive child.
 */
export function AppTopBar({
  user,
  channels,
  activeChannelId,
}: {
  user: AppTopBarUser;
  channels: ChannelOption[];
  activeChannelId: string | null;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'var(--bg-primary)',
        flexShrink: 0,
      }}
    >
      <ChannelSwitcher
        channels={channels}
        initialActiveChannelId={activeChannelId}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 12,
          color: 'var(--text-muted)',
        }}
      >
        {user.system_role === 'admin' && (
          <Link
            href="/admin"
            className="hover:underline"
            style={{ color: 'var(--text-secondary)' }}
          >
            Admin
          </Link>
        )}
        <span>{user.email ?? user.name}</span>
        <LogoutButton
          className="hover:underline"
          style={{
            color: 'var(--text-muted)',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            font: 'inherit',
          }}
        />
      </div>
    </div>
  );
}
