# Channel filter + IN PIPELINE chip + New Video dialog redesign

**Date**: 2026-05-27
**Branch**: `claude/video-creation-ui-pqXzS` (post-merge with `fix/render-broll-stuck`)

## Goals

Three user-facing fixes that came in together because they all sit at the
"how do I find/open a video" seam of the Command Center:

1. **Channel filter actually filters.** Today, clicking a channel chip on
   the Command Center top bar does nothing visible because unchanneled
   cards (and there are many) leak past the filter.
2. **`IN PIPELINE` chip is a real entry point.** On the Start-a-batch
   scheduled-items picker, the `IN PIPELINE` badge currently does nothing
   — clicking it just toggles the row's selection. It should deep-link to
   the pipeline run that owns the item so the user can edit / retry / stop.
3. **`+ New video` is a universal entry point.** Today it only creates a
   blank video. The user wants it to also let them start a video from an
   existing Idea / Schedule item / draft script, and to act as an
   "open existing" search across Ideas / QA results / Scripts / Projects.

## Constraints

- This is a UI / UX repair pass, not a redesign of the underlying data
  model. No schema changes. No new tables.
- Cost-aware: no new paid-API calls. Existing endpoints only.
- Workspace-scoped, like everything else in the app — all reads go through
  the existing authed routes.
- No removed options (per the standing rule about UI redesigns being
  supersets — the existing `+ New video → blank` flow must stay reachable
  in one click).

## Requirements

User stories:

- "When I click *The Cyber Explainer* in the channel filter, I want to
  see only that channel — not all of them." (Single-click = filter to one.
  Cmd/Ctrl+click to add another. Most-intuitive default.)
- "When I see an `IN PIPELINE` badge next to a scheduled item, I want to
  click it and land on the pipeline run for that item." (Currently a dead
  label, advertised as actionable.)
- "When I click `+ New video`, I want one place to start from a blank
  slate, OR start from an existing idea / schedule item / script draft,
  OR open something that already exists." (One entry point covers every
  realistic "I want to make/edit a video" intent.)

## Chosen approach

### Task 1: Channel filter

[src/app/(app)/command-center/CommandCenterClient.tsx](../src/app/(app)/command-center/CommandCenterClient.tsx)

**Root cause**: line 126's filter short-circuits to falsy on `card.channel?.id`,
so unchanneled cards (`channel: null`) bypass the filter regardless of
which chips are selected. Compounding issue: the default state is "all
chips selected" and clicking a chip *deselects* it — opposite of what a
lazy user expects.

**Fix**:
- Add a `null` sentinel chip (`No channel`) alongside the channel chips so
  unchanneled cards have an explicit toggle.
- Use the sentinel `'__no_channel__'` inside the filter set.
- Replace the deselect-toggle interaction with a click-to-filter-to-one
  semantic: clicking a chip selects only that chip and deselects the rest.
  Cmd/Ctrl+click adds to the current selection. A small "Reset" affordance
  reverts to "all chips selected."
- Fix the filter expression so `null`-channel cards are included only when
  the sentinel chip is in the filter set.

### Task 2: `IN PIPELINE` chip → deep link

[src/app/(app)/pipeline/new/page.tsx](../src/app/(app)/pipeline/new/page.tsx)
and
[src/app/api/schedule/picker/route.ts](../src/app/api/schedule/picker/route.ts)

**Data**: the picker response carries `pipeline_run_video_id` but not
`pipeline_run_id`. We need the run id to build `/pipeline/{runId}`. Add a
LEFT JOIN on `pipeline_run_videos` to expose `pipeline_run_id`.

**UI**: render the chip as an `<a>` (or styled `Link`) with
`onClick={e => e.stopPropagation()}` so it navigates without also toggling
the row's selection. Visual: keep the red badge tone, add an arrow icon
and `hover:underline` to telegraph clickability.

### Task 3: `+ New video` dialog redesign

[src/app/(app)/command-center/NewVideoDialog.tsx](../src/app/(app)/command-center/NewVideoDialog.tsx)

The dialog grows two top-level tabs:

- **Create** (default; preserves current behavior):
  - Sub-tab **Blank** — title + channel + publish date, then POST /api/videos.
  - Sub-tab **From idea** — pick from saved ideas; pre-fills title from
    idea title, then POST /api/videos with the idea linked.
  - Sub-tab **From schedule item** — pick from schedule items; pre-fills
    title from item title + (optional) idea_id, then POST /api/videos.
  - Sub-tab **From draft script** — pick from saved drafts via
    `/api/drafts`; pre-fills title from draft title, links draft to the
    new video.
- **Open existing**:
  - Unified search across Projects / Schedule items / Ideas / Drafts.
  - Selecting a Project jumps to its current-stage tool path.
  - Selecting an Idea jumps to `/generator?ideaId=…` (script-gen with
    that idea preloaded).
  - Selecting a Schedule item jumps to `/schedule?focus=<id>`.
  - Selecting a Draft jumps to `/generator?draftId=…`.
  - QA results aren't a separate source — QA always lives inside a
    project, so QA jumps go through the project's current stage path.

**Endpoints reused**:
- `/api/videos` (POST) — create new video, accepts `ideaId`,
  `scheduleItemId`, `draftId` (extend as needed).
- `/api/ideas?saved=true&limit=100` — saved ideas list.
- `/api/schedule/picker` — schedule items (already exists post-merge).
- `/api/drafts` — saved drafts (verify shape).
- `/api/command-center/cards` — projects search (already loaded; reuse
  the in-memory list the kanban already has).

**Behavior on Open existing → Project**: use the existing
`getStageDef(card.current_stage).toolPath` resolver the kanban already
uses, so the same routing logic applies.

## Alternatives rejected

1. **Radio-style channel filter (one channel at a time, dropdown)**:
   simpler mental model but loses multi-channel views and feels like a
   regression. Rejected.
2. **Make the `IN PIPELINE` chip click toggle selection AND deep-link
   together via shift-click**: too clever; the chip's tooltip already
   advertises clickability, the user expects it to navigate. Rejected.
3. **Source-picker only (no Open existing tab)**: doesn't cover the
   user's stated "I want one entry point for everything." Rejected.
4. **Build the New Video flow into the kanban directly (no dialog)**:
   forces the user to scroll to the right column for the stage they
   want, which is more friction than a dialog. Rejected.

## Security / safety

- All reads go through existing `apiRoute.authed` endpoints; no new
  unauthenticated surface area.
- The picker's new `pipeline_run_id` field is workspace-scoped via the
  existing JOIN constraint on `pipeline_run_videos.workspace_id`.
- The deep-link target `/pipeline/{runId}` is itself authed.
- No PII in new logs. Existing `console.info('[command-center …]')`
  pattern continues for new chip + tab interactions.
- The dialog's Open-existing tab does NOT mutate state — it only
  navigates. POST endpoints are still gated behind explicit "Create"
  actions.

## Open questions

None left after the round of clarifying questions on 2026-05-27. If
implementation surfaces a new ambiguity, pause and ask.

## Verification plan

After each task:

1. **Channel filter**:
   - Click `The Cyber Explainer` — only its cards show, "No channel"
     row disappears.
   - Cmd+click `plaintextexplainer` — both show.
   - Click `No channel` chip — only the 19 unchanneled cards show.
   - Reset → all chips active → all cards show.

2. **IN PIPELINE chip**:
   - Click an `IN PIPELINE` chip on `/pipeline/new` → lands on
     `/pipeline/{runId}` with the run open.
   - Click the surrounding row (not the chip) → still toggles selection
     (existing behavior preserved).

3. **New Video dialog**:
   - `+ New video → Create → Blank` → existing flow works.
   - `+ New video → Create → From idea` → idea picker shows; pick one,
     dialog creates project, jumps to `/generator?videoId=...`.
   - `+ New video → Open existing → search "antivirus"` → matches across
     projects, ideas, drafts, schedule items.
   - Picking a project jumps to its current-stage tool path.
