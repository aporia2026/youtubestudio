# Pronunciation review for narrator takes

**Date:** 2026-06-01
**Branch:** `claude/video-creation-ui-pqXzS`
**Approach chosen:** Option C — Whisper ASR diff + Gemini 2.5 Flash audio judge
**Estimated cost:** ~$0.09 per 14-min narration (pay-per-use against existing API keys; no new vendor)

---

## Goal

When a narrator uploads a full-audio take, automatically surface places where they:

1. Said a different word than the script (substitution, omission, insertion) — **script deviation**
2. Said the right word but pronounced it wrong (proper nouns, technical terms, acronyms) — **mispronunciation**

The reviewer sees flagged words highlighted inline in the script *and* listed in a collapsible "Flags" panel at the top. For each flag the reviewer can: **Accept** (becomes a regular take comment to the narrator with a suggested text the reviewer can edit), **Edit** (modify the suggested comment before sending), or **Dismiss** (the flag disappears, never auto-sent).

False-positive rate matters more than recall. The reviewer must be able to trust every flag at a glance, or they will stop looking.

---

## Constraints

- **No new vendor.** OpenAI (Whisper) and Google AI (Gemini 2.5 Flash) keys are already configured and used in the codebase. Whisper for ASR, Gemini for the audio judge.
- **Budget cap.** Same pattern as `ELEVENLABS_ALIGNMENT_BUDGET_USD` ($5/mo default) — add `PRONUNCIATION_REVIEW_BUDGET_USD` (default $5/mo).
- **Vercel function time.** Keep under 800s like the existing align route. Concurrent Gemini calls (5-way) keep wall-clock under ~60s even for a 14-min narration.
- **Depends on alignment_json.** Won't run until forced alignment is `ready` — we use `alignment_json.words[]` to slice precise audio windows for the Gemini judge.
- **Integrate with existing comment system, do not parallel it.** Flags are a *pre-comment* layer; on accept they become rows in `narration_take_comments` with the flag's timestamp.

---

## Requirements

### Functional

1. Trigger: **manual button** on the reviewer-side Narration tab, "Run pronunciation review." Not auto-fired on alignment-ready. *(Reasoning: not every narration needs it, and we shouldn't burn budget by default — see open question Q1.)*
2. Status states mirror alignment: `pending` / `running` / `ready` / `failed`. Polled by the UI.
3. On ready: every flag rendered inline as a colored underline on the word in the script; collapsible "Flags (N)" panel at top.
4. Inline flag click → popover with: AI explanation, confidence pill (high/medium), category badge (script deviation / mispronunciation), suggested comment text (editable), **Accept** / **Dismiss** buttons.
5. Accept → POST to existing `/api/narrator/takes/[takeId]/comments` with `timestamp_ms = flag.start_sec * 1000`, `text = edited suggestion`. Flag's `user_status` flips to `accepted`, `flag.comment_id` records the resulting comment row.
6. Dismiss → `user_status = 'dismissed'`. Hidden from default view, restorable via "Show dismissed" toggle.
7. Re-run available via the same button (cost-capped). Replaces all `pending` flags; preserves `accepted` / `dismissed` decisions where the same word position matches.

### Non-functional

- **False-positive bias.** Confidence threshold ≥ 0.75 on the Gemini judge. One flag per 2-second window (cluster collapse). Visually tier: red (high-confidence script deviation), amber (possible mispronunciation).
- **Cost cap shared with alignment.** Budget check happens before Whisper call, same pattern as `ensureAlignmentForVoiceover`.
- **Cancellable.** DELETE on the route flips status to `cancelled` so the polling UI can stop.

---

## Architecture

```
┌──────────────────────────┐
│ Reviewer hits            │
│ "Run pronunciation       │  POST /api/narrator/assignments/[id]/pronunciation-review
│  review" button          │ ─────────────────────────────────────────────────────────┐
└──────────────────────────┘                                                          │
                                                                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ runPronunciationReview(assignmentId)                                                     │
│   1. claimPronunciationReview() — atomic 'running' transition                            │
│   2. budget check (PRONUNCIATION_REVIEW_BUDGET_USD)                                      │
│   3. fetch audio bytes from R2                                                           │
│   4. fetch alignment_json (word timestamps already exist from Scribe forced alignment)   │
│   5. Whisper transcription (OpenAI audio.transcriptions, response_format='verbose_json', │
│      timestamp_granularities=['word']) → recognized words with timestamps                │
│   6. diff(whisperWords, scriptWords) → SubstitutionList, OmissionList, InsertionList     │
│   7. trickyWords(script) → candidates (proper nouns, acronyms, non-ASCII words)          │
│   8. candidates = dedupe(diffs ∪ trickyWords, within 2-sec windows) — typically 20-50    │
│   9. parallelJudge(candidates, concurrency=5):                                           │
│        for each candidate:                                                               │
│          - slice audio buffer at start_sec-0.3 to end_sec+0.3 (using alignment_json)     │
│          - Gemini 2.5 Flash with audio + script context + structured response schema     │
│          - returns { is_real_issue, confidence, category, explanation, suggested_comment }│
│   10. filter confidence >= 0.75, persist as pronunciation_flags rows                     │
│   11. setPronunciationReviewReady() — status='ready', cost recorded                      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                                                                      │
                                                                                      ▼
┌──────────────────────────┐
│ UI polls GET status,     │   GET /api/narrator/assignments/[id]/pronunciation-review
│ then GET ?include=flags  │   GET .../?include=flags
│ when ready               │
└──────────────────────────┘
```

### Files (new)

- [src/lib/migrations/0107_create_pronunciation_review.ts](src/lib/migrations/0107_create_pronunciation_review.ts) — schema (see below)
- [src/lib/pronunciation-review/run.ts](src/lib/pronunciation-review/run.ts) — orchestrator (mirrors `alignment.ts`)
- [src/lib/pronunciation-review/whisper.ts](src/lib/pronunciation-review/whisper.ts) — OpenAI Whisper call
- [src/lib/pronunciation-review/diff.ts](src/lib/pronunciation-review/diff.ts) — pure Needleman-Wunsch-style alignment, no side effects
- [src/lib/pronunciation-review/candidates.ts](src/lib/pronunciation-review/candidates.ts) — pure tricky-word + diff merger
- [src/lib/pronunciation-review/gemini-judge.ts](src/lib/pronunciation-review/gemini-judge.ts) — Gemini 2.5 Flash audio judge with structured output
- [src/lib/pronunciation-review/audio-slice.ts](src/lib/pronunciation-review/audio-slice.ts) — pure ffmpeg-free slicing using `@remotion/media-utils` or a tiny WAV/MP3 byte-range helper
- [src/lib/pronunciation-review/db.ts](src/lib/pronunciation-review/db.ts) — DB queries
- [src/app/api/narrator/assignments/[id]/pronunciation-review/route.ts](src/app/api/narrator/assignments/[id]/pronunciation-review/route.ts) — POST/GET/DELETE
- [src/components/narrator/PronunciationFlagsPanel.tsx](src/components/narrator/PronunciationFlagsPanel.tsx) — top-of-script collapsible
- [src/components/narrator/PronunciationFlagPopover.tsx](src/components/narrator/PronunciationFlagPopover.tsx) — inline flag click target
- [tests/pronunciation-review-diff.test.ts](tests/pronunciation-review-diff.test.ts)
- [tests/pronunciation-review-candidates.test.ts](tests/pronunciation-review-candidates.test.ts)

### Files (modified)

- [src/components/narrator/TakeReview.tsx](src/components/narrator/TakeReview.tsx) — render inline flag underlines on script words; mount `PronunciationFlagsPanel` above the script when `pronunciation_review_status === 'ready'`
- [src/components/narrator/NarrationTeleprompter.tsx](src/components/narrator/NarrationTeleprompter.tsx) — accept optional `flagsByWordIndex` map and overlay colored underlines
- [src/components/narrator/NarrationTab.tsx](src/components/narrator/NarrationTab.tsx) — "Run pronunciation review" button + status polling
- [src/lib/narrator-db.ts](src/lib/narrator-db.ts) — add `getFullAudioTakeWithPronunciationReview`, `claimPronunciationReview`, `setPronunciationReviewReady`, etc.

### Schema (migration 0107)

```sql
ALTER TABLE narrator_takes
  ADD COLUMN IF NOT EXISTS pronunciation_review_status TEXT NOT NULL DEFAULT 'none'
    CHECK (pronunciation_review_status IN ('none','pending','running','ready','failed','cancelled')),
  ADD COLUMN IF NOT EXISTS pronunciation_review_error TEXT,
  ADD COLUMN IF NOT EXISTS pronunciation_review_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pronunciation_review_cost_usd NUMERIC;

CREATE TABLE IF NOT EXISTS pronunciation_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  take_id UUID NOT NULL REFERENCES narrator_takes(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  -- locator
  word_index INTEGER NOT NULL,          -- index into the script word array
  start_sec NUMERIC NOT NULL,
  end_sec NUMERIC NOT NULL,
  -- AI output
  category TEXT NOT NULL CHECK (category IN ('script_deviation','mispronunciation','omission','insertion')),
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  ai_explanation TEXT NOT NULL,
  suggested_comment TEXT NOT NULL,
  -- state
  user_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (user_status IN ('pending','accepted','dismissed')),
  user_comment TEXT,                    -- editable; null until accepted, then = suggested_comment or user edit
  comment_id UUID REFERENCES narration_take_comments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pronunciation_flags_take ON pronunciation_flags(take_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_pronunciation_flags_workspace ON pronunciation_flags(workspace_id);
```

Down migration drops `pronunciation_flags` and the four columns.

### Diff algorithm (pure)

Classic Needleman-Wunsch over normalized words (lowercased, punctuation-stripped). Cost: match=0, substitute=1, indel=1. Trace back to produce an aligned sequence of `{scriptWord, whisperWord}` pairs where either side may be null. Emit:

- `script != null && whisper != null && script !== whisper` → **substitution candidate** at script's word_index
- `script != null && whisper == null` → **omission candidate**
- `script == null && whisper != null` → **insertion candidate** (timestamped from whisper's word time)

For substitutions, also emit the *match* itself as a candidate if either word looks "tricky" (see below) — to catch the "right word, wrong pronunciation" case where Whisper guessed the script word correctly.

### Tricky-word detection (pure)

A script word is tricky if any of:

- Contains a non-ASCII letter (`Viehböck`)
- Is an acronym (≥2 consecutive uppercase letters, possibly with dots: `WPA`, `W.P.A.`)
- Is capitalized mid-sentence (proper noun heuristic — false positives on sentence-start capitals are eliminated by skipping the first word of every sentence)
- Length ≥ 10 characters with at least one of `qx`, `zh`, `sch`, `ph`, double consonants in non-English positions (extensible heuristic list)

This list is intentionally generous — the Gemini judge filters from there.

### Gemini judge prompt (sketch)

```
System: You are checking whether a narrator pronounced a word correctly.

Inputs (for one candidate):
- Audio: 3-second clip from the narration
- Script line: "...He built a tool called Reaver. It automates the guessing process..."
- Target word: "Reaver" (position: word 4 in the line)
- Whisper heard: "Reaver" (or "Reever" / silence)
- Category hint: tricky_word | substitution | omission | insertion

Return structured JSON:
{
  is_real_issue: boolean,
  confidence: 0..1,
  category: "script_deviation" | "mispronunciation" | "omission" | "insertion" | "ok",
  explanation: "one short sentence to the narrator",
  suggested_comment: "rewriteable text the reviewer can send as-is"
}

Bias toward false-negative. If unsure, return is_real_issue=false. Only flag when you are confident.
```

Structured output via Gemini's `responseSchema` / `responseMimeType: 'application/json'`.

### UI: the lazy-user pass

**On the reviewer-side Narration tab (full-audio):**

- New button next to the existing "Hide review" / "Approve" controls: **"Check pronunciation"** (idle) / **"Reviewing pronunciation…"** (running, with spinner) / **"3 flags found"** chip (ready).
- Status pill matches existing alignment-status convention.
- When ready, a thin colored bar appears above the script: **"3 flags · 2 high-confidence, 1 possible"** with a chevron to expand the panel.
- Expanded panel: one row per flag, sorted by timestamp. Each row shows:
  - Timestamp (clickable → seeks audio)
  - The flagged word (bold) with one-sentence AI explanation
  - Category badge + confidence pill
  - Inline action buttons: **[Accept] [Edit] [Dismiss]**
- Inline in the script: each flagged word gets an underline. Red for high (script deviation), amber for medium (mispronunciation). Click → popover (same content as the row).
- Accept flow: clicking Accept opens a small editable text box pre-filled with `suggested_comment`. **"Send to narrator"** posts a regular take comment at the flag's timestamp. Optimistic UI.
- Once sent, the flag row shows a green checkmark + "Sent to [Narrator name]" and the inline underline turns gray.
- Dismissed flags hide by default. "Show 2 dismissed" link at the bottom of the panel restores them.

**First-look test (rule 10):**

- Reviewer sees the existing waveform + sync-ready pill. New "Check pronunciation" button is right there. No tutorial needed.
- Click → spinner with "Reviewing pronunciation…" and an estimated time ("~30s for 14 min").
- Done → big honest summary ("3 flags found. 2 likely real issues, 1 possible.") + first flag is auto-highlighted in the script so the reviewer sees what this thing actually does.
- One click per flag to accept/edit/dismiss. No deep menus.

---

## Alternatives rejected

### A — ASR-diff only (Whisper, no Gemini judge)
**Why rejected:** Misses true mispronunciations entirely (Whisper might hear "Reaver" correctly even when narrator pronounced it "Reever"). And ASR has its own quirks (homophones, punctuation, common misrecognitions) — without the judge, false positives bloom.

### B — Azure Pronunciation Assessment
**Why rejected:** New vendor relationship and 5x cost ($0.31 vs $0.06 per narration). More deterministic but worse at contextual reasoning ("WPA should be letters"). Held in reserve if C's accuracy disappoints in real use.

### D — Single-shot Gemini over the full audio
**Why rejected:** Simpler and cheaper (~$0.03) but less reliable. Asking a single model call to scan 14 minutes of audio and produce structured flags with accurate timestamps is a long-context audio task — Gemini will miss things and hallucinate timestamps. The hybrid keeps the diff deterministic and limits Gemini to short, narrow judgments where it's strong.

### E — Embed flags directly in `narrator_takes.alignment_json`
**Why rejected:** Couples two different lifecycles. Alignment can be re-run independently of pronunciation review, and flags have state (`pending` / `accepted` / `dismissed`) that don't fit JSONB well — they need indexing and updates. Separate table is the right shape.

### F — Auto-fire on alignment-ready
**Why rejected (for v1):** Spends ~$0.09 on every narration regardless of whether anyone looks at pronunciation. Reviewer often knows immediately ("this narrator is a pro, no issues") and the button lets them skip the cost. Auto-fire is a v2 enhancement once we know the false-positive rate is low enough that it's universally useful.

---

## Cost (verified 2026-06-01)

Sources:
- [Deepgram (rejected) — for comparison only](https://deepgram.com/pricing)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Azure Speech pricing](https://azure.microsoft.com/en-us/pricing/details/speech/)
- OpenAI Whisper: $0.006/min (current published rate; verify at integration time per CLAUDE.md rule 1)

**Per 14-min narration:**

| Step | Calc | Cost |
|---|---|---|
| Whisper (`whisper-1`) | 14 min × $0.006 | $0.084 |
| Gemini 2.5 Flash judge | ~50 candidates × (~75 audio tokens × $1/M + ~200 text-in × $0.30/M + ~80 out × $2.50/M) | $0.017 |
| **Total** | | **~$0.10** |

**Monthly projections** (over and above existing alignment cost):

| Narrations/mo | Pronunciation review cost |
|---|---|
| 10 | ~$1 |
| 50 | ~$5 |
| 200 | ~$20 |

Default monthly cap: $5 (matches `ELEVENLABS_ALIGNMENT_BUDGET_USD` default). Trips at ~50 narrations/mo of pronunciation review — comfortable headroom for normal use, low enough to catch a runaway loop.

---

## Security (per global rule 13)

- **Tenancy.** `pronunciation_flags.workspace_id` is `NOT NULL`. All read/write queries must scope by workspace through the `narrator_takes → narrator_assignments` join. Same pattern as `narration_take_comments`.
- **No new sensitive data.** The audio is already in R2 under a signed URL the system already has access to. The script is already in `narrator_sections`. No new PII added.
- **API keys.** Whisper + Gemini keys are server-only (`process.env.OPENAI_API_KEY`, `process.env.GOOGLE_AI_API_KEY`). Already follow the pattern in [src/lib/ai.ts](src/lib/ai.ts). Never expose to client.
- **Error sanitization.** Apply the same URL-stripping + truncation as the alignment route's `sanitizeErrorDetail`. Don't let an OpenAI or Google error message containing a signed audio URL reach the browser.
- **Budget cap.** Hard server-side check before the Whisper call. Cap covers all workspaces — a single runaway workspace can't burn through quota for everyone.
- **Idempotency.** `claimPronunciationReview` uses the same atomic CAS pattern as `claimTakeAlignment` so two concurrent kicks collapse to one execution.
- **Cancel safety.** DELETE flips status to `cancelled` but the in-flight Whisper/Gemini calls can't be aborted across function instances — the eventual write is guarded by `status = 'running'`, so a cancelled run never persists results.
- **Input validation.** Whisper audio is fetched server-side (no callback URL leakage). Gemini receives audio bytes inline, never a URL. Script text is parameterized into the prompt, but since the script is already in our DB and not user-attacker-controlled, prompt injection risk is low — still, we use Gemini's structured-output schema so a maliciously crafted script can't break the response shape.
- **Logging.** Per-call: namespace `[pronunciation-review]` with `assignmentId`, `takeId`, `step`, `costUsd`, `latencyMs`. Never log audio bytes, full prompts, or API keys. Match the `[paint-explainer-v1 …]` style already used in AGENTS.md.

---

## Open questions (need answers before / during implementation)

**Q1 — Auto-fire on alignment-ready, or manual button only?**
*Plan defaults to manual button (cheaper, opt-in). If you want auto-fire we should add a per-workspace toggle in settings so the cost is opt-in by team, not by narration.* **Need your call.**

**Q2 — Re-run behavior when script changes.**
If the reviewer edits the script after pronunciation review ran, do existing accepted flags stay (they're already in the comments table — yes) and do dismissed flags persist by word position? Plan assumes: re-running invalidates all `pending` flags but preserves `accepted` (already turned into comments) and `dismissed` (matched by word-index + text). **Defer to v2 if the matching logic gets hairy.**

**Q3 — Language scope.**
Plan assumes English (`whisper-1` defaults to en, Gemini handles multilingual). If you'll narrate in other languages, we need to pass the language code through. **Easy to add later.**

**Q4 — Show pronunciation review for per-section takes, or full-audio only?**
Plan assumes full-audio only (matches where forced alignment runs and matches the screenshot you showed). Per-section takes have a different review surface. **Defer to v2 if needed.**

---

## Risks

- **False-positive rate in practice.** The judge prompt and threshold (0.75) are educated guesses. We'll likely need to tune on real narrations after the first ~10 runs. Mitigation: log every Gemini judgement (kept/dropped) so we can review and adjust.
- **Whisper proper-noun recognition.** Whisper is notoriously bad at proper nouns ("Viehböck" → "Vee-bock"). If Whisper misrecognizes the script word AND the narrator pronounces it correctly, the diff will produce a false-positive that the judge then has to reject. The judge is supposed to handle this, but if accuracy disappoints we may need to prompt Whisper with hint context (it accepts a `prompt` param for biasing).
- **Vercel function time.** 5-way parallel Gemini judge + Whisper for a 14-min file should land well under 800s, but a 30-min narration with 80 candidates could push it. Cap candidates at 60; if more, log and drop the rest with a UI warning ("review truncated — re-run after splitting the script").
- **Gemini audio token estimation.** $1.00/M audio tokens is published; the per-second token count I used (25/sec) is widely cited but not officially documented for 2.5 Flash. Real costs may be ±30% of the estimate. Mitigated by the $5/mo cap.

---

## Phases

**Phase 1 — Schema + orchestrator + Whisper call (no UI).**
- Migration 0107.
- `run.ts`, `whisper.ts`, `db.ts`.
- Smoke test script that runs pronunciation review against an existing take and prints the diff list. Verifies Whisper plumbing without spending Gemini budget.

**Phase 2 — Diff + candidates + Gemini judge (still no UI).**
- `diff.ts`, `candidates.ts`, `gemini-judge.ts`, `audio-slice.ts`.
- Unit tests for `diff.ts` and `candidates.ts` (pure functions, fast feedback).
- Smoke script runs the full pipeline end-to-end, inserts `pronunciation_flags` rows. We can inspect them in the DB before touching the UI.

**Phase 3 — API route + status polling.**
- POST/GET/DELETE route mirroring the alignment route.
- Budget check, error sanitization, atomic claim.

**Phase 4 — UI.**
- "Check pronunciation" button on Narration tab.
- Inline flag underlines in `NarrationTeleprompter`.
- `PronunciationFlagsPanel` + `PronunciationFlagPopover`.
- Accept → comment flow (POSTs to existing comment endpoint).
- End-to-end QA on at least 3 real narrations before merging.

**Phase 5 — Council pass + production validation.**
- Per global rule 11, run the LLM Council on the implemented feature before declaring it done — particularly on the false-positive policy, the judge prompt, and the UI's first-look clarity.
- Watch the first 10 production narrations. Tune threshold + heuristics based on real flag-accept rate.
