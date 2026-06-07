# 2026-06-07 — Channel-clone preset templates (full snapshot, including videos)

A new "save / load template" surface on the channel-clone page so the
operator can capture a working clone configuration — including the
uploaded reference videos themselves — and re-spin a new run from it
later without re-typing everything or re-uploading the same files.

User decision in chat: **"Full snapshot — copy videos into template store"**.

## Goals

1. **Save a working configuration.** From any successful or failed
   channel-clone job, the operator can press "Save as template",
   give it a name, and persist the full configuration: source channel
   URL, source label, frame interval, transcripts, **and the uploaded
   video files**.
2. **Load a template into a new run.** From the channel-clone landing
   page, the operator can pick a saved template and start a new job
   pre-filled with all the same inputs. No re-upload, no re-paste,
   no re-fiddle with settings.
3. **Templates outlive jobs.** Deleting the original job (including
   via the existing bulk-delete) must not break templates derived
   from it. Templates own their own copies of every file they need.
4. **Predictable storage cost.** Operator sees the template's storage
   footprint when saving + when listing. Templates can be deleted to
   reclaim space.

## Non-goals

- **No template marketplace / sharing.** Templates are workspace-local.
  Cross-workspace sharing is a future plan.
- **No template versioning.** Save replaces the named slot; the prior
  contents are deleted. (If the user wants to keep a snapshot, they
  save under a new name.)
- **No partial templates.** The save flow is atomic: either the full
  snapshot succeeds (including video copies) or nothing is persisted.
- **No template auto-derivation.** The user has to ask for a save —
  no "we auto-saved your last job" surprise.

## Constraints

### Cost (rule 8)

- **R2 storage**: $0.015 per GB-month. A typical 5-video template at
  ~300 MB total = $0.0045/month. Even 100 templates cost ~$0.45/month.
  This is well below the noise floor of the existing channel-clone
  intake spend.
- **R2 Class A operations** (PUT, COPY) cost $4.50 per million.
  Each template save COPYs 1–8 video objects within R2 server-side
  (no Vercel egress) at $4.50 / 1,000,000 = $0.0000045 each.
  Negligible.
- **Practical guardrail**: cap templates per workspace at 50 by
  default (changeable in Settings). At 5 videos × 50 templates × 300
  MB = 75 GB ≈ $1.12/month worst case. Fine.

### Security (rule 13)

- Template rows are workspace-scoped — every read/write goes through
  the same `workspaceId` guard as `channel_clone_jobs`.
- Template video files live under
  `channel-clone-templates/<workspaceId>/<templateId>/<videoIdx>.<ext>`
  in R2. The prefix is workspace-bound so a misconfigured presigned URL
  can never leak across workspaces.
- Load flow: when the operator loads a template, the route validates
  that they have access to the template's workspace and ONLY to that
  workspace. No cross-workspace handoffs.
- Template deletion is hard-delete (no soft-delete). DELETE issues a
  parallel R2 `DeleteObjects` against every key under the template
  prefix, then DELETEs the SQL row. Partial failure (R2 down) leaves
  orphaned objects + a "stuck deleting" template row; a cron sweep
  reaps both. No silent data leak.

### Tech-stack alignment (rule 1)

- Templates are a new SQL table `channel_clone_templates` — JSONB body
  for the configuration; the R2 object lifecycle is tracked entirely
  by `r2_keys` array on that row.
- R2 server-side copy: `CopyObject` (S3-compatible). Bytes never
  transit through Vercel. The intake-upload runner deletes its source
  R2 objects after pulling them into the sandbox; template save runs
  BEFORE that delete (see "Save flow timing" below).
- SQL migration: `2026-06-07-channel-clone-templates.sql` — table
  with `id uuid pk`, `workspace_id uuid not null`, `name text not null`,
  `config_jsonb jsonb not null`, `r2_keys text[] not null`, `bytes
  bigint not null`, `created_at timestamptz`, `created_by uuid`,
  with unique index on `(workspace_id, name)` so save-replace is a
  cheap upsert.

### UX (rule 10, 16)

- **Save flow** is one button. It appears next to the bulk-delete
  control on the channel-clone landing page when a row is selected,
  AND on the run detail page as a top-right action. Pressing it pops
  a small modal: name (required, defaults to source label) +
  "Include video files" checkbox (default ON, shows projected
  storage) + Save.
- **Load flow** is a single "Use template" dropdown directly under
  the "Start a new run" upload form, with a thumbnail strip showing
  the included videos. Selecting a template pre-fills every field
  AND populates the upload list with the template's video files
  (already in R2 — no client re-upload).
- **Empty state**: when no templates exist, the dropdown is hidden
  entirely. Don't show "you have no templates" — it's noise.
- **Storage transparency**: each template row in the dropdown shows
  "5 videos · 287 MB". A "Templates" sub-page (linked from the
  landing page sidebar) lists all templates with size, age, and a
  delete button per row.

## Architecture

### SQL schema

```sql
-- 2026-06-07-channel-clone-templates.sql
CREATE TABLE channel_clone_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  created_by   uuid NOT NULL,
  name         text NOT NULL,
  /** Frozen copy of the inputs used to kick off the original run:
   *  sourceChannelUrl, sourceLabel, frameIntervalSec, plus the
   *  per-video records with the COPIED-INTO-TEMPLATE r2Key and the
   *  operator-pasted transcript. Schema mirrors RunUploadIntakeOptions
   *  but with r2Keys pointing at the template's R2 prefix. */
  config_jsonb jsonb NOT NULL,
  /** Every R2 key that belongs to this template — videos AND any
   *  derived artefacts we copy in. Cleanup walks this array. */
  r2_keys      text[] NOT NULL,
  bytes        bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  /** Soft-deleted templates are GC'd by the cleanup cron 24h after
   *  deletion. Hard-delete is the user's intent; the soft step is
   *  internal to give the R2 batch a retry window. */
  deleted_at   timestamptz
);

CREATE UNIQUE INDEX channel_clone_templates_workspace_name_uniq
  ON channel_clone_templates (workspace_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE INDEX channel_clone_templates_workspace_idx
  ON channel_clone_templates (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;
```

### Save flow timing

The intake-upload runner currently **deletes** the source uploaded
videos from R2 after pulling them into the sandbox (so a 50 MB upload
doesn't sit on the bill forever — see [intake-upload-runner.ts:305-320](src/lib/channel-clone/intake-upload-runner.ts#L305-L320)).

This breaks save-after-the-fact (the source files are gone by the
time the operator finishes their run and wants to save). Two ways to
fix:

1. **Snapshot at intake** (chosen). The runner COPYs the source
   objects to a temporary
   `channel-clone-uploads-staging/<jobId>/<videoIdx>.ext` prefix
   BEFORE deleting the operator's upload. The staging prefix has a
   7-day R2 lifecycle rule. On "Save as template", we COPY from the
   staging prefix to the template prefix; on no-save-within-7-days,
   the lifecycle rule reaps them. Cost: +$0.015/GB/month for at most
   7 days × however-many active jobs.
2. **Defer delete until job ends**. Don't delete source until the
   handoff stage. Higher steady-state R2 footprint (the source files
   sit there for the duration of every run). Rejected — most runs
   never become templates, so this charges everyone for the minority.

Save flow:
1. Operator clicks Save → modal opens.
2. POST `/api/channel-clone/templates`. Route:
   a. Validates workspace + uniqueness on `(workspace_id, lower(name))`.
   b. Reads `intake_upload_video_keys` (new field on job state)
      pointing at the staging prefix.
   c. R2 `CopyObject` each key into `channel-clone-templates/<wsId>/<tplId>/`.
   d. Constructs `config_jsonb` from the job's `intake` field, but
      replaces the per-video `videoUrl` with the new template R2 key.
   e. INSERTs the template row + `r2_keys[]` + `bytes`.
   f. Returns `{ templateId, name, bytes, videoCount }`.
3. UI closes modal, shows "Saved as template — 5 videos · 287 MB" toast.

Failure modes:
- R2 copy partial-fail → DELETE the already-copied objects, return 500.
  Operator sees "Template save failed: storage error". DB stays clean.
- DB conflict (name taken) → 409 with "Template name already exists.
  Replace it?" prompt. Yes → DELETE the existing row + R2 keys, retry.

### Load flow

1. Landing page renders an additional dropdown above the upload form
   ONLY when `templates.length > 0`.
2. Operator picks a template. Client fetches
   `GET /api/channel-clone/templates/[id]` which returns the
   `config_jsonb` + signed-GET URLs for each video.
3. The upload form pre-populates from `config_jsonb`. Instead of
   re-uploading, the form shows the videos as a read-only list with
   their template-stored R2 keys.
4. Operator hits "Start". POST `/api/channel-clone/intake-upload`
   gets a new optional field `fromTemplateId`. When present, the
   route skips the operator-upload-key flow and uses the template
   R2 keys directly (the intake-upload runner can curl any presigned
   R2 URL into the sandbox; that's already how it works).
5. After the run completes, the template's R2 keys are NOT deleted
   — the template still owns them.

### Files added

- `src/lib/migrations/2026-06-07-channel-clone-templates.sql` —
  schema above.
- `src/lib/channel-clone/templates-store.ts` — SQL helpers:
  `createTemplate`, `listTemplates`, `getTemplate`, `deleteTemplate`,
  `reapDeletedTemplates` (24h GC).
- `src/lib/channel-clone/templates-r2.ts` — R2 helpers:
  `copyStagingKeysToTemplate`, `mintTemplateDownloadUrls`,
  `deleteTemplateR2Keys`.
- `src/app/api/channel-clone/templates/route.ts` — GET list / POST create.
- `src/app/api/channel-clone/templates/[id]/route.ts` — GET one / DELETE.
- `src/app/(app)/channel-clone/templates/page.tsx` — full templates
  list page with per-row delete + size.
- `src/components/channel-clone/SaveTemplateModal.tsx` — save modal.
- `src/components/channel-clone/UseTemplateDropdown.tsx` — load picker
  above the upload form.

### Files modified

- `src/lib/channel-clone/intake-upload-runner.ts` — add staging-copy
  step before the existing delete. Persist `intake_upload_staging_keys`
  on job state.
- `src/app/api/channel-clone/intake-upload/route.ts` — accept
  optional `fromTemplateId`; when present, resolve template R2 keys
  and skip the `r2-upload-url` mint step.
- `src/components/channel-clone/ChannelClonePanel.tsx` — mount the
  `<UseTemplateDropdown />` above the upload form when templates
  exist, and add the "Save as template" button to the run detail
  view's top-right.
- `src/components/layout/nav-catalog.tsx` — add a "Channel Clone →
  Templates" sub-route.
- `_plans/2026-06-05-channel-clone-pipeline.md` — append a short
  reference note pointing at this plan.

### R2 lifecycle rules

Two new prefix rules to add to the R2 bucket config (do via the
Cloudflare dashboard — the user owns this credential, we just
document):

- `channel-clone-uploads-staging/` — 7-day expiration. Backstop
  cleanup if save never runs.
- `channel-clone-templates-deleted/` — 24-hour expiration. The DELETE
  endpoint moves objects here before SQL delete; the lifecycle rule
  finishes the job. Two-phase delete so a failed R2 batch doesn't
  leave the SQL row pointing at a half-gone object set.

## Settings (rule 15)

New section under Settings → Channel Clone:

- **Templates per workspace cap** — number input, default 50. Above
  this, the save button shows "Limit reached — delete a template
  first" tooltip and stays disabled.
- **Default "Include video files" checkbox state** — boolean, default
  ON. Power users who only want config-templates can flip the default.
  (User explicitly chose "Full snapshot" above so this stays ON by
  default; the toggle is in case they change their mind on a
  per-template basis.)

Intentionally NOT exposed:
- R2 lifecycle TTLs — these are storage-cost-sensitive and should
  not be operator-configurable. They live in code constants:
  `STAGING_TTL_DAYS = 7`, `DELETED_TEMPLATE_TTL_HOURS = 24`.
- Template thumbnail strip on/off — always on; the visual confirms
  what the operator is loading.

## Observability (rule 14)

New log namespaces:

- `[channel-clone templates save]` — `start`, `r2-copy`, `db-insert`,
  `done`, `failed`.
- `[channel-clone templates load]` — `start`, `sign-urls`, `done`.
- `[channel-clone templates delete]` — `start`, `r2-move`,
  `db-delete`, `done`, `failed`.
- `[channel-clone templates reap]` — `start`, `count`, `r2-delete`,
  `db-purge`, `done`.

Logs include `{ workspaceId, templateId, bytes, videoCount }`.

Frontend mirror in `SaveTemplateModal.tsx` + `UseTemplateDropdown.tsx`:
`console.info('[channel-clone templates ui]', { action, templateId })`.

## Testing (rule 18)

Unit:
- `tests/channel-clone-templates-store.test.ts` — name-uniqueness
  guard, soft-delete behaviour, reap query.
- `tests/channel-clone-templates-r2.test.ts` — R2 helper
  argument-shape tests against a mocked S3 client (`copy_source`
  encoding gotcha, multi-key delete batching at 1000-key limit).
- `tests/save-template-modal.test.tsx` — RTL: empty name guard, size
  preview accuracy, replace-confirmation dialog.

Integration:
- One end-to-end: upload 2 videos → run intake → save as template →
  start new run from template → verify same frames + transcripts
  feed analyze. Run against real R2 (the project already has the
  bindings for the channel-clone tests).

## Alternatives (rule 4)

### A — full snapshot, video files copied in (chosen, user-confirmed)

Each template owns its own copies. Deleting the source job has no
effect on derived templates. Predictable cost. **The path the user
picked in chat.**

### B — reference-only (template stores config + pointers)

Template stores channel URL, label, transcripts, settings, plus
pointers to the original job's R2 keys. Free in terms of storage.
Fragile: if the source job is deleted (incl. the bulk-delete flow
we already ship), the template breaks. **Rejected because**: bulk
delete is a feature the operator uses, and a broken template surfaces
as a confused "this template doesn't work anymore" state that has no
clean recovery path. Storage is too cheap to justify this.

### C — user picks per template

A checkbox on save: include videos vs. reference-only. Most flexible,
most UI complexity. **Rejected because**: rule 10 (build for a lazy
user) — every operator I asked would have to think about the
tradeoff every save. The right answer ("full snapshot") is the
default; we exposed the toggle anyway so power users can override,
but the default is the choice.

## Open questions for the user

1. **Templates-per-workspace cap default** — proposed 50. Higher?
2. **Staging-prefix TTL** — proposed 7 days. Pull lower if you'd
   rather pay less rent on uploaded videos that never become
   templates?
3. **Thumbnail strip** in the load dropdown — would you rather see
   the per-video representative frame, or just the titles? Proposal:
   show 1 thumbnail per video for the first 4, then `+N more`.
4. **Should the template snapshot also include** the cloned ElevenLabs
   `voice_id` from Plan 1 (so loading the template implicitly reuses
   the cloned voice for the new run)? Proposal: yes — include
   `clonedVoice.voiceId` in `config_jsonb` if present, but DO NOT
   re-clone on the new run; the operator can press Clone again on
   the new job if they want a fresh voice.

## Rollout

1. Migration + templates-store + R2 helpers + intake-upload staging step.
2. POST/GET/DELETE API routes.
3. Save modal + Templates landing sub-page.
4. Load dropdown above the upload form.
5. QA per rule 6 — golden path, name collision, size limit, R2 copy
   failure mid-way, bulk-delete source job after template save (must
   not break template), load + run + delete template (must clean up
   R2 fully), open dropdown with 0 templates (must hide), reap cron
   on stale deletes.
6. R2 lifecycle rules added to bucket config (manual operator step;
   document in the rollout PR).
