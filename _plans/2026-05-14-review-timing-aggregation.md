# 2026-05-14 — Review-player timing aggregation (Phase 2 measurement step)

**Status:** Approved, in implementation
**Predecessor:** `_plans/2026-05-13-review-player-fixes-phase-1.md` (shipped)
**Successor (gated on this):** `_plans/2026-05-13-hls-adaptive-streaming-phase-2.md`

## Why this exists

Phase 1 shipped the cheap review-player wins on 2026-05-13. The Phase 2
HLS plan is explicitly gated on a measurement step (Phase 2 plan, line
83): leave the `reviewPlayerTiming` flag on for one week and decide HLS
based on aggregated p50/p95 cold-start metrics.

The existing instrumentation only logs to `console.info` in a single
DevTools session — there is no aggregation, no team-wide capture, and
no way to actually compute the threshold the Phase 2 plan requires. We
either fix that, or we ship Phase 2 blind. This plan fixes that.

## Goal

Capture cold-start timing samples from every ReviewPlayer mount across
all reviewers for ~1 week, then expose a one-shot query that produces
the numbers needed to greenlight or reject HLS:

- `time_to_first_frame_ms` p50, p95
- `time_to_canplaythrough_ms` p50, p95
- `total_stall_ms` p50, p95
- `stall_count` mean
- Owner-vs-token split, so the owner's fast connection doesn't skew the
  reviewer-side numbers

## Trigger condition for Phase 2 HLS work (from Phase 2 plan)

> If aggregated p50 time-to-first-frame stays under 2.5s on the team's
> typical networks, HLS is not worth the spend.

Operationalised:

- **Skip HLS** if reviewer-side p50 < 2.5s AND p95 < 8s over ≥30 samples
- **Greenlight HLS** if either threshold is breached and the failure
  mode is slow-network (stalls + long TTFF), not server-side
- **Investigate further** if breached but cause is unclear (e.g. R2
  byte-range latency rather than client bandwidth)

## In scope

- One migration adding a small samples table.
- One public POST endpoint the player calls on cold-start completion.
- One admin GET endpoint that computes p50/p95.
- Minimal client wiring: ReviewPlayer reports through `sendBeacon` (so
  navigating away doesn't drop the sample); ReviewPage passes
  `versionId` + `isOwner` through.

## Out of scope

- A dashboard UI. JSON response off the admin endpoint is enough for a
  one-time read at week's end.
- Long-term retention. We delete samples older than 30 days from a
  follow-up cleanup — for now a small accumulation is fine.
- Anything that captures reviewer identity, IP, or user-agent. This is
  anonymous timing telemetry, nothing more.

## Data model

New migration `0069_create_review_player_timing_samples.ts`:

```sql
CREATE TABLE IF NOT EXISTS review_player_timing_samples (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id                  UUID NOT NULL,        -- soft FK, no constraint
  was_owner                   BOOLEAN NOT NULL,
  time_to_metadata_ms         INTEGER,              -- nullable: not every src reaches each milestone
  time_to_first_frame_ms      INTEGER,
  time_to_canplaythrough_ms   INTEGER,
  stall_count                 SMALLINT NOT NULL DEFAULT 0,
  total_stall_ms              INTEGER NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_review_timing_created_at
  ON review_player_timing_samples (created_at DESC);
```

Soft FK on `version_id` — no constraint. The capture must never fail
because a version was deleted between recording the sample and writing
it. The aggregation query joins on `version_id` only when the caller
wants per-version breakdowns; the headline p50/p95 is across all
samples regardless.

## API surface

### `POST /api/review/timing` — public, anonymous

Body:

```ts
{
  versionId: string;            // UUID
  wasOwner: boolean;
  timeToMetadataMs: number | null;
  timeToFirstFrameMs: number | null;
  timeToCanPlayThroughMs: number | null;
  stallCount: number;           // 0..255
  totalStallMs: number;
}
```

Validation:

- `versionId` must match UUID v4 shape (reject otherwise).
- Each timing value must be either `null` or an integer in `[0, 600000]`
  (10 minutes max). Anything outside that range is almost certainly
  clock skew or a runaway tab and would skew percentiles.
- `stallCount` clamped to `[0, 255]`.

Rate limit: 30 samples per minute per IP. Far above the realistic per-
reviewer cadence (one cold-start sample per video load), so legitimate
traffic never trips it. Buys back the public endpoint security
exposure.

Response: `204 No Content` on success. The client ignores all
responses.

### `GET /api/admin/review-timing-summary?days=7` — admin-only

Returns:

```ts
{
  window: { days: 7, from: iso, to: iso };
  total_samples: number;
  by_was_owner: {
    owner: { samples: n; p50_ttff_ms; p95_ttff_ms; p50_tcpt_ms; p95_tcpt_ms; p95_total_stall_ms; mean_stall_count };
    reviewer: { /* same shape */ };
  };
  verdict: 'skip-hls' | 'greenlight-hls' | 'investigate' | 'insufficient-samples';
}
```

The `verdict` is a one-shot decision helper that runs the trigger
condition logic in SQL/TypeScript so the user doesn't have to eyeball
it. `insufficient-samples` returns when `reviewer.samples < 30`.

Computed via Postgres `percentile_cont(0.5/0.95) WITHIN GROUP (ORDER BY
column)` — one query, fast on the index.

## Client changes

### `ReviewPlayer.tsx`

- Accept two new optional props: `versionId?: string` and
  `isOwner?: boolean`.
- Inside the existing `reportTiming` function (which already runs at
  `canplaythrough` and on unmount), if `versionId` is set, also POST to
  `/api/review/timing` via `navigator.sendBeacon`. Fall back to `fetch`
  with `keepalive: true` if `sendBeacon` is unavailable.
- The existing `localStorage.reviewPlayerTiming === '1'` gate stays —
  but it now ONLY controls the `console.info` developer readout. The
  server-side POST runs unconditionally so we get team-wide samples.
- Do not POST if `versionId` is missing (e.g. owner used in a context
  where the version isn't threaded yet).

### `ReviewPage.tsx`

- Pass `versionId={activeVersionId}` and `isOwner={isOwner}` to
  `ReviewPlayer`. Both already exist in scope.

That's the entire client diff.

## Security (rule 13)

- Public endpoint: no auth required. Acceptable because:
  - No PII captured: no IP, no user-agent, no identifiable token, no
    reviewer name.
  - Body is bounded and validated. A polluted sample is at worst a
    distortion of one percentile point, not a security incident.
  - Rate-limited per IP via the existing `checkRateLimit` helper.
- Admin endpoint: gated by `apiRoute.admin` so only admin sessions can
  read aggregated stats. The aggregation hides individual sample rows
  anyway; no per-reviewer leakage even if a non-admin had access.
- DB schema: no field carries identifying information. `version_id` is
  a foreign-system UUID; knowing it doesn't expose anything beyond what
  the share link already exposes.
- No logging of the request body — `logger.warn`/`logger.error` lines
  may serialise route arguments, so the timing endpoint must NOT pass
  the parsed body through to the logger.

## QA pass (rule 6)

1. Open a review page, watch a video to `canplaythrough` → one row in
   `review_player_timing_samples` with `was_owner=true` if owner, false
   if token-side. Confirm via direct `SELECT *`.
2. Navigate away mid-playback (unmount path) → one row written, with
   `time_to_canplaythrough_ms` NULL but `time_to_metadata_ms` /
   `time_to_first_frame_ms` populated.
3. Hammer the endpoint from curl (31 requests in a minute) → 31st gets
   a 429. No row written for the 429'd request.
4. POST malformed body (negative timing, ms > 600k, non-UUID
   versionId) → 400, no row.
5. POST a versionId that doesn't exist in `review_versions` → still
   accepted (soft FK). Row written. Aggregation still works.
6. Owner mode: confirm `was_owner=true`. Token mode: confirm `false`.
7. Hit `/api/admin/review-timing-summary?days=7` as admin → JSON with
   p50/p95 numbers and a verdict. As non-admin → 403.
8. Confirm `sendBeacon` fires on tab-close: open a fresh review page,
   wait for `canplaythrough`, close the tab immediately. Row should
   appear despite the tab being gone.
9. Confirm the dev-mode `console.info` readout still fires when
   `localStorage.reviewPlayerTiming === '1'` is set. The new server
   POST runs in parallel; one doesn't suppress the other.

## Decision log

- **Soft FK on version_id, no constraint.** Capture must not fail
  because a version was deleted between mount and unmount. Aggregation
  doesn't need referential integrity.
- **No IP / UA / cookie captured.** Avoids GDPR-class exposure for a
  measurement step that doesn't need identity.
- **One-week window, no retention job in this PR.** Adding a cleanup
  cron now is premature for a table that'll have at most a few hundred
  rows. Revisit when we know we want to keep this instrumentation past
  the measurement window.
- **`sendBeacon` over `fetch keepalive`.** Beacon survives more browser
  conditions (including some Safari edge cases where keepalive fetches
  get cancelled). Fallback chain: beacon → keepalive fetch → noop.
- **Verdict computed server-side, not client-side.** Keeps the
  threshold logic in one place so a future tweak doesn't require the
  user to re-run mental math.
- **Server POST runs unconditionally; localStorage gate now only
  controls console output.** The whole point of this work is to get
  data across all reviewers; gating the POST behind a localStorage
  flag would defeat that.

## Effort

| Step | Effort |
|---|---|
| Migration 0069 | 15 min |
| POST /api/review/timing | 30 min |
| GET /api/admin/review-timing-summary | 30 min |
| Client wiring (ReviewPlayer + ReviewPage) | 15 min |
| QA pass | 30 min |

**Total: ~2 hours.**

## After the week

When ≥30 reviewer-side samples exist:

1. Hit `/api/admin/review-timing-summary?days=7`.
2. Read the `verdict` field.
3. If `skip-hls` — close out the HLS Phase 2 plan as "not needed",
   leave the instrumentation in place for ongoing health monitoring.
4. If `greenlight-hls` — confirm vendor pricing (rule 8 says verify
   live, not from training data) and start the HLS plan.
5. If `investigate` — surface the breakdown (high TTFF + low stalls =
   server-side; low TTFF + high stalls = network) and decide what to
   chase next.
