# QA Hardening: raise first-pass scores without lowering the 100/nuclear bar

**Status:** Plan, awaiting approval. Slated to start after Wave 1 of the Command Center plan lands.
**Owner:** Yoav.
**Date:** 2026-05-26.
**Related:** Follows `_plans/2026-05-26-command-center-and-cross-feature-context.md`. Powered by the `video_stage_transitions` telemetry table that Wave 1 introduces.

---

## 1. Goal

For automated video creation, scripts only pass when they reach **100 in nuclear mode** across multiple QA passes. That bar is non-negotiable. The goal of this plan is to make the engine that meets the bar more capable so the QA loop converges faster and the first pass already scores high.

Specifically:

- Raise the **first-pass score distribution**. Today many scripts come in well below 100 on nuclear mode, forcing 2 to 3 retry iterations. Each retry costs time, money, and queue depth.
- Reduce the **average iteration count** to reach 100.
- Reduce the **failure rate** (videos that hit `qa_max_iterations` without passing).
- Keep total cost flat or lower despite higher per-pass investment. The savings on fewer iterations should pay for stronger prompts and any model upgrades.

What this plan deliberately does NOT do:

- Lower the score threshold.
- Soften the nuclear-mode rubric.
- Let any auto-managed script bypass QA.
- Change the user-facing QA tool page (`/qa`) behavior or layout. Manual QA flows benefit from the same prompt improvements but get no UX changes.

## 2. Constraints and preservations

- **Auto-pipeline contract:** the existing per-preset `qa_min_score`, `qa_max_iterations`, `aggressiveness`, and `script_gate_enabled` columns and behaviors stay exactly as they are. This plan tunes the inputs to those gates, not the gates.
- **Critic panels schema:** `critic_panels`, `critic_panel_critics`, and related rows (`migrations/0025_create_critic_panels.ts`) are not changed.
- **Manual `/qa` tool page:** unchanged. The improved prompts are read by both auto-pipeline and the manual page from the same source-of-truth file in `src/lib/script-critics/prompts.ts`.
- **`/critics` live page:** unchanged.
- **Cost discipline:** any change with a recurring cost (model upgrade, extra pass) requires a real pricing check against current docs per standing rule 8 before adoption.

## 3. The four levers

The user picked all four. They land in priority order based on cost vs. impact.

### Lever A: Critic prompt and rubric tightening (highest leverage)

**What changes:** the actual words used to evaluate scripts. Concrete improvements:

- Add 2 to 3 **anchor examples** to each critic's prompt: one 100-score script excerpt, one 70-score, one 40-score, with the per-rubric-line annotation explaining the score difference. The critic learns calibration from these anchors instead of inferring it from generic adjectives.
- Replace ambiguous phrases (`engaging`, `well-paced`, `clear`) with **operationalized criteria** (`hook present in first 8 seconds`, `each section opens with a question or claim`, `transitions name the next idea before stating it`). Ambiguity is the largest source of inflated scores.
- Add **per-rubric-line "deductions" lists**: explicit lists of "lose 5 points for X, lose 10 for Y" so the critic does subtraction rather than gestalt rating. Subtraction is harder to fake.
- Add a **self-criticism pass at the end of every critic's output**: the critic re-reads its own scoring and asks "would a harsher reviewer score this lower? Where?" This catches the rubric inflation that happens when a model wants to be encouraging.

**Files touched:**
- `src/lib/script-critics/prompts.ts` (primary).
- `src/lib/script-critics/types.ts` (only if anchor-example data shape needs to change).

**Risk:** stricter prompts can mean lower scores on existing scripts, including ones that previously squeaked through. That is intentional. We may need to retune `qa_min_score` defaults on existing presets, but never below the user's 100 floor for auto pipelines.

**Effort:** 2 to 4 days of prompt writing + a calibration day running the new prompts against a holdout set of existing scripts to confirm score distribution is sane.

### Lever B: Pre-QA self-check by the generator (cheapest, fastest win)

**What changes:** before a fresh script ever hits the critic panel, the generator does one **self-criticism pass against the same rubric** the critics use, then **silently rewrites** the weakest section. The critics then see the rewritten draft.

The self-check is a single extra LLM call per script generation. The cost is small relative to the script generation itself (and saves money any time it eliminates one retry iteration).

**Files touched:**
- `src/lib/script-critics/prompts.ts` (extract the rubric so the generator can read it).
- `src/lib/script-critics/runner.ts` or a new `src/lib/generator/self-check.ts` (the self-check function).
- `src/app/api/generate/script-validated/route.ts` (or wherever the auto-pipeline's script generation calls happen — likely `src/lib/auto-pipeline/stages/generate-script.ts`).

**Risk:** the self-check could over-correct (rewrite an already-good section into something worse). Mitigation: cap the rewrite to "lowest-scoring section only" and only when its self-rated score is below a threshold (e.g. 80).

**Effort:** 1 to 2 days.

### Lever C: Stronger initial generator prompt

**What changes:** the prompt that produces the first draft. Concrete improvements:

- Inline the **critic rubric** into the generator's system prompt so the generator targets the criteria it will be evaluated against, instead of generating then hoping it scores well.
- Add **format-archetype examples** (hook patterns, structure templates, transition phrases) drawn from the user's own high-performing references. The user has these in the `youtube_references` table per project; the generator can read them when present.
- Add an **explicit "avoid these" section**: the 5 most common deduction reasons surfaced by the critics on past runs.

**Files touched:**
- `src/lib/prompts.ts` (where the generator system prompt lives).
- `src/lib/auto-pipeline/stages/generate-script.ts` (to feed the reference snippets in).

**Risk:** longer prompts cost more tokens per generation. Mitigation: only include references when they exist; cap the reference excerpt size.

**Effort:** 2 to 3 days.

### Lever D: Critic model upgrade and panel diversification

**What changes:** the models the critics run on.

Today's critic panel runs all critics on the same model (defaults to `claude-sonnet-4-6` per `/critics` page state). Two ways to diversify:

- **Mixed-model panel:** assign each critic to a different model so the panel surfaces issues a single model would miss. Different models have different blind spots; the union of their critiques is harsher than any one of them.
- **Upgraded critic model on nuclear-mode passes:** use `claude-opus-4-7` (or whichever is the strongest available per models.dev at adoption time) for nuclear-mode critiques specifically. Standard / brutal passes stay on cheaper models.

**Files touched:**
- `src/lib/script-critics/runner.ts` (model selection logic).
- `src/lib/script-critics/types.ts` (if the panel config shape changes).
- `src/lib/migrations/NNNN_critic_model_per_critic.ts` only if we want to persist per-critic model choice (otherwise it can be code-only configuration).

**Cost check (mandatory per standing rule 8):**
- Before adoption, fetch current pricing from `models.dev` for: `claude-opus-4-7`, `claude-sonnet-4-6`, `gpt-5.5` (or whichever flagships are current).
- Estimate per-100-videos cost delta under the new mix.
- Compare against the savings from fewer QA retry iterations.
- Bring real numbers back before flipping.

**Risk:** higher cost per pass. Mitigation: scope the upgrade to nuclear-mode passes only; standard / brutal stay on the cheaper model.

**Effort:** 1 day code + 1 day pricing research and decision.

## 4. Sequencing

The four levers stack. Adopt in priority order; calibrate after each.

1. **Lever B first** (pre-QA self-check). Smallest change, fastest signal. Look at the score distribution on the next 50 to 100 auto-pipeline videos. Did the average first-pass score go up?
2. **Lever A** (prompt tightening). Larger change, harder to roll back, but the highest-leverage. Hold off until B's measurement is in so we can attribute deltas correctly.
3. **Lever C** (stronger generator prompt). Builds on A — the generator now reads the same tightened rubric. Effort overlaps with A so they can land within the same week.
4. **Lever D** (model upgrade) last. Pricing-dependent. Adopt only if A+B+C haven't already crossed the score targets, and only after the cost analysis says it pays back.

Each lever ships behind a per-workspace toggle (default off for existing workspaces, default on for new ones) so the user can roll back if scores destabilize.

## 5. Measurement plan (requires Wave 1's telemetry)

The Command Center plan introduces `video_stage_transitions`. This plan adds two more telemetry surfaces so we can actually measure the impact:

- **Per-pass score logging:** the auto-pipeline already writes `critic_panels.overall_score`. Add a small read-side view: "for each preset, distribution of first-pass scores over the last 100 videos." Lives in `/spend` or a new `/qa-stats` admin page.
- **Iteration count distribution:** "for each preset, how many qa_retry iterations did it take to pass (or fail)?"

These give us a before/after picture for every lever rollout. Without them, we are tuning blind.

## 6. Open questions

1. Should the self-check (Lever B) be on by default for all presets, or opt-in per preset? Default-on means new presets get it for free; opt-in means existing automations are untouched.
2. For Lever D, do we diversify across providers (Claude + OpenAI + Gemini) or stay within one provider's family? Cross-provider diversity is theoretically harsher but has cost and reliability tradeoffs (per standing rule 8).
3. Should we cap nuclear-mode passes at a hard ceiling (e.g. 5 retries) before flagging a script as terminally bad and letting the user step in? Today the preset's `qa_max_iterations` does this; this question is whether 5 is the right default in code.

## 7. Security and observability

- **Security:** prompt content is treated as code; review changes the same way we review code. Anchor examples must not contain PII or proprietary content from external clients. Critic outputs are already gated by the existing rate limits.
- **Observability per standing rule 14:**
  - `[qa self-check]` — log when the pre-QA self-check runs, with the section it rewrote and the score delta.
  - `[qa critic-pass]` — already logged via the existing critic system; verify per-pass scores are captured.
  - `[qa preset-tune]` — log when a workspace flips one of the QA hardening toggles.

## 8. Settings (per standing rule 15)

New settings, grouped under "Workspace > Quality":

- **Pre-QA self-check:** on / off (default off for existing workspaces, on for new).
- **Critic prompt tightening:** on / off (rollback switch in case stricter prompts surface a regression).
- **Generator references inlined:** on / off.
- **Upgraded critic model on nuclear-mode passes:** off by default until pricing is verified.

## 9. UI / UX (per standing rule 16)

No new tool pages. One small addition: the VideoContextStrip's QA badge (already shows `QA 84/100`) gets a tooltip with the per-rubric-line breakdown when hovered. That tooltip is the user's visible feedback loop on whether the prompt tightening is actually catching the right issues.

## 10. Effort estimate

- Lever B: 1 to 2 days.
- Lever A: 2 to 4 days (incl. calibration).
- Lever C: 2 to 3 days.
- Lever D: 1 to 2 days code + 1 day pricing decision (gated).
- Measurement surface: 1 to 2 days.

Total: 1 to 2 working weeks.
