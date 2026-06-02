'use client';

/**
 * MediumToggle — the long-form / short_clip / short_native segmented
 * control that sits at the top of every section page (Ideas, Scripts,
 * QA, SEO).
 *
 * URL-driven: writes `?medium=` on the current pathname so deep links
 * land on the right surface and back/forward navigation behaves
 * naturally. Reads via Next's `useSearchParams` — the parent page does
 * the same to dispatch its strategy, so the toggle is always in sync
 * with the page's actual mode.
 *
 * Lazy-user UX (rule 10):
 *   - One chip-strip. No menus, no nested toggles, no settings inline.
 *   - Each chip carries its short label + a short medium-specific hint
 *     in a tooltip-equivalent `title` attribute so a hover reveals what
 *     the choice will do.
 *   - The active chip is visually unmistakable (filled accent + drop
 *     shadow). Inactive chips are unfilled but readable.
 *
 * No localStorage / no remembered-last in v1. The section setting
 * `sectionDefaultMedium = 'remember_last'` is in scope for a separate
 * client-side hook that wraps `useMedium()` — Phase 1 just reads
 * the URL.
 *
 * Logs every toggle change via `console.info('[shorts medium toggle]', ...)`
 * per rule 14 observability.
 */

import { useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  CONTENT_MEDIA,
  MEDIUM_DISPLAY,
  parseMediumParam,
  type ContentMedium,
  type ToggleSection,
} from '@/lib/content-medium';

interface MediumToggleProps {
  section: ToggleSection;
  /** Optional extra style for layout integration. */
  className?: string;
  style?: React.CSSProperties;
}

export function useMedium(): ContentMedium {
  const params = useSearchParams();
  return parseMediumParam(params?.get('medium'));
}

export function MediumToggle({ section, className, style }: MediumToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const active = parseMediumParam(params?.get('medium'));

  const setMedium = useCallback(
    (next: ContentMedium) => {
      if (next === active) return;
      const url = new URLSearchParams(params?.toString() ?? '');
      if (next === 'long_form') {
        url.delete('medium'); // long_form is default — keep URL clean
      } else {
        url.set('medium', next);
      }
      const qs = url.toString();
      // eslint-disable-next-line no-console -- structured observability per rule 14
      console.info('[shorts medium toggle]', {
        section,
        from: active,
        to: next,
      });
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [active, params, pathname, router, section],
  );

  return (
    <div
      role="tablist"
      aria-label="Content medium"
      className={className}
      style={{
        display: 'inline-flex',
        gap: 4,
        padding: 4,
        borderRadius: 12,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        ...style,
      }}
    >
      {CONTENT_MEDIA.map((medium) => {
        const display = MEDIUM_DISPLAY[medium];
        const isActive = medium === active;
        return (
          <button
            key={medium}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={display.description}
            onClick={() => setMedium(medium)}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: 'none',
              cursor: isActive ? 'default' : 'pointer',
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              letterSpacing: -0.1,
              background: isActive ? 'rgba(124,58,237,0.9)' : 'transparent',
              color: isActive ? '#fff' : 'var(--text-secondary, rgba(255,255,255,0.7))',
              boxShadow: isActive ? '0 1px 4px rgba(0,0,0,0.25)' : 'none',
              transition: 'background 120ms ease, color 120ms ease',
            }}
          >
            {display.shortLabel}
          </button>
        );
      })}
    </div>
  );
}

/** Compact one-line hint line that sits under the toggle. Reads the
 *  strategy for the active (medium, section) pair so the explanation
 *  always matches what the user is about to do. */
export function MediumHint({ section, hint }: { section: ToggleSection; hint: string }) {
  if (!hint) return null;
  return (
    <div
      style={{
        marginTop: 8,
        fontSize: 13,
        color: 'var(--text-secondary, rgba(255,255,255,0.65))',
        maxWidth: 720,
        lineHeight: 1.4,
      }}
      data-section={section}
    >
      {hint}
    </div>
  );
}
