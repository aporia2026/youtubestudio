'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useState } from 'react';

import {
  TOP_NAV,
  HUBS,
  BOTTOM_NAV,
  isPinnable,
  type NavItem,
  type NavHub,
} from './nav-catalog';
import { useFavorites } from './use-favorites';
import { SidebarFavorites } from './SidebarFavorites';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

// Bumped to v2 with the Favorites + collapsed-by-default redesign. The
// jump invalidates the prior key so every existing user lands on the new
// clean defaults instead of carrying their old "everything expanded"
// state forward. Their next manual expansion still persists.
const STORAGE_KEY = 'sidebar_sections_v2';

function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard' || pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  // Section expansion state — persisted in localStorage. Default: section
  // containing the current page is expanded, others are collapsed.
  const [openHubs, setOpenHubs] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const h of HUBS) init[h.label] = false; // closed until hydration
    return init;
  });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let saved: Record<string, boolean> | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {}

    const next: Record<string, boolean> = {};
    for (const h of HUBS) {
      const hubMatchesPath = h.items.some(it => isActive(pathname, it.href));
      next[h.label] = saved?.[h.label] ?? hubMatchesPath;
      // Always force-open the hub containing the active page
      if (hubMatchesPath) next[h.label] = true;
    }
    setOpenHubs(next);
    setHydrated(true);
    // We deliberately only re-run when pathname changes

  }, [pathname]);

  function toggleHub(label: string) {
    setOpenHubs(prev => {
      const next = { ...prev, [label]: !prev[label] };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      console.info('[nav hub]', next[label] ? 'open' : 'close', { hub: label });
      return next;
    });
  }

  // Favorites — localStorage-backed list of pinned hrefs. The hook
  // handles persistence; this component just reads and toggles.
  const favorites = useFavorites();

  async function handleLogout() {
    setLoggingOut(true);
    // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  function renderItem(item: NavItem, opts: { indent?: boolean; muted?: boolean } = {}) {
    const { indent = false, muted = false } = opts;
    const active = isActive(pathname, item.href);
    const baseColor = muted ? 'var(--text-muted)' : 'var(--text-secondary)';
    const pinnable = isPinnable(item.href);
    const pinned = pinnable && favorites.isPinned(item.href);
    return (
      <Link key={item.href} href={item.href}>
        <motion.div
          whileHover={{ x: 2 }}
          className="group flex items-center gap-3 px-3 py-2 rounded-lg transition-all relative cursor-pointer"
          style={{
            background: active ? 'rgba(124,58,237,0.15)' : 'transparent',
            color: active ? 'var(--accent-purple-bright)' : baseColor,
            border: active ? '1px solid rgba(124,58,237,0.25)' : '1px solid transparent',
            paddingLeft: indent && !collapsed ? 16 : 12,
            opacity: muted && !active ? 0.75 : 1,
          }}
        >
          {active && (
            <motion.div
              layoutId="nav-indicator"
              className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full"
              style={{ background: 'var(--accent-purple-bright)' }}
            />
          )}
          <span className="shrink-0 relative">
            {item.icon}
            {/* Mini-pill on the icon when collapsed — only the render path
                that needs to surface a count without the label. */}
            {item.badge === 'messages-unread' && collapsed && (
              <MessagesUnreadDot />
            )}
            {item.badge === 'comments-unread' && collapsed && (
              <CommentsUnreadDot />
            )}
          </span>
          <AnimatePresence>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                className="text-sm font-medium whitespace-nowrap overflow-hidden flex-1 min-w-0 flex items-center gap-2"
              >
                {item.label}
                {item.badge === 'messages-unread' && <MessagesUnreadBadge />}
                {item.badge === 'comments-unread' && <CommentsUnreadBadge />}
              </motion.span>
            )}
          </AnimatePresence>
          {/* Pin / unpin button — only for hub items, only when sidebar
              is expanded, only on hover. Filled star = already pinned
              (click to unpin); outlined = not pinned (click to pin). */}
          {pinnable && !collapsed && (
            <button
              type="button"
              onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                favorites.togglePin(item.href);
              }}
              aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
              title={pinned ? 'Unpin from Favorites' : 'Pin to Favorites'}
              className="shrink-0 p-1 rounded transition-opacity hover:bg-white/10 opacity-0 group-hover:opacity-100"
              style={{ color: pinned ? '#f0c660' : 'var(--text-muted)' }}
            >
              {pinned ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              )}
            </button>
          )}
        </motion.div>
      </Link>
    );
  }

  function renderHub(hub: NavHub) {
    const isOpen = openHubs[hub.label] ?? false;
    // When sidebar is collapsed: show only the hub's PRIMARY items as
    // icons. Secondary items hide entirely — they remain reachable from
    // Cmd+K and from the hub page. This is the deliberate
    // deprioritization the redesign exists to deliver.
    //
    // Exception: if the active route is a secondary item, surface it
    // anyway so the user can see where they are.
    if (collapsed) {
      return (
        <div key={hub.label} className="pt-2">
          {hub.items
            .filter(it => (it.tier ?? 'primary') === 'primary' || isActive(pathname, it.href))
            .map(item => renderItem(item))}
        </div>
      );
    }
    const hubActive = isActive(pathname, hub.href);
    return (
      <div key={hub.label} className="pt-3">
        {/* Header row: label is a Link to the hub landing page; chevron is
            a separate toggle that expands the items inline. Two clear
            affordances so a lazy user gets what they expect: click the
            name → go to the hub; click the arrow → see what's inside. */}
        <div
          className="flex items-stretch rounded transition-colors"
          style={{
            background: hubActive ? `${hub.color}1A` : 'transparent',
          }}
        >
          <Link
            href={hub.href}
            className="flex-1 flex items-center px-3 py-1.5 text-[11px] uppercase tracking-widest font-bold cursor-pointer rounded-l hover:bg-white/5"
            style={{ color: hub.color }}
          >
            {hub.label}
          </Link>
          <button
            onClick={() => toggleHub(hub.label)}
            aria-label={isOpen ? `Collapse ${hub.label}` : `Expand ${hub.label}`}
            className="px-2.5 flex items-center cursor-pointer rounded-r hover:bg-white/10 transition-colors"
            style={{ color: hub.color }}
          >
            <motion.svg
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
              animate={{ rotate: isOpen ? 0 : -90 }}
              transition={{ duration: 0.15 }}
            >
              <polyline points="6 9 12 15 18 9" />
            </motion.svg>
          </button>
        </div>
        <AnimatePresence initial={false}>
          {isOpen && hydrated && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <div className="space-y-0.5 mt-1">
                {hub.items.map(item =>
                  renderItem(item, {
                    indent: true,
                    muted: (item.tier ?? 'primary') === 'secondary',
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 220 }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className="flex flex-col h-screen sticky top-0 shrink-0 overflow-hidden"
      style={{
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border)',
        zIndex: 50,
      }}
    >
      {/* Logo */}
      <div className="flex items-center h-16 px-4 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Link
          href="/command-center"
          className="flex items-center min-w-0 rounded-md transition-colors hover:opacity-90 cursor-pointer"
          title="Go to Command Center (This Week)"
        >
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M8 5v14l11-7L8 5z" fill="white" />
            </svg>
          </div>
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
                className="ml-3 overflow-hidden whitespace-nowrap"
              >
                <div className="text-sm font-bold gradient-text leading-tight">YT Studio</div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>AI Engine</div>
              </motion.div>
            )}
          </AnimatePresence>
        </Link>
        <button
          onClick={onToggle}
          className="ml-auto p-1.5 rounded-md transition-colors hover:bg-white/5 cursor-pointer"
          style={{ color: 'var(--text-muted)' }}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {collapsed
              ? <path d="M9 18l6-6-6-6" />
              : <path d="M15 18l-6-6 6-6" />}
          </svg>
        </button>
      </div>

      {/* Search hint (Cmd+K) — only when expanded */}
      {!collapsed && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
          className="mx-2 mt-3 mb-1 flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors hover:bg-white/5 cursor-pointer"
          style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <span className="flex-1 text-left">Quick jump…</span>
          <kbd className="text-[10px] px-1 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)' }}>⌘K</kbd>
        </button>
      )}

      {/* Nav */}
      <nav className="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
        {/* Top */}
        {TOP_NAV.map(item => renderItem(item))}

        {/* Favorites */}
        <SidebarFavorites collapsed={collapsed} favorites={favorites} />

        {/* Hubs */}
        {HUBS.map(hub => renderHub(hub))}

        {/* Bottom */}
        <div className="pt-3">
          {BOTTOM_NAV.map(item => renderItem(item))}
        </div>
      </nav>

      {/* Logout */}
      <div className="px-2 pb-4 shrink-0" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all cursor-pointer disabled:cursor-not-allowed"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
          <AnimatePresence>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-sm font-medium whitespace-nowrap"
              >
                {loggingOut ? 'Signing out...' : 'Sign Out'}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>
    </motion.aside>
  );
}

/**
 * Polls the owner-side unread-messages count and renders a red pill in
 * the sidebar so the owner sees at a glance when a collaborator has
 * pinged them. Polls every 30s, and on window focus, to stay current
 * without flooding the API.
 */
function useMessagesUnread() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch('/api/messages/unread', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setCount((data.unread as number) || 0);
      } catch {}
    }
    load();
    const id = setInterval(load, 30_000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, []);
  return count;
}

function MessagesUnreadBadge() {
  const count = useMessagesUnread();
  if (count === 0) return null;
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full font-bold ml-auto"
      style={{ background: '#ef4444', color: '#fff', minWidth: 18, textAlign: 'center', lineHeight: '14px' }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function MessagesUnreadDot() {
  const count = useMessagesUnread();
  if (count === 0) return null;
  return (
    <span
      className="absolute -top-1 -right-1 rounded-full"
      style={{ background: '#ef4444', width: 8, height: 8, border: '1.5px solid var(--bg-primary)' }}
    />
  );
}

/**
 * Same polling rhythm as `useMessagesUnread` — 30s + on window focus.
 * Counts unresolved top-level comments across the owner's workspace via
 * the dedicated /api/inbox/unread route so we don't ship the full inbox
 * payload on every tick.
 */
function useCommentsUnread() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch('/api/inbox/unread', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setCount((data.unread as number) || 0);
      } catch {}
    }
    load();
    const id = setInterval(load, 30_000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, []);
  return count;
}

function CommentsUnreadBadge() {
  const count = useCommentsUnread();
  if (count === 0) return null;
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full font-bold ml-auto"
      style={{ background: '#ef4444', color: '#fff', minWidth: 18, textAlign: 'center', lineHeight: '14px' }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function CommentsUnreadDot() {
  const count = useCommentsUnread();
  if (count === 0) return null;
  return (
    <span
      className="absolute -top-1 -right-1 rounded-full"
      style={{ background: '#ef4444', width: 8, height: 8, border: '1.5px solid var(--bg-primary)' }}
    />
  );
}
