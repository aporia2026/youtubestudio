'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';

import { isPinnable, type NavHub, type NavItem } from './nav-catalog';
import { useFavorites } from './use-favorites';

interface HubLandingProps {
  hub: NavHub;
}

// ---------------------------------------------------------------------------
// PinStar — hover-revealed button that toggles an item's pinned status.
// Renders nothing for items that aren't pinnable (top-nav / Settings).
// Click handler stops navigation so the surrounding Link doesn't fire.
// ---------------------------------------------------------------------------
function PinStar({
  href,
  label,
  pinned,
  onToggle,
}: {
  href: string;
  label: string;
  pinned: boolean;
  onToggle: (href: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(href);
      }}
      aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
      title={pinned ? 'Unpin from Favorites' : 'Pin to Favorites'}
      className="absolute top-3 right-3 p-1.5 rounded-md transition-opacity opacity-0 group-hover:opacity-100 hover:bg-white/10"
      style={{ color: pinned ? '#f0c660' : 'var(--text-muted)' }}
    >
      {pinned ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Primary card — large tile for daily-use tools.
// ---------------------------------------------------------------------------
function PrimaryCard({
  item,
  accent,
  pinned,
  onTogglePin,
}: {
  item: NavItem;
  accent: string;
  pinned: boolean;
  onTogglePin: (href: string) => void;
}) {
  return (
    <Link href={item.href} className="block h-full group relative">
      <motion.div
        initial={false}
        whileHover={{
          y: -2,
          borderColor: accent,
          background: `${accent}0F`,
        }}
        transition={{ duration: 0.15 }}
        className="h-full rounded-xl p-5 flex flex-col gap-3 cursor-pointer"
        style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center justify-center rounded-lg shrink-0"
          style={{
            width: 44,
            height: 44,
            background: `${accent}1A`,
            color: accent,
          }}
        >
          {item.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="font-semibold mb-1"
            style={{ fontSize: 15, color: 'var(--text-primary)' }}
          >
            {item.label}
          </div>
          {item.hint && (
            <div
              style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.4 }}
            >
              {item.hint}
            </div>
          )}
        </div>
      </motion.div>
      {isPinnable(item.href) && (
        <PinStar href={item.href} label={item.label} pinned={pinned} onToggle={onTogglePin} />
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Secondary card — compact row for specialist / rare-use tools.
// ---------------------------------------------------------------------------
function SecondaryCard({
  item,
  pinned,
  onTogglePin,
}: {
  item: NavItem;
  pinned: boolean;
  onTogglePin: (href: string) => void;
}) {
  return (
    <Link href={item.href} className="block group relative">
      <motion.div
        whileHover={{ y: -1 }}
        transition={{ duration: 0.15 }}
        className="rounded-lg p-3 flex items-center gap-3 cursor-pointer transition-colors hover:bg-white/5"
        style={{
          background: 'rgba(255,255,255,0.015)',
          border: '1px solid var(--border)',
        }}
      >
        <div className="shrink-0" style={{ color: 'var(--text-muted)' }}>
          {item.icon}
        </div>
        <div className="min-w-0 flex-1 pr-6">
          <div
            className="font-medium truncate"
            style={{ fontSize: 13, color: 'var(--text-primary)' }}
          >
            {item.label}
          </div>
          {item.hint && (
            <div
              className="truncate"
              style={{ fontSize: 11, color: 'var(--text-muted)' }}
            >
              {item.hint}
            </div>
          )}
        </div>
      </motion.div>
      {isPinnable(item.href) && (
        <PinStar href={item.href} label={item.label} pinned={pinned} onToggle={onTogglePin} />
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// HubLanding — full hub page: title + description + primary grid + specialist row.
// ---------------------------------------------------------------------------
export function HubLanding({ hub }: HubLandingProps) {
  const favorites = useFavorites();
  const primaryItems = hub.items.filter(it => (it.tier ?? 'primary') === 'primary');
  const secondaryItems = hub.items.filter(it => it.tier === 'secondary');

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto' }}>
      {/* Header */}
      <header className="mb-10">
        <div
          style={{
            color: hub.color,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            marginBottom: 10,
          }}
        >
          Workflow hub
        </div>
        <h1
          className="font-bold"
          style={{ fontSize: 34, color: 'var(--text-primary)', marginBottom: 6, lineHeight: 1.1 }}
        >
          {hub.label}
        </h1>
        <p
          style={{
            fontSize: 15,
            color: 'var(--text-secondary)',
            maxWidth: 640,
            lineHeight: 1.5,
          }}
        >
          {hub.description}
        </p>
      </header>

      {/* Primary tools */}
      {primaryItems.length > 0 && (
        <section className="mb-12">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {primaryItems.map(item => (
              <PrimaryCard
                key={item.href}
                item={item}
                accent={hub.color}
                pinned={favorites.isPinned(item.href)}
                onTogglePin={favorites.togglePin}
              />
            ))}
          </div>
        </section>
      )}

      {/* Specialist tools */}
      {secondaryItems.length > 0 && (
        <section>
          <div className="flex items-baseline gap-3 mb-3">
            <h2
              className="font-semibold"
              style={{ fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}
            >
              Specialist tools
            </h2>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Less common — use when you need them.
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {secondaryItems.map(item => (
              <SecondaryCard
                key={item.href}
                item={item}
                pinned={favorites.isPinned(item.href)}
                onTogglePin={favorites.togglePin}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
