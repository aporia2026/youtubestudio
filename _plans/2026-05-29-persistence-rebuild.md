# 2026-05-29 — Persistence rebuild: durable mutation chokepoint + cross-machine settings + provider reconciliation

**Status:** Draft, awaiting user approval. Pressure-tested by 5-advisor LLM Council on 2026-05-29.

## Why this plan exists

The user reported losing work on refresh — including paid AI generations — and not seeing their work on a second machine. A two-stage audit confirmed:

1. **Five client-side persistence leak modes** in `src/app/(app)/production-doc/page.tsx` (12,009 lines, 40+ scattered fetch calls):
   - `historyEntryId` race during fresh doc creation — silent skip, no toast.
   - Fire-and-forget `void persistRowAsset(...)` calls — errors toast but no retry queue.
   - Independent async overlay fetch — no atomicity with the image persist.
   - 800ms `useProject` autosave debounce — tab close inside the window = lost.
   - localStorage-only settings (image model, overlay disabled, editor prefs, brand kit) — no cross-machine sync.

2. **Every paid generation route charges the provider BEFORE committing a server-side record.** The flow today is:
   ```
   Server calls Kie/Replicate/Atlas/OpenAI  (MONEY SPENT)
       ↓
   Server returns URL to client
       ↓
   Client POSTs URL to /row-asset            (MAY FAIL → MONEY LOST)
   ```
   No table stores the provider's `taskId` / `prediction.id` / request UUID. Once the URL is returned to the client and the client fails to attach it, the charge is unrecoverable and untraceable.

The code itself documents the issue: `// doc d244130f-bdfe had 181 rows saved but every image attach was lost; the user paid for generations that never reached the server.`

## Goals

1. **Zero lost work after any UI action that produces server-meaningful state**, on refresh, tab close, network failure, or device switch.
2. **Zero orphaned provider charges.** Every charge has a server-side record by request_id, and orphans (charge with no user-visible asset) are auto-retried or auto-refunded by a nightly job.
3. **Cross-machine consistency** for the user's settings — image model, overlay defaults, editor prefs, brand kit, API keys — and for their docs.
4. **Trust UI**: at any moment the user can see "saved / saving / N pending / failed" with a click-to-retry. The system never silently absorbs work.
5. **Structural enforcement**: the fix survives the next feature. An ESLint rule prevents new raw `fetch` calls from bypassing the chokepoint.

## Constraints

- Single-developer codebase. No team to absorb a 3-week feature freeze.
- 12,009-line `page.tsx` is out of scope for refactor. The plan must work *around* it, not require rewriting it.
- Stack is locked: Next.js App Router, Postgres, raw fetch + localStorage. No existing query/cache layer.
- Backend already has `user_history` (JSONB payload + `version` for OCC) and `project_assets` (per-row asset URLs, composite PK on `project_id, row_index, slot`).
- No existing `user_settings` table.
- Migrations run automatically on Vercel deploy via `vercel-build` (`tsx scripts/migrate.ts up && next build`). Next migration number is `0100`.
- Browser support: assume Safari + iOS users present — eliminates ServiceWorker Background Sync (no Safari).
- The IndexedDB queue *can* evict (Safari Private Mode 7-day, storage pressure at 60%). The system must remain honest under eviction — the UI shows "failed", the server reconciliation catches the orphan.

## Requirements

### Functional
- Every server mutation is durable client-side until ACK'd by the server.
- Every server mutation carries a client-generated UUIDv7 `intent_id`; the server rejects duplicates.
- A nightly server-side reconciliation job joins provider charges (by `provider_request_id`) against `project_assets` rows and **auto-retries delivery first**, **auto-refunds only if retry fails or provider can't re-serve**.
- Settings sync across machines via a new `user_settings` table, last-write-wins by `updated_at`.
- UI shows persistent pending/saving/saved/failed state per surface.
- A circuit breaker halts new paid intents when the outbox drain failure rate exceeds threshold (UI surfaces "Saving disabled, retry in N seconds").

### Non-functional
- Wrap-the-worst-5 first; no big-bang refactor of `page.tsx`.
- ESLint rule banning raw `fetch` outside `src/lib/mutate.ts` enforces structural fix.
- All new infrastructure has namespaced `console.info('[mutate ...]')` logs per principle 14.
- All new settings exposed in the Settings UI per principle 15.

## Architecture

```
            ┌─────────────────────────────────────────────────┐
            │                    UI layer                      │
            │  components call: mutate({ kind, payload })      │
            └──────────────────────┬──────────────────────────┘
                                   │
                                   ▼
            ┌─────────────────────────────────────────────────┐
            │            src/lib/mutate.ts (chokepoint)        │
            │  - generates UUIDv7 intent_id                    │
            │  - optimistic UI update                          │
            │  - enqueue to IDB outbox                         │
            │  - call drainer                                  │
            │  - return { intentId, ack: Promise<void> }       │
            └──────────────────────┬──────────────────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
       ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
       │ idb-keyval   │   │  Drainer      │   │ Circuit      │
       │ FIFO queue   │←──│  - exp backoff│   │ breaker      │
       │ {id, kind,   │   │  - dedup OK   │   │ - opens on   │
       │  payload,    │   │  - on ACK del │   │   N failures │
       │  attempt,    │   │  - on 409 del │   │ - half-open  │
       │  nextAt}     │   │  - on 5xx wait│   │   probes     │
       └──────────────┘   └───────┬───────┘   └──────────────┘
                                  │
                                  ▼
            ┌─────────────────────────────────────────────────┐
            │                  Server routes                   │
            │  - check mutation_ids (insert-or-ignore)         │
            │  - commit intent row in provider_generations     │
            │    BEFORE provider call                          │
            │  - call provider                                 │
            │  - update intent row with provider_request_id +  │
            │    result URL in same transaction as project_   │
            │    assets row                                    │
            │  - return ACK                                    │
            └──────────────────────┬──────────────────────────┘
                                   │
                                   ▼
            ┌─────────────────────────────────────────────────┐
            │              Postgres (existing)                 │
            │  + mutation_ids (new, idempotency)               │
            │  + provider_generations (new, reconciliation)    │
            │  + user_settings (new, cross-machine sync)       │
            └─────────────────────────────────────────────────┘
                                   ▲
                                   │ joined nightly
            ┌─────────────────────────────────────────────────┐
            │   Reconciliation cron (Vercel scheduled)         │
            │  - find provider_generations WITH charge but     │
            │    WITHOUT project_assets row > 1h old           │
            │  - attempt redelivery via provider request_id    │
            │  - on success: insert project_assets row, notify │
            │  - on fail: mark refund_pending, surface to user │
            └─────────────────────────────────────────────────┘
```

## Chosen approach

Build a single client-side mutation chokepoint (`src/lib/mutate.ts`) backed by an `idb-keyval`-persisted FIFO queue. Every mutation carries a client-generated `UUIDv7` intent ID. Server adds a `mutation_ids` unique-indexed table for idempotency. Generation routes are restructured to commit a server-side intent row in `provider_generations` *before* calling the provider, recording the provider's request_id on completion. A nightly reconciliation job joins `provider_generations` against `project_assets` to recover orphaned charges. Settings move to a new `user_settings` table with last-write-wins on `updated_at`, also routed through the same `mutate()` chokepoint. UI gains a persistent saved/saving/N-pending/failed indicator with click-to-retry. An ESLint rule bans raw `fetch` outside the chokepoint to keep the structural fix from rotting.

### Alternatives considered and rejected

1. **CRDT / local-first (Yjs, Automerge, Replicache).** Rejected unanimously by 5/5 council reviewers as malpractice for a single-user paid-generation app. CRDTs solve concurrent edits to shared state — we have a writes-dropped problem. Replicache is paid ($0.30/MAU after 1K). 6-month detour for a problem we don't have.
2. **ServiceWorker Background Sync.** Rejected — no Safari support at all, debugging is hell.
3. **TanStack Query optimistic + retry.** Rejected — does not survive tab close. The cache-on-error pattern keeps in-memory state, and we explicitly listed tab close as leak mode #3. Wrong tool.
4. **Dexie instead of idb-keyval.** Rejected — we need a FIFO queue, not a query engine. idb-keyval is 1 KB; Dexie is 50 KB and adds a schema migration burden we don't need.
5. **Wrap all 40 fetches at once.** Rejected — high risk of regressing the 12K-line page that nobody fully understands. Gradual migration is safer; the ESLint rule makes new code obey from day one.
6. **Big-bang refactor of `page.tsx`.** Rejected — separate quarter of work, not the persistence fix. Conflating them is how this stalls.

## Phase breakdown

### Week 1 — Stop the bleeding

**Phase 1.0 — Payment flow ordering fix (1 day)**
*Already audited; result: every paid route charges before commit. This is the highest-impact ordering bug.*

For each paid generation route (`/api/generate/production-doc/image`, `/image/edit`, `/collage`, `/image/rmbg`, `/api/thumbnails/image`, auto-pipeline image gen):
1. INSERT a row in `provider_generations` with `status = 'pending'`, `provider`, `client_intent_id`, `project_id`, `row_index`, `slot`, BEFORE calling the provider.
2. Call the provider.
3. On provider response: UPDATE the same `provider_generations` row with `provider_request_id`, `provider_response_url`, `cost_usd`, `status = 'delivered'`.
4. In the SAME transaction (or via the existing `/row-asset` POST which the client still does), insert the `project_assets` row.
5. If the provider call throws: UPDATE row with `status = 'failed'`, do not charge user, surface error.

Result: every charge has a `provider_generations` row within seconds. Orphans become detectable.

**Phase 1.1 — Migrations (1 day)**
- `0100_create_mutation_ids.ts` — `(id UUID PRIMARY KEY, kind TEXT, user_id UUID, created_at TIMESTAMPTZ)`. Unique on `id`. Server inserts on every mutation; duplicates short-circuit with the prior result.
- `0101_create_provider_generations.ts` — see Phase 1.0. Columns: `id UUID PK`, `intent_id UUID UNIQUE`, `user_id UUID`, `project_id UUID`, `row_index INT`, `slot TEXT`, `provider TEXT`, `provider_request_id TEXT NULL`, `provider_response_url TEXT NULL`, `cost_usd NUMERIC NULL`, `status TEXT CHECK IN (...)`, `created_at`, `updated_at`. Index on `(status, created_at)` for the reconciliation job's scan.
- `0102_create_user_settings.ts` — `(user_id UUID, key TEXT, value JSONB, updated_at TIMESTAMPTZ, PRIMARY KEY (user_id, key))`. Index on `user_id` for the load-all-settings GET.

**Phase 1.2 — `src/lib/mutate.ts` chokepoint (2 days)**
- Install `idb-keyval` (~1 KB, zero deps, Promise API). Per principle 9, consult Context7 on idb-keyval before writing.
- `mutate<K extends MutationKind>(kind: K, payload: PayloadFor<K>): { intentId: string; ack: Promise<MutationResult<K>> }`
  - Generates UUIDv7 `intent_id` client-side.
  - Optimistic UI update via subscriber callback (kind-specific).
  - Enqueues `{ id, kind, payload, url, method, attempt: 0, nextAt: Date.now(), createdAt }` into IDB under key `outbox.<id>`.
  - Triggers drainer; returns `ack` promise that resolves when the server returns 2xx (or rejects on terminal failure).
- Drainer: walks IDB outbox in `nextAt` order, posts with `X-Intent-Id: <uuid>`, on 2xx deletes the entry and resolves any waiting ack; on 5xx/network increments attempt, sets `nextAt = now + min(60s, 1s * 2^attempt)`; on 4xx (non-409) deletes and rejects with error (4xx means our payload is bad, retry won't help); on 409 (duplicate intent) treats as success (server already has it).
- Page-visibility listener: drain immediately when tab returns to foreground (covers the "tab was backgrounded during a transient network blip" case).
- Cross-tab coordination: BroadcastChannel — only the leader tab drains, others observe. Prevents N tabs racing on the same intent.
- Namespaced logs: `console.info('[mutate enqueue]', { intentId, kind })`, `[mutate drain success]`, `[mutate drain fail]`, `[mutate drain backoff]`, etc.

**Phase 1.3 — Wrap the worst 5 leaks (1 day)**
The 5 highest-impact paths from the audit:
1. `generateImageForRow` → `persistRowAsset(..., 'image', ...)` ([page.tsx:6565](src/app/(app)/production-doc/page.tsx#L6565))
2. Character-cache write — `updateProductionDocEntry(...).catch(() => {})` ([page.tsx:6616](src/app/(app)/production-doc/page.tsx#L6616))
3. Scene-cache write — same pattern ([page.tsx:6650](src/app/(app)/production-doc/page.tsx#L6650))
4. Overlay fetch → `persistRowAsset(..., 'overlay', ...)` ([page.tsx:6663-6668](src/app/(app)/production-doc/page.tsx#L6663-L6668))
5. Cache-hit image attach — `void persistRowAsset(...)` ([page.tsx:6344, 6420](src/app/(app)/production-doc/page.tsx#L6344))

Each gets replaced with `mutate('row-asset.set', { ... })`. Optimistic UI stays in place; the chokepoint owns durability.

**Phase 1.4 — Persistent UI status indicator (0.5 day)**
- Top-right pill in the app shell, visible on every page.
- States:
  - `Saved` (green, idle, all clean)
  - `Saving…` (blue, drainer is active)
  - `3 pending` (amber, queued but not yet ACK'd)
  - `Couldn't save 1` (red, click to expand, see failed mutations, retry button)
- Powered by a subscriber on the outbox count + drainer state.
- On tab close while not idle: `beforeunload` shows the standard "changes you made may not be saved" prompt.

**Phase 1.5 — Tactical observability (0.5 day)**
- Sentry breadcrumbs for every `mutate enqueue`, `mutate drain success`, `mutate drain fail`.
- Server log on every `mutation_ids` insert (`[mutation-ids commit]`) and duplicate hit (`[mutation-ids duplicate]`).
- Server log on every `provider_generations` insert/update with state transitions.

### Week 2 — Enforce + reconcile

**Phase 2.1 — ESLint chokepoint rule (0.5 day)**
- Add a custom `no-raw-fetch` rule in `.eslintrc` that errors on `fetch(` calls outside `src/lib/mutate.ts` and a small allowlist (e.g., `src/lib/atlas-images.ts` if it's server-side; SSR routes; the drainer itself).
- One-time scan: lint will fail across the codebase; auto-fix nothing, log the count. Migration tickets generated per file.
- Pre-commit hook (Husky) blocks new `fetch(` outside the chokepoint.

**Phase 2.2 — Reconciliation cron job (1 day)**
- New route `/api/cron/reconcile-orphan-generations`, scheduled hourly via Vercel cron.
- Query: `SELECT * FROM provider_generations WHERE status = 'delivered' AND NOT EXISTS (SELECT 1 FROM project_assets WHERE ...) AND updated_at < NOW() - INTERVAL '1 hour'`.
- For each orphan: attempt to insert the `project_assets` row from the stored `provider_response_url`. If the user no longer owns the project, mark `status = 'refund_pending'`. Otherwise `status = 'recovered'`.
- Backfill: a one-shot script `scripts/backfill-reconcile.ts` runs once against historical data — but only for the new `provider_generations` table going forward; we can't reconcile what we never recorded.
- Refund handling: Phase-2.2b. For `refund_pending` rows, the next phase wires up credit refund. For now, just track and surface to the user.

**Phase 2.3 — Circuit breaker (0.5 day)**
- Drainer tracks rolling 30-second failure rate.
- If >50% failure across last 5 attempts OR 10+ consecutive failures: open the breaker.
- Open state: `mutate()` rejects new paid intents synchronously with a clear "Saving is paused due to repeated failures — retry in N seconds" toast. Non-paid intents (text edits, settings) still queue silently.
- Half-open after 30s: probe one mutation; if it succeeds, close; if it fails, re-open with longer cooldown.

**Phase 2.4 — Tab close + offline UX (0.5 day)**
- `beforeunload`: if outbox has pending entries, show standard browser dialog.
- Service worker (optional, deferred): if we want background drain after tab close, this is where it goes. Note: Safari does not support Background Sync, so this is best-effort on Chrome/Firefox only.

### Week 3 — Migrate + settings

**Phase 3.1 — Settings table + sync (2 days)**
- Migrate the localStorage-only settings list to `user_settings`:
  - `prodoc_image_model`
  - `prodoc_overlays_disabled_pref`
  - `video_brand_kit`
  - Editor settings from `src/lib/editor/settings.ts` (zoom level, show thumbnails, auto-regen captions, playback rate, narration strip, minimap, etc.)
  - Thumbnails draft state
  - API keys currently in localStorage (Perplexity, ElevenLabs) — **see Security section below**, these may need a separate encrypted store.
- Read path: on app mount, GET `/api/user-settings` → populate localStorage cache → app reads localStorage as before.
- Write path: every setter calls `mutate('user-settings.set', { key, value })` which both updates localStorage (optimistic) and the server.
- Conflict resolution: last-write-wins on `updated_at`. If two machines edit the same key offline, the one that drains last wins. No CRDT.

**Phase 3.2 — Migrate remaining fetches (3-5 days, ongoing)**
- Batches of 5 fetches per push. The ESLint rule makes new code obey; the migration is mechanical for existing call sites.
- Per fetch: replace `fetch(...)` with `mutate('kind', { ... })`. Reuse existing kinds where the shape matches; new kinds when the payload differs.
- Verification per batch: smoke test the affected flow (golden path + tab close + simulated network failure).

**Phase 3.3 — Settings UI surface (1 day, per principle 15)**
- New Settings panel section "Save & Sync":
  - "Pending changes" indicator (mirrors the top-right pill in expanded form)
  - "Failed mutations" list with retry / discard
  - Toggle: "Show save status indicator" (default on)
  - Toggle: "Confirm before closing tab with unsaved changes" (default on)
  - "Reconciliation status" — last run, orphans recovered, orphans pending refund.
- No new prefs hardcoded; everything goes through the `user_settings` system.

## Security section (per principle 13)

- **Sensitive data in IDB**: payloads we queue may contain user content but no secrets. **API keys must NOT pass through the outbox** — they live in the server-side `user_settings` JSONB only, with column-level encryption at rest (pgcrypto, key from env). Client never sees other users' keys.
- **Multi-user safety**: every `mutate()` call carries `user_id` server-side from the session; `mutation_ids` table enforces `(id) UNIQUE` globally (UUID collision negligible) but the application layer validates that the intent's `user_id` matches the session user. Prevents replay of one user's intent ID by another.
- **Provider request IDs**: stored server-side only. Not exposed to client API responses.
- **Reconciliation job authorization**: cron route guarded by `CRON_SECRET` env. Per Vercel cron docs, request includes `Authorization: Bearer ${CRON_SECRET}` header.
- **Circuit breaker state per-user**: prevents one user's failures from gating another's writes.
- **Outbox eviction risk**: IDB can evict. UI must surface "failed to persist" on next mount if any in-flight intents are unaccounted for — never silently assume success.
- **CSRF**: existing `same-origin` credentials on fetch + Next.js route protection covers us. The outbox uses the same fetch path, no new CSRF surface.
- **Logging**: namespaced logs include `intent_id` and `kind` only. Never log payload contents (could include private generation prompts, brand info). Server logs include `user_id` and `provider_request_id`.

## Observability section (per principle 14)

Client-side namespaced logs:
- `[mutate enqueue] { intentId, kind, queueLen }`
- `[mutate drain start] { queueLen, leader: boolean }`
- `[mutate drain attempt] { intentId, kind, attempt }`
- `[mutate drain success] { intentId, kind, durationMs }`
- `[mutate drain fail] { intentId, kind, status, attempt, nextAtMs }`
- `[mutate drain dead] { intentId, kind, reason }` (terminal failure)
- `[mutate breaker open] { failureRate, consecutiveFails }`
- `[mutate breaker close] { afterMs }`
- `[mutate evicted] { intentId }` (IDB lost a record)

Server-side logs:
- `[mutation-ids commit] { intentId, kind, userId }`
- `[mutation-ids duplicate] { intentId, originalAtIso }`
- `[provider-generations pending] { intentId, provider, projectId, rowIndex, slot }`
- `[provider-generations delivered] { intentId, providerRequestId, costUsd }`
- `[provider-generations failed] { intentId, provider, error }`
- `[reconcile run] { orphansFound, recovered, refundPending, durationMs }`

Surfacing:
- Sentry breadcrumbs for every client log above.
- Vercel Log Drain captures all server logs; we can search by `intent_id` to trace a single mutation end-to-end.
- A `/admin/diagnostics` page (gated to user email) shows recent reconciliation runs and outstanding refund_pending count.

## Settings section (per principle 15)

New settings introduced by this work:
| Setting | Default | Location | Scope |
|---|---|---|---|
| Save status indicator visibility | On | Settings → Save & Sync | Per-user, cross-machine |
| Confirm before closing tab with unsaved changes | On | Settings → Save & Sync | Per-user, cross-machine |
| Auto-retry failed saves | On | Settings → Save & Sync | Per-user, cross-machine |
| Settings migrated from localStorage | (existing values) | Various existing surfaces | Per-user, cross-machine |

Settings deliberately NOT exposed:
- IDB queue location / size (internal)
- Circuit breaker thresholds (internal, tuned globally)
- Reconciliation cron schedule (internal, hourly fixed)
- ESLint rule config (build-time, not user-facing)

The Settings layer for `user_settings` is the long-term contract. Future features that introduce new settings must use this path; localStorage-only is now a banned pattern (the lint rule covers `fetch`; a separate code review check covers `localStorage.setItem`).

## Cost implications (per principle 8)

- **`idb-keyval` package**: free, MIT, 1 KB, zero deps.
- **No new third-party services.** Reconciliation runs on existing Vercel Cron (included in Pro plan; Hobby supports daily, Pro supports hourly).
- **Reduced waste**: every orphaned generation today = $0.009-$0.20 of provider spend with no user-visible artifact. At ~100 generations/day with 2-5% client-side failure rate, $3-$300/year recovered. Likely an order of magnitude more at peak usage.
- **Database growth**: `mutation_ids` adds ~64 bytes/mutation; `provider_generations` adds ~200 bytes/generation; `user_settings` is bounded by setting count (small). Negligible. Cleanup policy: prune `mutation_ids` rows older than 30 days (long enough that any client retry would have happened).

## Open questions

1. **Existing `ai_spend_log` table (migration 0033) vs new `provider_generations`** — do we extend the existing table, or keep them separate? Recommend separate, because `ai_spend_log` is text-LLM only and the schema would balloon awkwardly. To confirm with user.
2. **Refund mechanism** — when reconciliation can't recover an orphan, do we credit a credit wallet, refund via Stripe, or just notify? Out of scope for this plan; tracked as Phase 2.2b. Need user input on commerce flow.
3. **Workspace vs user scoping** — settings: per-user or per-workspace? Some settings (`prodoc_image_model`) probably per-user; others (brand kit) probably per-workspace. To confirm with user during Phase 3.1.
4. **API keys in user_settings vs separate store** — see Security section. Need a decision on encryption strategy before Phase 3.1 ships.
5. **Migration of in-flight users** — when this deploys, existing localStorage settings need a one-shot upload to the new table. Recommend: on first GET, if server has no settings for this user, upload localStorage values. Idempotent; no data loss.
6. **Cron environment** — confirm we're on Vercel Pro (hourly cron) vs Hobby (daily). Daily reconciliation is acceptable but slower to recover orphans.

## Rollback / kill switch

- Each phase ships behind a feature flag (`MUTATE_OUTBOX_ENABLED`, default true; `RECONCILE_CRON_ENABLED`, default true). Flipping false reverts to current `void fetch` behavior for the wrapped sites.
- IDB schema is namespaced (`outbox.*` keys only); rollback clears IDB on next deploy if needed.
- Database migrations are forward-only as is project policy, but the new tables are additive — no schema change to existing tables. Worst case: stop writing to them, the data sits harmlessly.

## Timeline summary

| Week | Phase | Outcome |
|---|---|---|
| 1 | 1.0 Payment ordering | Every paid route commits intent row before provider call |
| 1 | 1.1 Migrations | mutation_ids, provider_generations, user_settings tables |
| 1 | 1.2 mutate() chokepoint | Durable IDB outbox + drainer + breaker |
| 1 | 1.3 Wrap worst 5 | High-impact image attaches now durable |
| 1 | 1.4 UI indicator | Trust layer visible |
| 1 | 1.5 Observability | Namespaced logs end-to-end |
| 2 | 2.1 ESLint rule | Structural enforcement (no new bypasses) |
| 2 | 2.2 Reconciliation cron | Orphaned charges auto-recovered |
| 2 | 2.3 Circuit breaker | UI refuses new paid intents when broken |
| 2 | 2.4 Tab close UX | beforeunload prompt |
| 3 | 3.1 Settings sync | Cross-machine settings via user_settings |
| 3 | 3.2 Migrate remaining fetches | Batches of 5, ongoing |
| 3 | 3.3 Settings UI surface | User-facing controls per principle 15 |

Estimated total: 10-13 working days for a focused single developer. Pacing assumes no other priority work. Realistic calendar: 3-4 weeks elapsed.

## Acceptance criteria

Before this plan is considered done:
1. User can generate 50 images, refresh the page, and see all 50.
2. User can generate images on Machine A, open the same doc on Machine B, and see all images and settings.
3. User can disconnect their network, generate work, close the tab, reopen later with network, and see the work persist.
4. The reconciliation cron has run for 72h with zero orphans `refund_pending` longer than 24h.
5. ESLint passes with zero raw `fetch` calls outside the chokepoint or allowlist.
6. The save status indicator never shows "Saved" when there are pending or failed mutations.
7. Sentry shows the breaker opens and closes under simulated server failures, and the UI correctly refuses paid intents during open state.
