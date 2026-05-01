import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { findUserById } from '@/lib/users';

/**
 * Server-component admin gate. Runs before any /admin page renders.
 * Non-admin sessions are redirected to / so the existence of the admin
 * surface isn't visible to regular users (they can still observe the URL
 * exists, but they don't see any data).
 *
 * Note: this gate is in addition to the per-route admin checks on
 * /api/admin/** — the page can render skeletons but it cannot fetch data
 * without an admin session.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.sysrole !== 'admin') redirect('/');

  const me = await findUserById(session.uid);
  if (!me || me.status === 'suspended') redirect('/login');

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <header
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Admin
          </span>
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <Link
            href="/admin"
            className="text-sm hover:underline"
            style={{ color: 'var(--text-secondary)' }}
          >
            Users
          </Link>
          <Link
            href="/admin/audit"
            className="text-sm hover:underline"
            style={{ color: 'var(--text-secondary)' }}
          >
            Audit log
          </Link>
        </div>
        <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{me.email ?? me.name}</span>
          <Link href="/" className="hover:underline">
            ← Back to app
          </Link>
        </div>
      </header>
      <main style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>{children}</main>
    </div>
  );
}
