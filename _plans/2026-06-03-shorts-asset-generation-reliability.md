# Shorts style-asset generation — make it just work

Date: 2026-06-03
Status: approved, phased delivery
Owner: aporia2026

## Problem (verified, not assumed)

Creating a Short auto-fires `POST /api/shorts/[id]/generate-style-assets`. That route does the
entire job — plan + base image + 6 variant edits — **synchronously inside one serverless request
capped at `maxDuration = 300`** ([route.ts:9](../src/app/api/shorts/[id]/generate-style-assets/route.ts)).
Confirmed failure on short `2b453a5e-ef61-4b8c-ad4d-66b47c473cc4` ("Why Incognito Mode is a Massive Lie"),
2026-06-03 07:01–07:06 UTC:

- Reached "variant 2 of 6" at 255s in, then hit the 300s wall and was hard-killed.
- A hard kill skips the route's `.catch`, so `generation_progress` froze at `{phase:'variant',current:2}`.
- The client polls forever while phase is in-flight with no staleness check
  ([ShortEditor.tsx:196-198](../src/components/shorts/ShortEditor.tsx)); the elapsed counter is
  DB-anchored ([ShortEditor.tsx:2551](../src/components/shorts/ShortEditor.tsx)), so the bar ticked to
  1373s+ against a dead job.
- `variants_persisted = 0` — persistence is all-or-nothing at the end
  ([route.ts:231](../src/app/api/shorts/[id]/generate-style-assets/route.ts)), so the base image and any
  finished variant were discarded.

### Root cause (one mismatch, four consequences)

A time-bounded serverless request is asked to do an unbounded amount of slow third-party work,
**sequentially**, with **no per-call timeout**, **no incremental persistence**, and **no honest status**.
Consequences: (1) hard-kill at 300s, (2) frozen UI, (3) one slow vendor call eats the whole budget,
(4) all completed work discarded. Contributing factor: Atlas/Kie poll has a 285s ceiling and `continue`s
on HTTP 429 ([atlas-cloud-images.ts:405](../src/lib/atlas-cloud-images.ts)), so a self-inflicted 429 storm
(auto-fan-out firing several Shorts at once) can burn the whole budget invisibly.

## Goals

1. Generation always finishes or fails cleanly. Never an eternal spinner.
2. Fast in the common case — variants are independent, so run them concurrently.
3. Vendor flakiness invisible: fast timeout -> fallback -> retry across ticks -> partial success.
4. Never discard completed work (base image, finished variants persist incrementally).
5. Always-honest, self-diagnosing status (log + store the exact stall cause).
6. Render with whatever variants succeeded (decided with user 2026-06-03).

## Non-goals

- Not making Atlas/Kie themselves reliable. They are third parties; "just works" = our system absorbs
  their flakiness, not that they never fail. Promising vendor perfection would be dishonest.
- Not folding Shorts into the `pipeline_run_videos` state machine — Shorts have their own table and
  lifecycle (ideas / clips / manual). Reuse the *pattern*, not the plumbing.

## Decisions (locked)

- **Partial fails -> render with what succeeded.** Missing variants reuse the prior/base frame (the
  renderer already tiles frames by `caption_chunk_start_index`, so omitting a variant just holds the
  previous frame longer — [ShortVideo.tsx:305-322](../src/remotion/compositions/ShortVideo.tsx)).
- **Root-cause dig: both, in parallel.** Build the resilient (self-reporting) system AND inspect this
  run. DB inspection done (`scripts/diag-stuck-shorts-assets.ts`); vendor-side reason needs Vercel logs.

## Chosen approach: move the work to a background cron-tick job

Reuse the proven in-repo pattern: Vercel Cron every minute already drives `/api/cron/run-pipeline`
with claim / advance / retry / artefact state ([vercel.json:104](../vercel.json),
[src/lib/auto-pipeline/](../src/lib/auto-pipeline/)). Build a dedicated, smaller equivalent keyed on the
`shorts` table.

### Phase 1 — stop the bleeding (low risk, ship first)

1. **Per-call timeouts + working fallback (B).** Add an `AbortSignal.timeout` to the Atlas and Kie poll
   fetches; drop the per-variant poll ceiling from 285s to ~60s. A stuck call now fails in ~60s and the
   existing Kie fallback in `gpt-image-2-edit` actually has budget to run.
2. **Incremental persistence.** In the existing pipeline, persist `base_url` as soon as the base lands and
   append each variant to `style_assets.doodle|paint.variants` as it completes — not all-at-once at the
   end. A mid-run kill keeps finished work; a re-run resumes instead of restarting.
3. **Client staleness detection (A).** If `generation_progress.updated_at` is older than ~90s, the strip
   shows "recovering…" instead of a confident bar; `phase==='error'` shows the reason + a Retry button.

### Phase 2 — the root-cause fix (background job)

4. **State machine** in `shorts.generation_progress` (JSONB, exists since migration 0114), extended with:
   `variant_plan[]`, per-variant `{status, url?, attempts, last_error?, vendor_used?}`, `base_url`,
   `base_prompt`, `cost_usd`. UI-facing fields (`phase/current/total/label/started_at/updated_at/
   error_message`) unchanged so the strip keeps working.
5. **Lease columns** on `shorts`: `generation_claimed_at`, `generation_claimed_by_tick`. A tick claims via
   `SELECT … FOR UPDATE SKIP LOCKED` where phase is non-terminal and (claimed_at IS NULL OR claimed_at <
   NOW() - lease). **This is the heart of "just works": the cron reclaims and finishes dead jobs.** The
   frozen "variant 2" short would be picked up and completed by the next tick.
6. **New cron** `/api/cron/run-shorts-assets` (added to `vercel.json` crons, own advisory lock via the
   existing `withCronLock`). Per tick: claim up to K shorts, advance each by a bounded amount.
7. **Decompose the pipeline** into phase functions (`plan`, `base`, `oneVariant`) so the tick handler can
   do bounded work and persist between calls. Idempotent: skip any phase/variant already done.
8. **Parallelize variants** within a tick via `Promise.allSettled`, bounded to `MAX_VARIANTS_PER_TICK`
   (start at 3) to avoid 429 storms. ~5-6x wall-clock win in the common case.
9. **Thin enqueue.** `POST /generate-style-assets` becomes: validate -> set `phase:'queued'` -> return 202.
   No vendor work on the request path, so `maxDuration` stops being a factor. Auto-triggers just enqueue.
10. **Self-diagnosing.** Every variant attempt logs `{vendor, latencyMs, outcome, classifiedReason}` and
    stores `last_error` per variant. The next stall explains itself (timeout vs 429 vs bad-url vs policy).
11. **Retry budget / completion.** Per-variant cap (3 attempts). `done` when every variant is `done` or
    budget-exhausted; stamp `style_id`, write final `style_assets`, clear in-flight. Renders with what
    succeeded.

### Phase 3 — polish

12. Concurrency tuning from real latencies; verify partial-success renders end-to-end; Retry UX in the
    inbox/editor; remove the stuck-row by letting the healed cron finish it (or a one-shot requeue).

## Alternatives rejected

- **Just raise `maxDuration` / split into fewer variants.** Doesn't fix the root cause — a single slow
  vendor leg still blows any fixed ceiling, and work is still discarded on death. Band-aid.
- **Dedicated `shorts_asset_jobs` table.** Cleanest state machine, but more schema + claim helpers than
  needed; `generation_progress` JSONB + two lease columns on `shorts` gets the same correctness with less
  surface. Revisit if Shorts grow more pipeline stages.
- **Fold into `/api/cron/run-pipeline`.** One cron/lock, but couples Shorts to the long-form video
  pipeline's claim loop and stage enum. A separate, isolated cron is clearer and independently throttleable.
- **Client-driven tick loop (browser polls an endpoint that does a chunk).** Dies when the tab closes;
  the whole point is durability independent of the client.

## Security & safety (rule 13)

- New cron endpoint guarded like `run-pipeline` (`CRON_SECRET` / Vercel cron header) + `withCronLock`
  single-flight. No public trigger.
- All claims and writes are workspace-scoped (`WHERE … workspace_id = …`); a stale/foreign id can't poison
  another tenant.
- Lease prevents two ticks double-spending on the same short (`FOR UPDATE SKIP LOCKED` + claimed_at).
- Per-variant retry cap + the existing daily image-spend guard cap runaway vendor cost.
- No new PII or secrets. `scripts/diag-stuck-shorts-assets.ts` is read-only.
- Sanitize vendor error messages before storing in `last_error` (no URLs/keys), matching the existing
  alignment-cache scrubbing.

## Cost (rule 8)

No new paid service. Atlas/Kie image APIs are already in use (~$0.13 per 6-variant Short per the style
card). The cron runs every minute but only does work when a Short is queued (claim returns no-work
otherwise), so added Vercel invocation cost is negligible on top of the existing every-minute pipeline
cron. Incremental persistence *reduces* spend by not re-generating discarded work.

## Open questions

- Vendor-side reason for the 2026-06-03 stall (slow vs 429) — needs Vercel function logs for 07:01–07:06
  UTC. Tracked; the Phase 2 self-diagnosing logging makes future stalls answerable from the row alone.
- `MAX_VARIANTS_PER_TICK` and the ~60s per-variant ceiling are starting guesses; tune in Phase 3 from real
  latencies.

## Test plan

- Pure: tick planner (what to do next given a partial state), variant retry-budget / completion logic,
  staleness threshold, partial-success frame assembly. Unit tests alongside existing
  `tests/shorts-*.test.ts`.
- Integration-ish: idempotent re-tick (rerunning a tick on a partially-done row generates only the missing
  variants), lease reclaim of a stale row.
- E2E (manual QA): create a Short, kill mid-run (simulate), confirm the cron finishes it and it renders
  with whatever succeeded.
