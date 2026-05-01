'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useState } from 'react';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  /** Optional unread-count source — when set, renders a red pill badge
   *  next to the label fed by the matching hook below. */
  badge?: 'messages-unread';
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// Per-section header tint. Each section gets a brand-aligned color so the
// nav reads as a coherent map of the product's three "modes" rather than
// three identical grey labels. Colors picked from the existing site palette.
const SECTION_COLORS: Record<string, string> = {
  Create: '#a78bfa',      // brand purple — generative work
  Collaborate: '#06b6d4', // cyan — communication / sharing
  Grow: '#22c55e',        // green — analytics / growth
};

// Always-visible top items
const PINNED_TOP: NavItem[] = [
  {
    label: 'Dashboard',
    href: '/dashboard',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
  {
    label: 'Projects',
    href: '/projects',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    label: 'Schedule',
    href: '/schedule',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    label: 'Messages',
    href: '/messages',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    badge: 'messages-unread',
  },
];

const SECTIONS: NavSection[] = [
  {
    label: 'Create',
    items: [
      {
        label: 'Idea Generator',
        href: '/ideas',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18h6" /><path d="M10 22h4" />
            <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
          </svg>
        ),
      },
      {
        label: 'Script Generator',
        href: '/generator',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
          </svg>
        ),
      },
      {
        label: 'QA Engine',
        href: '/qa',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            <path d="M11 8v3l2 2" />
          </svg>
        ),
      },
      {
        label: 'Production Doc',
        href: '/production-doc',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        ),
      },
      {
        label: 'Voiceover',
        href: '/voiceover',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        ),
      },
      {
        label: 'Video Studio',
        href: '/video-studio',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
            <line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" />
            <line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" />
            <line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" />
            <line x1="17" y1="7" x2="22" y2="7" />
          </svg>
        ),
      },
      {
        label: 'Thumbnails',
        href: '/thumbnails',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Collaborate',
    items: [
      {
        label: 'Reviews',
        href: '/reviews',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M8 10h8" /><path d="M8 14h4" />
          </svg>
        ),
      },
      {
        label: 'Team',
        href: '/team',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2a5 5 0 0 1 5 5v1a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5z" />
            <path d="M20 21v-2a4 4 0 0 0-3-3.87" /><path d="M4 21v-2a4 4 0 0 1 3-3.87" />
            <circle cx="12" cy="7" r="4" />
            <path d="M2 21a10 10 0 0 1 20 0" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Grow',
    items: [
      {
        label: 'SEO Optimizer',
        href: '/seo',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
          </svg>
        ),
      },
      {
        label: 'Channel',
        href: '/channel',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46a2.78 2.78 0 0 0-1.95 1.96A29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.54C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.96A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z" />
            <polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" />
          </svg>
        ),
      },
      {
        label: 'Competitors',
        href: '/competitors',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
      },
    ],
  },
];

const PINNED_BOTTOM: NavItem[] = [
  {
    label: 'Settings',
    href: '/settings',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const STORAGE_KEY = 'sidebar_sections_v1';

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
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const s of SECTIONS) init[s.label] = true; // default open until hydration
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
    for (const s of SECTIONS) {
      const sectionMatchesPath = s.items.some(it => isActive(pathname, it.href));
      next[s.label] = saved?.[s.label] ?? sectionMatchesPath;
      // Always force-open the section containing the active page
      if (sectionMatchesPath) next[s.label] = true;
    }
    setOpenSections(next);
    setHydrated(true);
    // We deliberately only re-run when pathname changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function toggleSection(label: string) {
    setOpenSections(prev => {
      const next = { ...prev, [label]: !prev[label] };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  async function handleLogout() {
    setLoggingOut(true);
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  function renderItem(item: NavItem, indent: boolean = false) {
    const active = isActive(pathname, item.href);
    return (
      <Link key={item.href} href={item.href}>
        <motion.div
          whileHover={{ x: 2 }}
          className="flex items-center gap-3 px-3 py-2 rounded-lg transition-all relative cursor-pointer"
          style={{
            background: active ? 'rgba(124,58,237,0.15)' : 'transparent',
            color: active ? 'var(--accent-purple-bright)' : 'var(--text-secondary)',
            border: active ? '1px solid rgba(124,58,237,0.25)' : '1px solid transparent',
            paddingLeft: indent && !collapsed ? 16 : 12,
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
            {/* Mini-pill on the icon when collapsed — only render path
                that needs to surface a count without the label. */}
            {item.badge === 'messages-unread' && collapsed && (
              <MessagesUnreadDot />
            )}
          </span>
          <AnimatePresence>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                className="text-sm font-medium whitespace-nowrap overflow-hidden flex items-center gap-2"
              >
                {item.label}
                {item.badge === 'messages-unread' && <MessagesUnreadBadge />}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>
      </Link>
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
        {/* Pinned top */}
        {PINNED_TOP.map(item => renderItem(item))}

        {/* Sections */}
        {SECTIONS.map(section => {
          const isOpen = openSections[section.label] ?? true;
          // When collapsed, always show all items (no section headers)
          if (collapsed) {
            return (
              <div key={section.label} className="pt-2">
                {section.items.map(item => renderItem(item))}
              </div>
            );
          }
          return (
            <div key={section.label} className="pt-3">
              <button
                onClick={() => toggleSection(section.label)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] uppercase tracking-widest font-bold transition-colors cursor-pointer rounded hover:bg-white/5"
                style={{ color: SECTION_COLORS[section.label] || '#a8a8d0' }}
              >
                <span>{section.label}</span>
                <motion.svg
                  width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                  animate={{ rotate: isOpen ? 0 : -90 }}
                  transition={{ duration: 0.15 }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </motion.svg>
              </button>
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
                      {section.items.map(item => renderItem(item, true))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {/* Pinned bottom */}
        <div className="pt-3">
          {PINNED_BOTTOM.map(item => renderItem(item))}
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
