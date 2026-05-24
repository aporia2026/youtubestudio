# Editor: bulk-fill images for blank shots

**Date:** 2026-05-24
**Status:** Approved, ready to implement
**Owner:** info@flexelent.com

## Goal

Add a button in the editor that generates AI images for every shot that
doesn't have one yet, in a way that is friendly to Kie.ai's rate limit
and the user's wallet. Throttled — not all at once, not one by one.

## Constraints / requirements

- Skip shots that already have an image (`rowImages[i]` truthy OR
  `doc.rows[i].imageUrl` truthy — same predicate the BLANK marker uses
  in `Timeline.tsx:544`).
- Respect Kie.ai's two-layer rate limit: 30 req/min per IP AND per user
  (`/api/generate/production-doc/image` route.ts:40-43).
- Be cancellable mid-run.
- Each shot's image model resolves the same way the single-shot
  Regenerate does: `row.image_model > doc.image_model_default > server
  DEFAULT_IMAGE_MODEL`.
- Cost transparency (rule 8): confirm before kicking off; show shot
  count + chosen model + rough time estimate.
- Per-shot errors don't abort the run; final toast summarises.

## Approach

### Concurrency model: 3-worker pool

The production-doc page already does batch generation using a
chunk-based pattern (`Promise.all` over slices of 2, see
`page.tsx:5267-5338`). A worker-pool is strictly better:

- 3 workers consume from a shared queue of blank shot indices.
- Each worker pulls the next index when its current call finishes —
  no stalling on the slowest call in a chunk.
- Effective rate: with ~10-30s per Kie call, 3 workers = ~9-18 calls/
  min → comfortably under the 30/min ceiling.

3 (vs prod-doc's 2) because this is a focused, on-demand fill the user
explicitly triggered. Prod-doc's 2 is set conservatively so it can
co-exist with other concurrent generation passes that fire on doc
creation.

### State machine (EditorClient)

```
idle ──[click Fill]──▶ confirming ──[user OK]──▶ running ──┬──▶ done
                          │                                 ├──▶ cancelled
                          └──[cancel]──▶ idle               └──▶ partial
```

State held in EditorClient as:
- `fillState: 'idle' | 'running' | 'done' | 'cancelled'`
- `fillProgress: { done, total, failed: number[] }`
- `fillAbortRef: AbortController | null`

`confirming` is just `window.confirm()` — no separate modal. Consistent
with the existing "Apply smart auto-fix" confirmation pattern
(EditorClient.tsx:~3138).

### Worker loop

```ts
async function runFillBlanks() {
  const queue: number[] = collectBlankIndices(state);
  if (queue.length === 0) return;
  if (!window.confirm(`Generate ${queue.length} images using ${modelLabel}? ~${etaMin}m.`)) return;

  const controller = new AbortController();
  fillAbortRef.current = controller;
  setFillState('running');
  setFillProgress({ done: 0, total: queue.length, failed: [] });

  const concurrency = Math.min(3, queue.length);
  let nextIdx = 0;
  const pull = () => (nextIdx < queue.length ? queue[nextIdx++] : null);

  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let i = pull(); i !== null; i = pull()) {
      if (controller.signal.aborted) return;
      await generateOneShot(i, controller.signal);  // updates progress + dispatches SET_ROW_IMAGE
    }
  }));

  finalize(controller.signal.aborted ? 'cancelled' : 'done');
}
```

`generateOneShot(i, signal)`:
- Read latest row from state ref (state may have changed mid-run).
- If row is gone or already has an image, skip (count as done).
- Resolve model: `row.image_model ?? doc.image_model_default ?? undefined`.
- Build the same fetch body the inspector uses (prompt, model,
  onScreenText, sectionTitle, styleId).
- On 200 ⇒ `apply({ type: 'SET_ROW_IMAGE', shotIndex: i, url })`,
  bump `done`.
- On non-200 / network error ⇒ push to `failed[]`, log, continue.
- On AbortError ⇒ return silently.

### UI placement

Right under the new "Image model" dropdown in the doc-defaults panel
(EditorClient.tsx ~line 3151). Same visual rhythm as the surrounding
controls.

States:
- `idle` + no blanks → button shows "All shots have images" (disabled).
- `idle` + N blanks → button shows "Fill N blank shots".
- `running` → button collapses into "Filling X/N…" with a Stop pill
  next to it.
- `done`/`cancelled` → toast summary; UI returns to idle.

### Observability (rule 14)

- `[editor fill-blanks start] { total, modelDefault, concurrency }`
- `[editor fill-blanks shot ok] { shotIndex, durationMs }`
- `[editor fill-blanks shot fail] { shotIndex, status, error }`
- `[editor fill-blanks done] { succeeded, failed, cancelled, elapsedMs }`

### Settings audit (rule 15)

Concurrency = 3 is a constant for now. Exposing it as a setting would
add a knob nobody asked for. If users need to dial it down (slow
network, paid Kie tier limits), we'll expose it then.

### Cost (rule 8)

The confirmation copy names the model and shot count; the user already
saw the price hint when they picked the model in the dropdown
(IMAGE_MODELS[].hint includes per-image $ for the models that publish
it). No surprise spend — the user explicitly confirmed once.

## Alternatives rejected

- **Chunked Promise.all (prod-doc's pattern)** — easier to write but
  stalls on the slowest call per chunk. Worker pool wins.
- **Sequential one-at-a-time** — too slow. 100 blanks × 15s = 25 min.
- **6+ concurrent** — risks tripping Kie's 30/min ceiling once polling
  retries pile up, and increases blast radius on a bad model pick.
- **Built-in pause/resume** — feature creep. Stop + start-over covers
  the user's actual need.

## Security

No new endpoint, no new input from the network. Same auth/rate-limit
path as the inspector's Regenerate. Each call is the SAME shape the
user could already make manually 100 times in a row.

## QA checklist (rule 6)

- Golden: open project with mix of filled+blank shots → click Fill →
  confirm → watch progress tick → shots light up in timeline → toast
  "Filled N shots" → reload → all shots filled.
- Stop mid-run → in-flight calls abort cleanly, no orphan toasts.
- Per-shot failure → batch continues, failed count surfaces in summary.
- 0 blanks → button disabled with "All shots have images".
- 1 blank → concurrency drops to 1 (no over-spawn).
- User edits a row's prompt mid-batch → next pull reads latest prompt
  (state ref, not stale closure).
- Reload mid-run → state is lost (no resume). Acceptable; user kicks
  off again, the already-filled shots get skipped by the predicate.
- LOCAL_STUDIO model in doc default + LOCAL_STUDIO not running → every
  shot returns 503; batch surfaces as "0 succeeded, N failed".
- Type check passes.
