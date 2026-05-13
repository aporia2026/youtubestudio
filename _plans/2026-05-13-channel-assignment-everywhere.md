# Channel assignment across the studio

**Date**: 2026-05-13
**Branch**: phase-1-foundation
**Status**: approved, executing Phase 1

## Goal

Every work product in the studio (projects, scripts, voiceovers, B-roll, critic panels, reviews, narrator takes, shorts, ab_tests, video_search_terms, video_format_tags, series) can be associated with one or more channels, assignable in bulk from the relevant list page. Listing/filtering screens respect the link.

## Requirements

- Bulk-assign affordance modeled on the existing `schedule` page: select rows → "Assign channels ▾" popover → pick channels → Add or Replace mode → apply.
- Project artifacts (scripts, voiceovers, B-roll, critics, reviews, narrator takes, shorts) inherit the channel transitively via their parent project.
- The four orphan tables (`ab_tests`, `video_search_terms`, `video_format_tags`, `series`) keep their existing single-FK `channel_id` and get their own bulk-set UI.
- Multi-tenant safety: every endpoint must verify all IDs belong to the caller's workspace before mutating. No partial writes.

## Chosen approach

- **Anchor model**: `projects` is the channel anchor. New join table `project_channels (project_id UUID, channel_id UUID)` with composite PK and CASCADE FKs, mirroring `schedule_item_channels`.
- **Cardinality**: multi-channel, matching schedule.
- **Workspace scoping**: derived via the parent project's `workspace_id` — no own column on the join table.

## Alternatives rejected

- **Per-entity links everywhere** — seven near-identical bulk UIs, seven migrations, and a real risk of an artifact's channel drifting from its parent project's. Fragmentation theater.
- **Single-channel on projects** — contradicts the schedule's model (cross-posting), and forces a future migration the first time someone targets two channels with one project.
- **Single mega-PR** — too much surface to review safely.

## Phases

### Phase 1 — Anchor + bulk-assign on projects (this PR)

1. Migration `0062_create_project_channels` — join table, composite PK, FK CASCADE on both sides, listing index on `channel_id`.
2. `POST /api/projects/bulk-assign-channels` — `apiRoute.authed`, validates UUIDs, verifies every `item_id` and `channel_id` belongs to `session.ws`, then runs the same single-CTE `add`/`replace` pattern as the schedule endpoint. Reuses MAX_ITEM_IDS=500 / MAX_CHANNEL_IDS=50 ceilings + rate-limit.
3. **Security drive-by**: harden the existing `POST /api/schedule/bulk-assign-channels` — currently has no auth wrapper and doesn't verify workspace on the IDs it accepts. Add `apiRoute.authed` and the same workspace check. The only caller is the in-app `ListView.tsx`, which already runs behind auth, so this is a no-regression hardening.
4. `GET /api/projects` — extend to return a `channels` array per project (id, name, account_color), so the list page can render chips.
5. UI: projects list page (`src/app/(app)/projects/page.tsx`) gains
   - row checkboxes (only visible on hover, or when any are selected — match schedule's UX)
   - sticky toolbar with selection count + "Assign channels ▾" popover
   - channel chips on each card
   - mode toggle: Add (default) / Replace (with `allow_clear` confirm)

### Phase 2 — Visibility across artifact list pages (next PR)

- Each artifact list page (scripts/projects detail, voiceover, B-roll, critics, reviews, shorts, narrator takes) joins through `project_channels` to surface a channel chip per row.
- Each page gains a "filter by channel" control. Pure read-side.
- **Open**: if benchmarks on large catalogs show the joined queries are slow, add a denormalized `channel_id_cache` array column on the artifact tables, maintained by a trigger on `project_channels`. Defer until after measurement.

### Phase 3 — Orphan tables (next PR after that)

- Bulk-set UI on the list pages for `ab_tests`, `video_search_terms`, `video_format_tags`, `series`. Single-FK so the API shape is `{ids, channel_id | null}`.
- Four small endpoints, four small UI additions.

## Security (rule 13)

- **Workspace isolation**: every new endpoint resolves `session.ws` first, then `SELECT COUNT(*) FROM target_table WHERE id = ANY($1) AND workspace_id = session.ws` — count must equal the input array's length, otherwise 403. Applies to both `item_ids` and `channel_ids`. Same check added to the schedule endpoint.
- **No partial writes**: workspace check runs before any mutation. If a single ID is foreign, the whole request is rejected — caller can't sneak one item across.
- **Rate limit**: `checkRateLimit(`bulk-assign:${ip}`, 30, 60_000)` (same as schedule).
- **Caps**: MAX_ITEM_IDS=500, MAX_CHANNEL_IDS=50.
- **UUID validation**: strict regex on every entry before any SQL.
- **Parameterized SQL only** — already the codebase norm.
- **FK CASCADE**: deleting a workspace, project, or channel cleans up its join rows.

## Cost (rule 8)

No paid services. Pure schema/UI/API change against existing Postgres.

## Open questions

- Reviews live as `review_project` under `projects` — they inherit through the project FK (confirmed with user).
- Trigger-maintained denorm cache deferred to Phase 2 once query plans on real data justify it (confirmed with user).
- `llm-council` skill not loaded in this session; proceeding without it (confirmed with user).
