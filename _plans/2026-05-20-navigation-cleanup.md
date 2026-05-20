# Navigation Cleanup — Workflow Hubs + Pinning + Cmd+K

**Date:** 2026-05-20
**Status:** Draft, awaiting approval
**Scope:** Global left sidebar + command palette + per-section hub pages

---

## Goals

1. Cut the visible sidebar from ~31 items to ~8–10 at all times, without deleting any route.
2. Make the daily-use tools instantly reachable; bury the rare-use tools without losing them.
3. Give the user (and future teammates) the ability to pin/reorder what they actually use.
4. Promote the existing Cmd+K palette into the primary "find anything" surface.

Success looks like: a first-time visitor reads the sidebar in under 3 seconds and gets a clear mental model of what the product does. A power user lives in Cmd+K and barely needs the sidebar.

## Constraints

- No backend changes. This is purely a UI reorg + one small `user_settings` JSON column write for pinning.
- All current routes (`/qa`, `/critics`, `/auto-dub`, etc.) must keep working as direct links — bookmarks, deep links, and old comments referencing them cannot break.
- Cannot delete any tool. The user's instruction was "deprioritize, don't delete."
- Must respect the existing per-section color tokens (`SECTION_COLORS` in [Sidebar.tsx:35-40](src/components/layout/Sidebar.tsx#L35-L40)) so the new layout reads as a refresh, not a rewrite.

## The brutally honest read on what's wrong today

- **31 items is ~3x what a calm sidebar should hold.** Modern SaaS that scales (Linear, Notion, Vercel) keeps the top-level surface near 8.
- **The "Quick jump…" search at the top is wired up** (it fires `open-command-palette`), but the palette's `PAGES` array only covers ~24 of 31 routes. Half the cleanup work is already half-built and half-finished.
- **Two unread-count pills (Messages 0 + Inbox 33) sit next to each other.** Visually noisy and redundant — they're two flavors of "stuff waiting for you."
- **"Team Hub" and "Team" both exist.** I cannot tell from naming alone which is which. A lazy user can't either.
- **Auto-dub, Fix the dip, Cannibalization, A/B tests, Comments, Critics** are paying the same rent in your visual budget as Auto-pipeline and Video Studio, despite being used near-zero times. That's the whole problem in one sentence.

## The new shape

```
┌─ Top (always visible) ────────────────────┐
│ Logo / brand                              │
│ ⌘K Quick jump…                            │
│ 📊 Dashboard                              │
│ 📁 Projects                               │
│ 📅 Schedule                               │
│ 📬 Inbox  ●33   ← merged Messages+Inbox   │
├─ ★ Favorites (user-pinned, draggable) ────┤
│ ⚡ Auto-pipeline                          │
│ 🎙 Voiceover                              │
│ 🎬 Video Studio                          │
│ 🖼 Thumbnails                            │
│ 📈 Channel                                │
│ (defaults; user can pin/unpin/reorder)    │
├─ Workflow hubs (collapsed by default) ────┤
│ ▸ CREATE       (purple → /create)         │
│ ▸ GROW         (green  → /grow)           │
│ ▸ COLLABORATE  (cyan   → /collaborate)    │
│ ▸ AUTOMATE     (amber  → /automate)       │
├─ Bottom ──────────────────────────────────┤
│ ⚙ Settings                                │
└───────────────────────────────────────────┘
```

**Default visible count: 11 items** (5 top + 5 favorites + 1 settings + 4 collapsed hub headers). When you expand a hub header it acts like a fly-out, not a permanent block — closes when you navigate or click outside.

### Inside each hub page

Each hub label is **clickable** — going to the hub page is the primary action; expanding the dropdown is the secondary action (small chevron on the right).

The hub page is a tidy landing built from cards, grouped by tier so the rare stuff is visibly demoted but not hidden:

**`/create` hub:**
- **Primary (large cards):** Auto-pipeline, Ideas, Script Generator, Voiceover, Video Studio, Thumbnails, SEO Optimizer
- **Secondary (small cards, "Specialist tools" heading):** QA Engine, Critics (live), Production Doc, Shorts, Auto-dub

**`/grow` hub:**
- **Primary:** Channel, Retention predictor, Competitors, Video analyzer, Niche finder
- **Secondary ("Deep-dive analytics"):** A/B tests, Comments, Fix the dip, Cannibalization, Competitor signals

**`/collaborate` hub:**
- **Primary:** Reviews, Team
- Merge **"Team Hub" into "/team"** as a tab. They overlap conceptually; the naming is the bug.

**`/automate` hub:**
- **Primary:** Workflows, Ask Studio

### Cmd+K palette

- Add the **15 missing routes** to `PAGES` in [GlobalCommandPalette.tsx:15](src/components/layout/GlobalCommandPalette.tsx#L15).
- Add a **Recent** section at the top that shows the last 5 pages the user opened (localStorage).
- Add **Quick actions**: "New project", "Run Auto-pipeline on…", "Open last project", "Open Settings".
- Add a `/` shortcut in addition to `⌘K` (matches GitHub/Linear muscle memory).
- Pull `keywords` from the sidebar config so a single source of truth feeds both surfaces — no drift.

### Pinning model

- New column on `user_settings` (or local `user_prefs` JSON if that's already where prefs live): `sidebar_favorites: string[]` (array of `href`).
- New column: `sidebar_hidden_hubs: string[]` (optional — power users can hide an entire hub).
- Default seed (from the user's stated workflow): `['/pipeline', '/voiceover', '/video-studio', '/thumbnails', '/channel']`.
- Hover any item in a hub page or hub fly-out → small pin/unpin icon appears.
- Drag handle on Favorites items for reorder. Persist on drop.

## Alternatives considered and rejected

**A. Favorites + "More" drawer (rejected):** keeps the current grouped layout but pins favorites to the top and stuffs everything else into an overflow drawer. Lighter to build but doesn't solve the root issue — the "More" drawer just becomes a second mess. The hub approach forces real structure.

**B. Aggressive prune only (rejected):** just hide 6 items in Settings and call it done. Smallest change, but doesn't scale — every new tool added (and you'll keep adding tools) puts you back in the same spot in three months.

**C. Command-palette-only, near-zero sidebar (rejected):** popular with Linear-style power users, but kills discoverability for new users and collaborators. You explicitly want it to remain "ui ux friendly, beautiful" — that needs a visible sidebar.

## Phased implementation

**Phase 1 — Sidebar structure (small, ~1 day):**
- Refactor `PINNED_TOP` in [Sidebar.tsx:43](src/components/layout/Sidebar.tsx#L43) into `TOP`, `FAVORITES`, `HUB_HEADERS`, `BOTTOM` arrays.
- Replace `SECTIONS` with `HUBS` (label + href + color + nested items array, items used by hub pages + palette only).
- Convert section headers to clickable links that navigate to the hub page. Chevron toggles inline expansion.
- Merge Messages + Inbox into one Inbox with tabs.

**Phase 2 — Hub pages (~1 day each, in parallel):**
- `/create`, `/grow`, `/collaborate`, `/automate` — each is a new page rendering primary cards + secondary cards. Reuse an existing card pattern from the codebase (Dashboard cards if they exist).
- Each card: icon, title, one-line description, last-used hint where it makes sense.

**Phase 3 — Pinning (~½ day):**
- Add `sidebar_favorites` storage (server-side prefs or localStorage to start — flag this as an open question below).
- Add pin/unpin button on hub-page cards.
- Add drag-reorder on Favorites in the sidebar (`@dnd-kit/sortable` if not already in deps).

**Phase 4 — Cmd+K palette upgrade (~½ day):**
- Backfill missing routes into `PAGES`.
- Wire keywords to a shared `nav-catalog.ts` so sidebar + palette stay in sync.
- Add Recent + Quick actions sections.
- Add `/` keybinding.

**Phase 5 — Team Hub / Team consolidation (~½ day):**
- Move Team Hub content into `/team` as a tab.
- Add `/team-hub` → `/team?view=hub` redirect to preserve old links.

**Phase 6 — QA pass (rule 6):** golden path on each hub, edge cases (collapsed sidebar, no favorites, all-hidden hubs, mobile width, palette empty state, palette no-match state), regression sweep on every existing route to confirm nothing broke.

Total: ~4–5 working days, easily splittable across separate commits/PRs.

## Settings audit (rule 15)

New controls to surface under Settings → Appearance (create the group if it doesn't exist):

- **Favorites** — list view with add/remove/reorder, mirroring the sidebar (so users who don't realize they can pin from the sidebar can manage from here).
- **Hide hub: Create / Grow / Collaborate / Automate** — power-user toggles. Default all on.
- **Sidebar density** — compact / comfortable. Defaults to comfortable.
- **Palette shortcut** — `⌘K` / `/` / both / disabled.

Intentionally NOT exposed: per-item icon/color customization (too much rope), per-user reordering of the TOP block (too much variability for shared docs and screenshots).

## Observability (rule 14)

Namespaced logs added at every meaningful step. Backend logs are unaffected; this is client-only.

```ts
console.info('[nav favorite]', 'pin', { href, source: 'sidebar' | 'hub' });
console.info('[nav favorite]', 'unpin', { href });
console.info('[nav favorite]', 'reorder', { from, to, hrefs });
console.info('[nav hub]', 'open', { hub: 'create' | 'grow' | ... });
console.info('[nav hub]', 'tier-click', { hub, tier: 'primary' | 'secondary', href });
console.info('[palette]', 'open', { source: 'shortcut' | 'click' });
console.info('[palette]', 'search', { q, resultCount });
console.info('[palette]', 'select', { q, href, rank, group });
console.info('[palette]', 'no-match', { q });
console.info('[inbox]', 'tab-change', { from, to, unread: { messages, comments } });
```

These let me debug "I pinned X and it didn't persist" or "search didn't find Y" from a console paste, without rebuild loops.

## Security / safety (rule 13)

- Sidebar favorites are per-user prefs. If server-side, scope writes by `user_id` from session; reject any payload not matching session user. If localStorage-only (Phase 3 start), no security surface beyond what already exists.
- No new auth surface. No new external dependencies (other than possibly `@dnd-kit` if not present).
- Hub pages must respect the same role/permission gates the existing tool pages do — e.g. don't show "Workflows" card to a role that can't access `/workflows`. Reuse existing route guards.

## Open questions

1. **Storage for favorites — server or local?** Local is faster to ship and good enough for solo use. Server-side syncs across devices and across the team-mode roles. Pick before Phase 3.
2. **Should Inbox tabs include a third tab for system notifications** (deploys, render finishes, errors)? Adjacent to the cleanup, not blocking, but a one-line decision once we're in there.
3. **"Auto-pipeline" deserves to stay in Favorites by default — but where does it live in the hub?** Currently anchored at the top of Create as the "do it all in one click" entry. I'd keep it as the first primary card. Confirm.
4. **Mobile.** The current sidebar likely collapses to a drawer on narrow widths. Verify the new shape behaves there before declaring done.

## Files touched

- [src/components/layout/Sidebar.tsx](src/components/layout/Sidebar.tsx) — main refactor
- [src/components/layout/GlobalCommandPalette.tsx](src/components/layout/GlobalCommandPalette.tsx) — palette upgrade
- New: `src/lib/nav-catalog.ts` — shared nav source of truth
- New: `src/app/(app)/create/page.tsx`, `grow/page.tsx`, `collaborate/page.tsx`, `automate/page.tsx`
- New: `src/components/nav/HubLanding.tsx` — shared hub renderer
- New: `src/components/nav/FavoritesList.tsx` — sidebar favorites with drag
- New: `src/app/(app)/settings/sections/appearance.tsx` (if not present)
- DB or prefs store: add `sidebar_favorites`, `sidebar_hidden_hubs` (Phase 3)
