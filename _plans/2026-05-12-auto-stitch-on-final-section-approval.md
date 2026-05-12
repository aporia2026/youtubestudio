# Auto-stitch the narrator's takes when the final per-section approval lands

## Goal

When an owner approves the last remaining per-section take in the team-hub
(or the legacy narrator portal), automatically stitch all approved takes
into a single voiceover and attach it to the project as a `media_assets`
row, so the project's Voiceover panel and the workspace-wide voiceover
library stay in sync with the narrator-task status the owner sees.

## Problem this fixes

Today, the only two paths that insert a `type='voiceover'` `media_assets`
row are:

- `POST /api/narrator/assignments/[id]/approve-full` — single-file upload
- `POST /api/narrator/assignments/[id]/stitch` — manual stitch button

The per-section approval path (`PUT /api/narrator/assignments/[id]/sections/[sectionId]`)
sets `narrator_sections.status = 'approved'` and updates the assignment,
but does **not** insert a media_asset. The team-hub UI calls this PUT
endpoint when the owner approves a take; it does not expose stitch or
approve-full.

Result: assignments approved end-to-end via team-hub appear "Approved" /
"Completed" in the narrator-tasks table, but the project they belong to
has no voiceover, and other projects in the workspace cannot find them
via "Browse library". The narrator artifact and the project artifact have
drifted apart.

## Approach (recommended)

When the final per-section approval lands, fire stitch automatically. The
predicate "every real section is approved" is already used by
`tryAdvancePipelineFromNarration` (in `src/lib/auto-pipeline/narrator-hook.ts`)
to decide whether to advance a linked pipeline — reuse the same shape.

Concretely:

1. **Extract the stitch core** from
   `src/app/api/narrator/assignments/[id]/stitch/route.ts` into a shared
   helper `src/lib/narrator-stitch.ts` exporting
   `stitchAssignmentVoiceover(assignmentId): Promise<StitchResult>`.
   The helper preserves the existing behavior exactly (no idempotency
   guard inside; that's the caller's job).

2. **Refactor the manual stitch route** to call the helper. Same error
   shapes, same status codes.

3. **Add an auto-stitch trigger** to `PUT /api/narrator/assignments/[id]/sections/[sectionId]`:
   when the just-updated section's status is `'approved'`, run a single
   SQL check:
   - Are all sections with `section_number != 0` on this assignment now
     `status = 'approved'`?
   - AND no `media_assets` row already exists for this assignment with
     `metadata->>'assignment_id' = <id>` AND
     `(metadata->>'stitched' = 'true' OR metadata->>'full_narration' = 'true')`?

   If both true, fire `stitchAssignmentVoiceover(assignmentId)` as
   fire-and-forget (matches the existing `dispatchNarrationHookFireAndForget`
   pattern in the same file). The narrator response returns immediately;
   stitch runs on the same instance.

## Alternatives considered, rejected

**B — Surface a "Stitch & publish" button in team-hub.** Honest about the
manual step but every owner has to remember it; the bug recurs on the
first forgotten click. Adds UI surface area for what should be invisible
plumbing.

**C — Include unapproved/in-flight narrator takes in the
voiceover-library query.** Wrong fix — would surface half-done audio in
the library and break the contract that the picker offers reusable
finished voiceovers.

**D — Background cron worker that scans for "completed but unpublished"
assignments.** Heavier scope (new table column or scan logic), worse UX
(arbitrary delay between approval and the project seeing the voiceover).

## Why fire-and-forget on the same instance is acceptable

- Same pattern already lives in this route file
  (`dispatchNarrationHookFireAndForget`). Owner has accepted the tradeoff
  there.
- Stitch is heavy (downloads + concat + Vercel Blob upload) but typical
  narrations are a handful of sections summing to single-digit minutes of
  audio. The 300s `maxDuration` budget on the parent route handles this.
- If the instance is killed mid-stitch (e.g. cold-recycled), the
  idempotency guard means the next approval *or* a manual stitch click
  will safely retry — the helper's media_asset insert is the last
  observable side effect, so partial work doesn't leave the system in a
  bad state.

## Open questions

None blocking. If telemetry shows auto-stitch consistently times out for
big assignments, follow-up work: invoke stitch via internal HTTP fetch
with its own function budget (requires an internal auth token), or move
to a queued worker.

## Security / safety

- Workspace tenancy: the section route already enforces ownership via
  `updateSection` → narrator_db. The auto-stitch helper inherits the same
  scope; the inserted `media_assets` row copies `workspace_id` from the
  parent project (matches existing approve-full/stitch behavior).
- Idempotency guard prevents duplicate voiceover rows on repeat
  approvals (e.g. an owner toggling a take between approved/retake).
- Failure is logged, never thrown — the approve response is independent
  of stitch success, same as the existing pipeline hook.

## Files

New:
- `src/lib/narrator-stitch.ts`

Modified:
- `src/app/api/narrator/assignments/[id]/stitch/route.ts` (delegate to helper)
- `src/app/api/narrator/assignments/[id]/sections/[sectionId]/route.ts` (auto-stitch hook on final approval)
