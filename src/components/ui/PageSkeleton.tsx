'use client';

/**
 * Generic skeleton placeholder for pages waiting on initial data.
 *
 * Audit M13: Six Phase 4-7 pages (`/retention`, `/fix-the-dip`,
 * `/dub`, `/ask-studio`, `/shorts`, `/spend`) showed a flash of empty
 * content while their initial fetches resolved. Render this instead.
 *
 * Variants:
 *   - kind="rows"  → header bar + N rectangular rows. Default.
 *   - kind="grid"  → header bar + 3-up KPI cards + N rows.
 *   - kind="form"  → header bar + several stacked form-shaped lines.
 *
 * Reasonable defaults so most callers can drop in `<PageSkeleton />`
 * with no props.
 */

interface PageSkeletonProps {
  kind?: 'rows' | 'grid' | 'form';
  rows?: number;
  /** Optional title text shown above the skeleton blocks (real text,
   *  not a placeholder bar) — useful when the page header is already
   *  known but the body content isn't loaded yet. */
  title?: string;
}

export function PageSkeleton({ kind = 'rows', rows = 4, title }: PageSkeletonProps) {
  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl" aria-busy="true" aria-live="polite">
      {title ? (
        <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>{title}</h1>
      ) : (
        <SkeletonBar w="240px" h="28px" className="mb-2" />
      )}
      <SkeletonBar w="380px" h="14px" className="mb-6 opacity-60" />

      {kind === 'grid' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="glass rounded-xl p-4">
              <SkeletonBar w="60%" h="12px" className="mb-2 opacity-60" />
              <SkeletonBar w="40%" h="22px" />
            </div>
          ))}
        </div>
      )}

      {kind === 'form' ? (
        <div className="space-y-4">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="glass rounded-xl p-4">
              <SkeletonBar w="120px" h="12px" className="mb-2 opacity-60" />
              <SkeletonBar w="100%" h="36px" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="glass rounded-xl p-4 flex items-center gap-3">
              <SkeletonBar w="40px" h="40px" rounded="rounded-full" />
              <div className="flex-1 min-w-0">
                <SkeletonBar w="60%" h="16px" className="mb-2" />
                <SkeletonBar w="40%" h="12px" className="opacity-60" />
              </div>
              <SkeletonBar w="80px" h="32px" />
            </div>
          ))}
        </div>
      )}

      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Inline skeleton — same row pattern as PageSkeleton but without the
 *  page-header bar, so it slots naturally into a page that already
 *  rendered its own header. Most Phase 4-7 pages need this variant. */
export function InlinePageSkeleton({ rows = 4, kind = 'rows' as 'rows' | 'grid' }: { rows?: number; kind?: 'rows' | 'grid' }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {kind === 'grid' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="glass rounded-xl p-4">
              <SkeletonBar w="60%" h="12px" className="mb-2 opacity-60" />
              <SkeletonBar w="40%" h="22px" />
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="glass rounded-xl p-4 flex items-center gap-3">
            <SkeletonBar w="40px" h="40px" rounded="rounded-full" />
            <div className="flex-1 min-w-0">
              <SkeletonBar w="60%" h="16px" className="mb-2" />
              <SkeletonBar w="40%" h="12px" className="opacity-60" />
            </div>
            <SkeletonBar w="80px" h="32px" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

interface SkeletonBarProps {
  w: string;
  h: string;
  className?: string;
  rounded?: string;
}

function SkeletonBar({ w, h, className = '', rounded = 'rounded' }: SkeletonBarProps) {
  return (
    <div
      className={`${rounded} ${className}`}
      style={{
        width: w,
        height: h,
        background:
          'linear-gradient(90deg, var(--bg-secondary) 0%, var(--bg-card-hover) 50%, var(--bg-secondary) 100%)',
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.4s ease-in-out infinite',
      }}
    />
  );
}
