# Global Comments Inbox

**Date**: 2026-05-12
**Status**: Draft — awaiting approval

## Problem

The owner gives review feedback on narrator takes and video editor versions across many projects. Today, those comments are scoped per-take or per-version and only surface as an "unresolved" badge on the relevant page. Once a take/version is replaced or a comment is marked resolved, the trail vanishes from the owner's main views. The owner has no cross-project way to see "every comment, who wrote it, who it was for, and where it lives."

## Goal

A single inbox surface that shows every comment across the owner's workspace, grouped by author role then author, with unresolved-first defaults, robust filtering, and one-click jump to the original take/version with the comment focused.

Success looks like: owner opens Inbox → sees a clean, scannable map of conversations → finds any past comment in under five seconds.

## Constraints

- Must not invent new design tokens or component patterns — match the existing dark theme (CSS variables in `globals.css`) and the two-pane Messages page convention.
- Must respect workspace tenancy — every query filtered by `workspace_id`.
- Polling at 15–30s for live counts (no WebSockets in the stack).
- No new paid dependencies. Postgres + existing Next.js App Router patterns only.
- Mobile usable but not the primary surface (owner uses this on desktop).

## Requirements (locked by owner)

1. **Scope**: every comment across the owner's projects — review + narration, all authors.
2. **Grouping**: primary by **role** (Owners / Narrators / Editors / Reviewers), secondary by **person**.
3. **Default filter**: unresolved only, with one-click "All / Resolved" toggle plus a deep filter panel.
4. **Entry point**: nav item with unread badge — placed in **sidebar `PINNED_TOP`** (this app has no top-nav nav items; the sidebar `PINNED_TOP` row is the equivalent "always visible" surface and is where Messages already lives).

## Security / safety

- All API routes call `requireUser()` and scope every query by `workspace_id` from the session — no cross-tenant leakage.
- Comment text is rendered as plain text (no `dangerouslySetInnerHTML`) to avoid XSS from collaborator-authored content.
- Deep-link IDs are UUIDs; the destination page re-validates ownership through its existing handlers (we don't trust the inbox-side ID alone).
- No new secrets, no new logging of comment bodies in server logs.
- No PII added beyond what already exists in the comment tables (author_name, author_color).

## Cost

Zero new third-party cost. This runs on existing Postgres and the existing Vercel deployment. Polling at 30s for the unread badge and 15s on the inbox page adds modest read traffic to the same DB the rest of the app already hits.

## Architecture

### Data

Both comment tables already exist:
- `narration_take_comments` — has `author_role` (`'owner' | 'narrator'`).
- `review_comments` — **does not have `author_role`** today. Role has to be inferred from `posted_by_owner` plus a join through `review_share_links` to find the collaborator role.

**Migration**: add `author_role TEXT` column to `review_comments` (nullable, no CHECK constraint so we can extend roles without future migrations). Backfill:
- `posted_by_owner = true` → `'owner'`
- Else: join through `review_versions.project_id` → `review_share_links` matching `collaborator_name` → use `collaborator_role` (typically `'editor'` or `'reviewer'`)
- Fallback: `'reviewer'`

Update the two POST routes that create review comments (`/api/reviews/...` and `/api/editor/[token]/...`) to set `author_role` at insert time.

### Backend

Two new routes:

**`GET /api/inbox`** — returns the unified comment list. Query params:
- `filter` = `unresolved | resolved | all` (default `unresolved`)
- `role` = `owner | narrator | editor | reviewer | all`
- `person_id` = collaborator filter
- `project_id` = scope to one project
- `q` = full-text search on `text`
- `cursor` = pagination cursor (created_at + id)
- `limit` = page size (default 50)

Implementation: `UNION ALL` across both tables with the project join baked in. Each row carries: `source` (`narration | review`), `comment_id`, `text`, `timestamp_ms`, `end_timestamp_ms`, `author_name`, `author_color`, `author_role`, `resolved`, `created_at`, `parent_id`, `fix_for_comment_id`, plus context: `project_id`, `project_title`, `take_id | version_id`, `take_number | version_number`, and the computed `deep_link_url`.

**`GET /api/inbox/unread`** — returns `{ unread: number }` for the sidebar badge. Same `WHERE` as `filter=unresolved` but only `COUNT(*)`. Cheap.

### UI

**Sidebar nav item** — added to `PINNED_TOP` between Messages and the existing items. Uses the existing badge plumbing in `Sidebar.tsx` lines 660-702: define `useCommentsUnread()` hook (mirror of `useMessagesUnread()`), define `CommentsUnreadBadge` / `CommentsUnreadDot`, register a new `'comments-unread'` discriminator in the `NavItem.badge` union.

**Page**: `/inbox` — two-pane layout that mirrors the Messages page exactly so we don't invent a new pattern.

```
┌─────────────────────────────────────────────────────────────────┐
│ Inbox                                              [filter btn] │
│ 23 unresolved · 412 total                                       │
├──────────────────────┬──────────────────────────────────────────┤
│ [search…]            │   ┌─────────────────────────────────┐    │
│ Unresolved | All | R │   │ Avi Cohen (Narrator)            │    │
├──────────────────────┤   │ on "Holiday script" · take 3    │    │
│ ▼ Narrators (12)     │   │                                  │    │
│   Avi · 5 ●          │   │ "Pronounce the brand name…"     │    │
│   Dana · 4 ●         │   │ 2:14 — 2:18                      │    │
│   Yoni · 3 ●         │   │ posted 3 days ago, unresolved   │    │
│ ▼ Editors (8)        │   │                                  │    │
│   Maya · 6 ●         │   │ ┌─ Fix note (v4) ─────────────┐ │    │
│   Tom · 2 ●          │   │ │ Reuploaded with corrected    │ │    │
│ ▼ Reviewers (3)      │   │ │ pronunciation                │ │    │
│   Client X · 3 ●     │   │ └──────────────────────────────┘ │    │
│ ▼ Owners (0)         │   │                                  │    │
│   You · 0            │   │ [Open in source ↗]  [Resolve]    │    │
│                      │   └─────────────────────────────────┘    │
│                      │                                          │
│                      │   ↓ more in this person's list           │
└──────────────────────┴──────────────────────────────────────────┘
```

Left pane (320px on desktop, full-width sheet on mobile):
- Search input.
- Filter chips: `Unresolved` (default) | `All` | `Resolved`.
- "More filters" button → expandable panel with role multi-select, project selector, date range, "has fix note" toggle.
- Collapsible role groups (Owners, Narrators, Editors, Reviewers) — each shows count.
- Inside each role: list of people with comment count + unresolved dot.
- Clicking a person shows their comments in the right pane.

Right pane:
- Selected person's comments, newest first.
- Each comment card: author header, project + take/version chip, comment text, timestamp range (for ranged), resolved/unresolved pill, fix-note thread (rendered inline using the existing `fix_for_comment_id` link), action buttons (`Open in source` and `Resolve` if unresolved and posted by owner).
- Empty state when no person selected: friendly explainer ("Select a person on the left to see their comments").

Deep-link click-through:
- Narration: `/voiceover/<assignment_id>?take=<take_id>&comment=<comment_id>`
- Review: `/reviews/<project_id>?v=<version_id>&comment=<comment_id>`
- Both destination pages: read `?comment=`, scroll the comment into view, briefly highlight it (existing `highlightedId` pattern in `TakeReview.tsx:131`).

Live updates:
- Sidebar badge polls `/api/inbox/unread` every 30s + on window focus (mirrors `useMessagesUnread` pattern).
- Inbox page polls full list every 15s + on focus (mirrors Messages page pattern).
- Optimistic update on Resolve action — zero the comment's unresolved state locally before the server confirms.

Loading / empty / error:
- `PageSkeleton` while initial load runs.
- Distinct empty state for "no comments at all" vs. "no comments match this filter."
- Error banner pattern from existing pages (`background: 'rgba(239,68,68,0.10)'`).

Mobile:
- Single-pane stack: left pane becomes the default view; tapping a person pushes the right pane on top with a back button.
- Filter panel becomes a bottom sheet.

## Alternatives considered

**A. Single flat list with column filters (rejected)**
Easier to build, scales to many comments, but loses the "ordered by user and type of user" property the owner explicitly asked for. Looks like a spreadsheet, not an inbox.

**B. Tabs per role (Owners / Narrators / Editors / Reviewers) (rejected)**
Cleaner visually for small role counts, but hides cross-role context and forces the owner to click between tabs to see "everything." Doesn't match the "single place to find any comment" goal.

**C. Collapsible role groups + person sub-rows (chosen)**
Two-level hierarchy maps cleanly to the requirement, gives instant scan-ability of "how many comments per role," and degrades gracefully when a role is empty (collapsed and dim). Matches the existing two-pane Messages pattern visually.

## Open questions

1. **Resolve permission**: should the owner be able to resolve any comment from the inbox, or only ones authored by collaborators *on* the owner's work? Today the comment APIs allow workspace-owners to resolve anything in their workspace — I'll keep that.
2. **Mark as read vs. resolve**: do we want a separate "read" state distinct from "resolved"? Recommendation: **no for v1**. Conflating "unresolved" with "needs attention" matches the existing model and avoids parallel state machines.
3. **Mentions / @-mentions**: not in scope — comments don't support mentions today. Out for v1.
4. **Email digests**: out for v1.

## Lazy-user walkthrough (rule 10)

- First visit: owner clicks Inbox in the sidebar (the red dot drew their eye). Page opens to the unresolved view. Left pane shows role groups with counts. They click the first narrator with an unresolved dot. Right pane fills with that narrator's open comments, newest first. They read, decide to jump to the source. One click → they're inside the take with the comment highlighted.
- Returning visit: owner remembers giving a comment last week but can't find it. They click Inbox. Switch the filter chip from "Unresolved" to "All." They remember it was a comment they wrote → they expand "Owners → You." Their comments are listed. They search a keyword in the box if the list is long. Two clicks total.
- Mobile: same flows; pane transitions replace side-by-side.
- Edge cases: zero comments yet → empty state with a one-liner pointing to projects. No collaborators in a role → that role group is collapsed and dim (still shown so the owner sees the shape of the org). Comment whose source take/version was deleted → comment still shows, "Open in source" disabled with a tooltip "source removed."

## File map (what gets touched)

New:
- `src/lib/migrations/00XX_add_author_role_to_review_comments.ts`
- `src/app/api/inbox/route.ts`
- `src/app/api/inbox/unread/route.ts`
- `src/app/(app)/inbox/page.tsx`
- `src/components/inbox/InboxSidebar.tsx`
- `src/components/inbox/InboxThread.tsx`
- `src/components/inbox/InboxFilters.tsx`
- `src/lib/inbox-db.ts` — the aggregated query helper

Modified:
- `src/components/layout/Sidebar.tsx` — add nav item + `useCommentsUnread` + badge components
- `src/lib/review-db.ts` — set `author_role` on insert in `createReviewComment`
- `src/app/api/editor/[token]/.../comments/route.ts` — set `author_role` on insert
- `src/app/(app)/reviews/[id]/page.tsx` and `/play/page.tsx` — read `?comment=` and scroll/highlight
- `src/components/narrator/TakeReview.tsx` and the assignment page — read `?comment=` and scroll/highlight

## QA plan

Golden path:
- Inbox loads with unresolved-first view, role groups visible, badge in sidebar matches the page's unresolved total.
- Click person → right pane shows their comments → click "Open in source" → destination page scrolls/highlights the right comment.
- Resolve from inbox → optimistic update, badge decrements, comment moves to resolved view after next refresh.

Edge cases:
- Comment whose source take/version is deleted: still appears, "Open in source" disabled.
- Comment with parent_id (a reply): rendered inside the parent's thread, not as a top-level entry in the person list.
- `fix_for_comment_id` chains: shown as inline fix-note cards within the original.
- Search with empty result set: distinct empty state from "no comments at all."
- Workspace with 1000+ comments: cursor pagination, search hits the indexed `text` (need a `pg_trgm` index — verify before launch).
- Mobile narrow viewport: single-pane stack works; bottom-sheet filters open.
- Polling collision with a resolve action mid-flight: the local optimistic state wins until the next poll confirms.

Regression checks:
- Sidebar layout still aligns when the new badge is present.
- Messages unread badge still works.
- Existing narrator/editor portals unaffected by the `author_role` write on insert.
- Migration is idempotent and safe to re-run.

## Effort estimate

- Migration + backfill: ~1h
- Backend (`/api/inbox`, `/api/inbox/unread`, helpers): ~3h
- Sidebar nav item + badge: ~30m
- Inbox page (two-pane, filters, search): ~4h
- Deep-link handling on destination pages: ~1h
- QA + polish: ~1.5h
- **Total: ~one focused day**

## Rollout

No flags. Ship the migration, then the API, then the UI. Sidebar item only renders if the user has at least one collaborator-comment in their workspace (so empty workspaces don't see a dead nav entry) — guarded by the existing unread hook returning `0` and a separate "has any comment" probe that can be folded into the unread endpoint as `{ unread, totalAll }`.
