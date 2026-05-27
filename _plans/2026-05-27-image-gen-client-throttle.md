# Client-side image-gen throttle + friendly 429 surface

**Date:** 2026-05-27
**Status:** Approved, implementing

## Goals

1. Stop the editor from ever hitting the server's 429 rate-limit wall in normal use. Every "Rate limited (IP)" / "Rate limited (account)" pill the user sees right now is a UX failure that breaks rows + loses generation progress.
2. Preserve the collage fast lane. A collage call is 1 server token that delivers 4 images. The client queue must count it as 1 token, not 4, so bulk gen via collage stays at full throughput.
3. Replace the inline "Failed / Retry" pill (which now fires on a transient 429) with a transparent queued-and-retried experience. Failed pill is reserved for non-transient errors.
4. Observability from day one (rule 14): namespaced `[image-gen throttle]` logs at every meaningful step.

## Constraints

- **Server cost guard stays.** Don't bump server limits — the 30/min/IP and 30/min/uid ceilings are deliberate ($1.50/min × $0.05/image = $90/hr cap on a misbehaving session). Server comments are explicit about this. Solution must work entirely client-side.
- **Two distinct server buckets:**
  - `prodoc-img` (used by `/image` and `/collage`): 30/min per IP + 30/min per uid.
  - `prodoc-img-edit` (used by `/image/edit`): 20/min per IP.
  - `prodoc-img-rmbg` (used by `/image/rmbg`): 20/min per IP.
- **No new dependencies.** Token bucket is ~80 lines of plain TS.
- 13 image-gen call sites to wrap (6 in `production-doc/page.tsx`, 7 in `EditorClient.tsx`).

## Approach — Option A (recommended; locked in by the user)

A single client-side throttle module with two token buckets (matching the two server bucket classes) sharing one global concurrency pool. Every fetch to an image-gen endpoint passes through `queueImageGen(category, label, fn)`. 429s slipping through trigger transparent retry with backoff. UX: a sticky toast tracks queue depth + tokens left.

### Bucket sizes (locked)

| Category | Server cap | Client cap | Headroom | Concurrency |
|----------|-----------|-----------|----------|-------------|
| `generate` (`/image`, `/collage`) | 30/min | **25/min** | 5/min | shared 3 |
| `edit` (`/image/edit`, `/image/rmbg`) | 20/min | **18/min** | 2/min | shared 3 |

Concurrency pool is global (3 parallel across both categories), so a burst of edits doesn't stall the generate queue and vice versa.

### Collage parallelism (locked)

Bulk-gen loop in `page.tsx` and `EditorClient.tsx` runs **2 collage chunks in parallel** instead of strict sequential. Token bucket spaces them. Doubles bulk-gen throughput; UI shows 8 loading tiles instead of 4 — that's fine.

### Settings (rule 15)

**Not exposing.** This is plumbing. Constants live at the top of the module with comments documenting the why. If we ever need to tune, the constants stay one-line edits.

## Alternatives rejected

**Option B — Server bump + client toast only.** Bump server to 60/min, just nicer 429 toast. Rejected: doesn't fix the underlying "fire all retries at once" pattern, just delays it. And doubling the cost ceiling without protecting against a real cost-bomb attack is the wrong direction.

**Option C — Two completely separate queues with collage exempt.** Bypass any client throttle for collage. Rejected: collage uses the same server token, so "bypass" means the user still hits 429 once they exceed 30 collage calls/min, just on a different endpoint. Single shared bucket per server-bucket-class is the correct mirror of reality.

## Implementation phases

### Phase 1 — Throttle module (new file)

**File:** `src/lib/image-gen-throttle.ts` (new)

Exports:
- `type ThrottleCategory = 'generate' | 'edit';`
- `queueImageGen<T>(category, label, fn): Promise<T>` — token-bucket-aware queue; resolves when fn does.
- `getThrottleState(): ThrottleState` — for the toast subscriber.
- `subscribeThrottle(fn): unsubscribe` — pub/sub for the toast UI.

Token bucket: simple sliding-window counter (Map of category → array of timestamps within the last 60s; cleanup on each acquire). Concurrency: a counter incremented on acquire, decremented on release; queue of resolvers wakes up FIFO when a slot opens.

429 handling: if `fn` resolves with a `Response` whose status is 429, the throttle records the event, backs off the bucket by 5 seconds (drains the next slot), and tells the *caller* whether to retry (returns wrapped result). The caller handles the actual retry — the throttle is HTTP-agnostic so it can wrap any async fn.

Observability (rule 14):
- `[image-gen throttle acquired]` on every dequeue with `{ category, label, wait_ms, tokens_left, in_flight }`.
- `[image-gen throttle 429]` when caller reports a server 429 with `{ category, label, backoff_ms }`.
- `[image-gen throttle full]` when a call has to wait > 5s for a token, with `{ category, label, depth }`.

### Phase 2 — Toast surface

**File:** `src/components/editor/ImageGenThrottleToast.tsx` (new) + mount in `production-doc/page.tsx` and `EditorClient.tsx`.

Single sticky toast bottom-right when `in_flight + queued > 0`:
```
Generating 12/40 images
  4 in flight • 3 queued • tokens: 18 gen, 12 edit
```
Auto-dismisses 1s after the queue empties. No close button (transient). Uses the existing toaster's `loading` toast style.

### Phase 3 — Wire up the 13 call sites

Each `fetch('/api/generate/production-doc/...')` becomes:

```ts
const res = await queueImageGen('generate', 'variant-edit', () => fetch(...))
```

Categories per site:
- `/image`, `/collage` → `'generate'`
- `/image/edit`, `/image/rmbg` → `'edit'`

Labels per site so logs stay traceable (`'variant-edit'`, `'bulk-collage'`, `'editor-regen'`, etc.).

### Phase 4 — Transparent 429 retry + better UX

In each call site, wrap the existing 429 handling:
- If `res.status === 429`: don't show "Failed". Instead, mark the row state as `'queued'` (new state) and schedule a retry via `queueImageGen` again (which now has a delay baked in from the 429 backoff). Max 2 retries per call.
- If retries exhausted: NOW show the Failed pill with a friendly message ("Rate limit hit — try again in a minute").

`'queued'` row state in `RowImageState`: shows a subtle "queued" pill (clock icon, no error styling). Distinct from `'loading'` which is "actively running".

### Phase 5 — Parallelize collage chunks

In `page.tsx` bulk-gen loop (~line 4416) and `EditorClient.tsx` bulk-fill loop, replace the sequential `for` loop over chunks with a 2-wide pool. Each chunk still wraps a single `queueImageGen('generate', ...)` call — the throttle handles spacing. Per-shot fallback inside a failed chunk stays sequential (4 single-shot calls in a row, still wrapped).

## Files changed

- **New:** `src/lib/image-gen-throttle.ts`
- **New:** `src/components/editor/ImageGenThrottleToast.tsx`
- **New:** `tests/image-gen-throttle.test.ts` (unit-test the bucket math)
- **Modified:** `src/app/(app)/production-doc/page.tsx` (6 fetch wraps + bulk-loop parallel chunks + toast mount + `'queued'` row state)
- **Modified:** `src/app/(app)/edit/[projectId]/EditorClient.tsx` (7 fetch wraps + bulk-fill parallel chunks + toast mount + `'queued'` row state)

## Security (rule 13)

- Throttle is client-side. **Not a security control** — server rate limits stay as the actual cost-guard. Throttle is UX only.
- No new auth surface, no new endpoints, no new tokens stored anywhere.
- Token-bucket state is in-memory in the React tree — gets reset on page refresh. That's fine: page refresh also resets all in-flight gens, and the server bucket is the source of truth.

## Observability (rule 14)

`[image-gen throttle]` namespace, all `console.info` so they ship to the browser console without extra config:

- `[image-gen throttle acquired] { category, label, wait_ms, tokens_left, in_flight }` — every successful acquire.
- `[image-gen throttle 429] { category, label, backoff_ms }` — when caller reports an upstream 429.
- `[image-gen throttle queued] { category, label, depth, est_wait_ms }` — when a call has to wait > 1s.
- `[image-gen throttle done] { category, label, total_ms, throttle_ms }` — every release; lets us measure throttle overhead vs total call time.

Plus existing per-call-site logs stay — the throttle layer is additive.

## QA checklist (rule 6)

- [ ] Golden path: bulk-gen 40 empty rows with collage on. Watch toast. No 429 in console. Throughput ≥ 60 images/min.
- [ ] Variant storm: click "Generate variant" on 8 variant rows in quick succession. Each one queues; none show "Failed".
- [ ] Manual retry storm: click "Retry" on 5 failed rows in 1 second. All five queue and execute; no extra 429s.
- [ ] Collage fallback path: force a collage chunk to fail (mock the API). The 4 single-shot calls inside the fallback respect the throttle (no 429 cascade).
- [ ] Refresh during bulk gen: no orphaned "queued" rows; refreshed page starts from server state.
- [ ] Single-shot edit dialog open and apply 3 edits in a row: queued correctly, all complete.
- [ ] Edit + rmbg + generate happening at the same time: concurrency cap (3) respected; logs show interleaving.
- [ ] Server 429 simulation: manually drop the server's cap to 5/min in code, run bulk gen — confirm the transparent retry handles it.

## Open questions

None at start of implementation.
