# Add a project to the schedule from the project detail page

Date: 2026-06-01
Status: approved, implementing

## Goal

From a project's detail page (`/projects/[id]`), let the user add the project to
the schedule as a new schedule item, linked back to the project. Today there is
no native control for this on the project page.

## Decisions (confirmed with user)

- **Add flow:** quick add — reuse the existing `AddToScheduleButton` popover that
  only asks for a channel. New item gets `status='idea'`, title from the project,
  and is linked via `project_id`.
- **Already scheduled:** always keep the Add button visible (a project can have
  multiple schedule items, e.g. multi-part series). Additionally show a small
  non-blocking "On schedule (n)" link to the schedule when at least one linked
  item exists. We never hide the affordance (see memory: never remove options).

## What already exists

- `src/components/ui/AddToScheduleButton.tsx` — shared popover that POSTs to
  `/api/schedule`. Gap: it never sends `project_id`, so created items are not
  linked to a project.
- `POST /api/schedule` (`src/app/api/schedule/route.ts`) already accepts
  `project_id` and the `schedule_items.project_id` FK column exists.
- `GET /api/schedule` has no `project_id` filter, so the project page cannot
  currently detect existing linkage.

## Changes

1. **`AddToScheduleButton.tsx`** — add optional `projectId?: string` prop, send it
   as `project_id` in the POST body. Add optional `onAdded?: (id: string) => void`
   callback fired after a successful create so the parent can refresh. Both
   optional and backward compatible; existing callers unaffected.

2. **`GET /api/schedule`** — support a `project_id` query param that filters
   `si.project_id = $n::uuid`, mirroring the existing clause-composition pattern.

3. **`projects/[id]/page.tsx`** —
   - Fetch `/api/schedule?project_id=${id}` in `fetchAll` (added to the
     `Promise.all`), store linked items in state.
   - Mount `AddToScheduleButton` in the header button group with
     `projectId={id}`, `title={project.title}`, `pillar={project.niche}`,
     `autoLink={false}`, and `onAdded` re-fetching the linked items.
   - When linked items exist, render a subtle "On schedule (n)" link to
     `/schedule` next to the button.

## Out of scope

- No date/status picker (quick add only, per decision).
- No changes to the schedule page itself.

## Security / safety

- All schedule reads/writes go through `apiRoute.authed`, which scopes every
  query to `session.ws` (workspace). The new `project_id` filter keeps the
  workspace anchor as `$1`, so cross-workspace reads remain impossible.
- `project_id` is cast `::uuid`, so a malformed value errors rather than
  matching anything; no string interpolation into SQL.

## QA checklist

- Project not yet scheduled: button shows, popover lists channels, Add creates a
  linked item; "On schedule (1)" link appears after.
- Project already scheduled: button still shows, count reflects reality.
- Created item appears on `/schedule` under the chosen channel and is linked to
  the project (production-doc `ScheduleLinkBanner` round-trip still works).
- Other pages using `AddToScheduleButton` (qa, voiceover, thumbnails, seo,
  ideas, generator) are unchanged (no `projectId` passed).
