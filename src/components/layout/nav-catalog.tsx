/**
 * Single source of truth for the app's navigation surface.
 *
 * Consumed by:
 *   - Sidebar.tsx           — renders TOP, FAVORITES, HUBS (collapsible), BOTTOM
 *   - GlobalCommandPalette  — searches every NavItem by label + hint + keywords
 *   - (Phase 2) hub pages   — render primary/secondary cards from HUBS[].items
 *
 * Mental-model split (carried over from the original Sidebar):
 *   Create      — making the video (production funnel, in workflow order)
 *   Grow        — performance, audience, experiments, competitor intel
 *   Collaborate — internal team work
 *   Automate    — meta / operational tools that act across the others
 *
 * Tier per item:
 *   'primary'   — daily-use tool; surfaces as a large card on the hub page
 *   'secondary' — rare / specialist; surfaces under "Specialist tools" on
 *                 the hub page. Still reachable from Cmd+K and direct URL.
 *                 The user explicitly said: do NOT delete these, just
 *                 deprioritize them.
 */

import type { ReactNode } from 'react';

export type BadgeKind = 'messages-unread' | 'comments-unread';
export type Tier = 'primary' | 'secondary';

export interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  hint?: string;
  keywords?: string[];
  tier?: Tier;
  badge?: BadgeKind;
}

export interface NavHub {
  /** Sidebar header + hub page title. */
  label: string;
  /** Landing page route. */
  href: string;
  /** Brand-aligned accent color for the header + active item indicator. */
  color: string;
  /** One-line subtitle shown on the hub landing page. Plain language, no jargon. */
  description: string;
  items: NavItem[];
}

// ---------------------------------------------------------------------------
// Top-level — always visible at the top of the sidebar.
// ---------------------------------------------------------------------------

export const TOP_NAV: NavItem[] = [
  {
    // Command Center — Wave 2 of the cross-feature redesign. Default
    // landing as of 2026-05-26 (see src/app/page.tsx). Kanban of every
    // in-flight video across channels for the current week.
    label: 'This Week',
    href: '/command-center',
    hint: 'Command Center — kanban of in-flight videos',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="5" height="18" rx="1" />
        <rect x="10" y="3" width="5" height="12" rx="1" />
        <rect x="17" y="3" width="4" height="7" rx="1" />
      </svg>
    ),
  },
  // Dashboard was removed from TOP_NAV when /command-center became the
  // default landing (Wave 2). The Dashboard route still exists; a small
  // "Open legacy Dashboard" link in Settings → About is the escape hatch.
  // If we want it back in the sidebar, restore this block.
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
    hint: 'List · Calendar · Spreadsheet · Kanban',
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
    badge: 'messages-unread',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    // Inbox — every unresolved review/narration comment across the
    // workspace, grouped by role then person. The red unread pill is the
    // owner's "you have feedback waiting" signal even when they aren't on
    // a project page that would surface the per-take badge.
    label: 'Inbox',
    href: '/inbox',
    badge: 'comments-unread',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        <circle cx="8.5" cy="12" r="0.6" fill="currentColor" />
        <circle cx="12"  cy="12" r="0.6" fill="currentColor" />
        <circle cx="15.5" cy="12" r="0.6" fill="currentColor" />
      </svg>
    ),
  },
];

// ---------------------------------------------------------------------------
// Hubs — collapsible workflow sections.
// ---------------------------------------------------------------------------

export const HUBS: NavHub[] = [
  {
    // CREATE — production funnel, ordered to match the actual workflow:
    // pick an idea → script → review → plan visuals → record voice →
    // assemble video (long-form OR shorts) → translate → finishing
    // touches (thumbnails + SEO).
    //
    // Auto-pipeline sits at the TOP as the "do it all in one click" entry
    // — a lightning bolt distinguishes it from the atomic stage tools.
    label: 'Create',
    href: '/create',
    color: '#a78bfa', // brand purple — generative work
    description: 'Make a video, from first idea to publish-ready.',
    items: [
      {
        label: 'Auto-pipeline',
        href: '/pipeline',
        hint: 'Idea → script → QA → narration → docs',
        keywords: ['batch', 'auto', 'pipeline', 'one click', 'automation'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
            <path d="M13 2 3 14h7l-1 8 11-14h-7l1-6z" />
          </svg>
        ),
      },
      {
        label: 'Ideas',
        href: '/ideas',
        hint: 'Brainstorm video ideas',
        keywords: ['brainstorm', 'idea'],
        tier: 'primary',
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
        hint: 'Write the script',
        keywords: ['write', 'script', 'draft'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
          </svg>
        ),
      },
      {
        label: 'Voiceover',
        href: '/voiceover',
        hint: 'TTS narration',
        keywords: ['tts', 'audio', 'elevenlabs', 'narration'],
        tier: 'primary',
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
        hint: 'Assemble & render',
        keywords: ['render', 'remotion', 'edit', 'timeline'],
        tier: 'primary',
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
        hint: 'Generate & edit thumbnails',
        keywords: ['thumbnail', 'cover'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
        ),
      },
      {
        label: 'SEO Optimizer',
        href: '/seo',
        hint: 'Titles · descriptions · tags',
        keywords: ['title', 'description', 'tags', 'metadata'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
          </svg>
        ),
      },
      // ---- Secondary / specialist tools ------------------------------------
      {
        label: 'QA Engine',
        href: '/qa',
        hint: 'Script quality check',
        keywords: ['quality', 'check', 'score'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            <path d="M11 8v3l2 2" />
          </svg>
        ),
      },
      {
        // Critics is a script-stage gate (panel reviews the script before
        // recording), not an analytics tool — belongs in Create.
        label: 'Critics (live)',
        href: '/critics',
        hint: 'Panel review of the script',
        keywords: ['panel', 'critic', 'review'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3v3" />
            <path d="M5 9h14" />
            <path d="M5 9 3 19h7l-2-10" />
            <path d="M19 9l2 10h-7l2-10" />
            <path d="M9 21h6" />
            <path d="M12 6v15" />
          </svg>
        ),
      },
      {
        label: 'Production Doc',
        href: '/production-doc',
        hint: 'Shot breakdown',
        keywords: ['shots', 'breakdown', 'scene'],
        tier: 'secondary',
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
        label: 'Shorts',
        href: '/shorts',
        hint: 'Short-form video',
        keywords: ['short', 'vertical', 'reel'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="6" y="2" width="12" height="20" rx="2" />
            <path d="m10 9 5 3-5 3z" fill="currentColor" />
          </svg>
        ),
      },
      {
        label: 'Timeline Editor',
        href: '/timeline-editor',
        hint: 'CapCut-style cut · trim · split · drag-resize',
        keywords: ['timeline', 'editor', 'capcut', 'cut', 'trim', 'split', 'resize', 'drag'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="6" width="20" height="6" rx="1" />
            <rect x="2" y="14" width="14" height="4" rx="1" />
            <line x1="12" y1="3" x2="12" y2="21" />
          </svg>
        ),
      },
      {
        label: 'Channel Clone',
        href: '/channel-clone',
        hint: 'Mimic competitor style + structure end-to-end',
        keywords: ['clone', 'competitor', 'mimic', 'rip', 'channel', 'analyze'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="8" height="8" rx="1" />
            <rect x="13" y="13" width="8" height="8" rx="1" />
            <path d="M11 7h6a2 2 0 0 1 2 2v4" />
          </svg>
        ),
      },
      {
        label: 'Auto-dub',
        href: '/dub',
        hint: 'Translate & dub',
        keywords: ['translate', 'dub', 'language', 'localization'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 8h14" /><path d="M5 12h9" /><path d="M5 16h6" />
            <circle cx="18" cy="18" r="3" />
            <path d="m17 17 2 2" />
          </svg>
        ),
      },
    ],
  },
  {
    // GROW — performance + audience + experiments + competition.
    // Everything that looks at data after publish OR forecasts what will
    // happen on publish.
    label: 'Grow',
    href: '/grow',
    color: '#22c55e', // green — analytics / growth
    description: 'See what is working, fix what is not, and find what to make next.',
    items: [
      {
        label: 'Channel',
        href: '/channel',
        hint: 'Channel analytics',
        keywords: ['youtube', 'analytics', 'channel'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46a2.78 2.78 0 0 0-1.95 1.96A29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.54C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.96A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z" />
            <polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" />
          </svg>
        ),
      },
      {
        label: 'Retention predictor',
        href: '/retention',
        hint: 'Forecast retention curve',
        keywords: ['retention', 'forecast', 'predict'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v18h18" />
            <path d="M3 17 8 12 12 14 17 8 21 11" />
            <circle cx="8" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="14" r="1.5" fill="currentColor" />
            <circle cx="17" cy="8" r="1.5" fill="currentColor" />
          </svg>
        ),
      },
      {
        label: 'Competitors',
        href: '/competitors',
        hint: 'Research competing channels',
        keywords: ['research', 'compete'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
      },
      {
        label: 'Niche finder',
        href: '/insights/niches',
        hint: 'Discover niches',
        keywords: ['niche', 'discover', 'opportunity'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" strokeLinecap="round" />
            <circle cx="11" cy="11" r="2.5" fill="currentColor" strokeWidth="0" />
          </svg>
        ),
      },
      {
        label: 'Video analyzer',
        href: '/analyze',
        hint: 'Single-video deep dive',
        keywords: ['analyze', 'video'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 7l-7 5 7 5V7z" strokeLinejoin="round" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
            <circle cx="6.5" cy="12" r="1.2" fill="currentColor" strokeWidth="0" />
            <circle cx="10.5" cy="12" r="1.2" fill="currentColor" strokeWidth="0" />
          </svg>
        ),
      },
      // ---- Secondary / deep-dive analytics ---------------------------------
      {
        label: 'A/B tests',
        href: '/ab-tests',
        hint: 'Thumbnail & title experiments',
        keywords: ['ab', 'test', 'experiment', 'thumbnail test'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v18h18" />
            <path d="M7 14l4-4 4 4 5-7" />
            <circle cx="11" cy="10" r="1" fill="currentColor" />
            <circle cx="15" cy="14" r="1" fill="currentColor" />
          </svg>
        ),
      },
      {
        label: 'Comments',
        href: '/comments',
        hint: 'Triage YouTube comments',
        keywords: ['triage', 'comments', 'youtube comments'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M8 10h.01M12 10h.01M16 10h.01" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        label: 'Fix the dip',
        href: '/fix-the-dip',
        hint: 'Retention dip remediation',
        keywords: ['retention', 'dip', 'fix'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v18h18" />
            <path d="M3 17 7 13 11 16 14 9 17 14 21 6" />
          </svg>
        ),
      },
      {
        label: 'Cannibalization',
        href: '/cannibalization',
        hint: 'Channel cannibalization analysis',
        keywords: ['cannibal', 'overlap'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="8" cy="9" r="4" />
            <circle cx="16" cy="15" r="4" />
            <path d="M11 11.5l2 2" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        label: 'Competitor signals',
        href: '/competitors/dashboard',
        hint: 'Live competitor monitoring',
        keywords: ['signals', 'competitor', 'monitor'],
        tier: 'secondary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12 7 8l4 6 4-9 6 11" />
            <path d="M3 21h18" strokeOpacity="0.4" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Collaborate',
    href: '/collaborate',
    color: '#06b6d4', // cyan — communication / sharing
    description: 'Reviews, comments, and the people on your team.',
    items: [
      {
        label: 'Reviews',
        href: '/reviews',
        hint: 'Video review with comments',
        keywords: ['review', 'feedback'],
        tier: 'primary',
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
        hint: 'All collaborators',
        keywords: ['team', 'roles', 'editor', 'narrator'],
        tier: 'primary',
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
    // AUTOMATE — meta/operational tools that act ACROSS the other
    // sections. Workflows fires actions on events, Ask Studio queries any
    // data anywhere.
    label: 'Automate',
    href: '/automate',
    color: '#f59e0b', // amber — meta / operational
    description: 'Workflows and ad-hoc questions that act across everything.',
    items: [
      {
        label: 'Workflows',
        href: '/workflows',
        hint: 'Trigger actions on events',
        keywords: ['workflow', 'automation', 'trigger', 'rule'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="18" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="18" r="2.5" />
            <path d="M8.5 6h7M8.5 18h7M6 8.5v7M18 8.5v7" />
          </svg>
        ),
      },
      {
        label: 'Ask Studio',
        href: '/ask-studio',
        hint: 'Natural-language query across data',
        keywords: ['ask', 'query', 'chat', 'studio'],
        tier: 'primary',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            <path d="M12 8v4M12 16h.01" strokeLinecap="round" />
          </svg>
        ),
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Bottom — always pinned to the bottom of the sidebar.
// ---------------------------------------------------------------------------

export const BOTTOM_NAV: NavItem[] = [
  {
    label: 'Settings',
    href: '/settings',
    hint: 'API keys · preferences · appearance',
    keywords: ['settings', 'config', 'api keys', 'preferences'],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

// ---------------------------------------------------------------------------
// Favorites — pinned shortcuts above the hubs.
//
// Phase 1: hardcoded default seed (no per-user persistence yet).
// Phase 3: backed by user_settings.sidebar_favorites and editable from
//          the sidebar (hover → pin/unpin) + Settings → Appearance.
// ---------------------------------------------------------------------------

export const DEFAULT_FAVORITES: readonly string[] = [
  '/pipeline',
  '/voiceover',
  '/video-studio',
  '/thumbnails',
  '/channel',
] as const;

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const ALL_ITEMS: NavItem[] = [
  ...TOP_NAV,
  ...HUBS.flatMap(h => h.items),
  ...BOTTOM_NAV,
];

const BY_HREF: Map<string, NavItem> = new Map(ALL_ITEMS.map(i => [i.href, i]));

/** Look up a NavItem by its exact href. */
export function findNavItem(href: string): NavItem | undefined {
  return BY_HREF.get(href);
}

/** Every NavItem in the catalog, in declaration order. */
export function allNavItems(): NavItem[] {
  return ALL_ITEMS;
}

/** The hub that owns a given href, if any. */
export function findHubFor(href: string): NavHub | undefined {
  return HUBS.find(h => h.items.some(i => i.href === href));
}

/** Pinnable surface — only items inside hubs can be added to Favorites.
 *  Workspace top-nav items (Dashboard, Projects, Schedule, Messages,
 *  Inbox) and Settings are always-on by design; pinning would just
 *  duplicate them. */
const PINNABLE_HREFS: Set<string> = new Set(HUBS.flatMap(h => h.items.map(i => i.href)));

export function isPinnable(href: string): boolean {
  return PINNABLE_HREFS.has(href);
}

/** Look up a hub by its label. Throws if the label is unknown — hub pages
 *  depend on this and the catalog is the single source of truth, so a
 *  missing label is a bug we want to surface loudly at boot. */
export function getHubByLabel(
  label: 'Create' | 'Grow' | 'Collaborate' | 'Automate'
): NavHub {
  const found = HUBS.find(h => h.label === label);
  if (!found) throw new Error(`Hub "${label}" not found in nav-catalog`);
  return found;
}
