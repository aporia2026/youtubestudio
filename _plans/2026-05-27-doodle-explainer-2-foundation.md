# Plan: Doodle Explainer 2 Foundation Rebuild

**Date:** 2026-05-27
**Status:** Approved, executing
**Pressure-tested by:** LLM council (2026-05-27) — Contrarian, First Principles, Expansionist, Outsider, Executor + 5 peer reviewers + chairman synthesis
**Supersedes execution order in:** `_plans/2026-05-25-near-static-variants.md` (Phase 3 — types + helpers already shipped; remaining sub-phases re-sequenced here)

## Goal

Rebuild the Doodle Explainer 2 image-generation foundation so that:

1. Production-doc image generation actually works end-to-end. Today the output looks wrong (text fights visual refs) and base images sometimes silently fail to generate.
2. "Near-static animation" variants generate correctly via Atlas GPT Image 2 Edit, without manual per-variant tuning.
3. Future style work ships on a regression-safe, observable, reversible foundation rather than the current eyeball-tuned-in-the-dark surface.

## Constraints

- Don't break existing styles (Doodle Explainer v1, cinematic, animation_2d, saved workspace styles).
- Don't bust Vercel's 300s `maxDuration` on script-gen or image-gen routes.
- Atlas rate limit is unpublished. Concurrency must be empirically derived, not guessed.
- No hard schema break. `ProductionRow` shape stays back-compat; new fields are optional.
- Cost discipline (global rule 8): per-job hard cap, not just soft per-video warn.
- Brutal-honesty over scope creep (global rule 12): no style registry, no free tier, no animated-explainer product line. Fix the foundation first.

## Requirements (council-approved execution order)

### Stage 0 — Foundation (versioning, feature flag, observability, golden set)

The change no individual advisor named in the original draft but three peer reviewers independently flagged as Stage 0. Without it every later stage is unverifiable.

- Add `PROMPT_VERSION` constant in `src/lib/production-doc-styles.ts`. Stamp on every generated doc's metadata so any post-ship regression is attributable.
- Add env-var feature flags `USE_SHORT_VARIANT_PROMPT`, `USE_TRIMMED_SUFFIX`. Read at the dispatch point; default to current behavior so the flag is opt-in until each stage promotes.
- Add `[prodoc image-gen telemetry]` log line at every image-gen call: `prompt_version`, `style_id`, `ref_count`, `ref_ids[]`, `suffix_chars`, `variant_prompt_chars`. Goes to existing logger.info path.
- Build golden-set fixtures at `tests/fixtures/prodoc-golden/`: 5 representative rows (1 base, 1 variant, 1 framed-photo, 1 multi-character scene, 1 standalone). Each fixture is a JSON file with the row + a `notes.md` documenting "what good looks like" and the current snapshot URL.
- Build a comparison procedure (markdown checklist for v1; automated diff later if it ships well): regenerate the golden set with current flags vs alternate flags, compare side-by-side.

### Stage 2 — Fix variant edit prompt

Council said ship today. User already hand-verified the 31-word format works.

- Rewrite `composeVariantEditRequest` in `src/remotion/utils.ts`.
- New format: `"<edit instruction>. <style-specific preservation hint>"`. For doodle_explainer_2: `"Keep the same simple black stick-figure drawing and plain white background. No text or extra elements."`
- Drop the `baseRow.ai_image_prompt` prepend entirely. The Edit model sees the input image; re-describing pollutes signal.
- Add `ResolvedStyle.variant_preservation_hint?: string` field for per-style preservation hints (~50-100 chars).
- Test on 10 varied edits before promoting from the flag-default: arm raise, head turn, body lean, prop swap, expression change, eye-widen, mouth-open, frown, raise-eyebrows, lift-leg. Eyeball each.
- Gated behind `USE_SHORT_VARIANT_PROMPT=1` until validation passes.

### Stage 3 — Fix base-not-generating

Council says do this before Stage 1 so the prompt-trim experiment isn't confounded by the base bug.

- Reproduce by generating a fresh doc with current code on a known-trigger script. Dump raw JSON. Confirm whether `base.ai_image_prompt` is empty in variant groups (hypothesis: LLM mis-applies "leave empty on variants" rule to the base too).
- Fix: deterministic post-process pass in `src/lib/production-doc-postprocess.ts`. For every variant group, if `base.ai_image_prompt` is empty AND `base.variant_index === 0`, re-prompt that group ONLY with a focused micro-prompt asking the LLM to fill the missing scene description. ~80 LOC.
- This re-layers responsibility: variant-group integrity is no longer a fragile LLM rule; it's a deterministic guarantee.

### Stage 1 — Aggressive prompt trim

Council says trim more aggressively than originally planned. User's 31-word evidence shows the target is closer to 200 chars than 1,800.

- For ref-bearing styles (≥1 ref): drop `ai_image_suffix` to ~150-250 chars OR to empty entirely. Test both via golden set.
- Trim `doodle_explainer_2.mixing_rules` from 9,657 to ~1,500 chars. Keep: overlay-stock trigger rules, condensed variant-group instructions. Drop: JSON example (schema is in the system prompt), repetitive emphasis, prose explanations of "why".
- ~100-char fallback suffix only fires when refs are unavailable/rejected (the existing `REFERENCE_REJECTED` 409 path).
- Run golden set before and after. Compare every fixture.
- Gated behind `USE_TRIMMED_SUFFIX=1` until validation passes.
- While we're touching every i2i edit call, do a brief audit (~30 min) for the same "re-describing pollutes signal" pattern elsewhere in the codebase.

### Pause — Single end-to-end production run

Compressed from the council's "watch for a week" to one real end-to-end doc generation. Verify Stages 0+1+2+3 produce visibly better output than baseline. If yes, proceed. If no, debug before touching Stage 4.

### Stage 4 — Automatic image generation in the pipeline

The expensive, high-risk stage. Do NOT start until Stages 0-3 are landed and the pause-validation passes.

- **Prerequisite check (before writing code):** read the existing auto-pipeline dispatcher (`src/lib/auto-pipeline/`). Confirm whether `{kind: 'requeue'}` outcomes are supported. If not, building requeue is a separate prerequisite to scope explicitly.
- New stage `generate-production-doc-images` between `generate-production-doc` and `generate-thumbnail`.
- **Idempotency key:** `hash(doc_id, row_index, ai_image_prompt, prompt_version)` → cached `image_url`. Never regenerate the same input. Closes the council's "lost-write, double-execution, orphaned-row" risk.
- **Pass 1:** generate bases in parallel. Concurrency cap empirically derived (see prerequisite below).
- **Pass 2:** generate variants serially per group (each depends on its base's `image_url`).
- **Empirical Atlas test (10-min script):** fire N parallel Atlas Edit calls from a throwaway script. Find the 429 threshold. Set concurrency to half of whatever breaks. Document the result inline.
- **Hard cost cap per job:** default $10, workspace-overridable. Per the council: per-video soft warn at $2 is theater; the runaway risk is per-job. If cumulative job spend exceeds the cap, halt and surface a banner in the editor.
- **Manual UI path:** when `/api/generate/production-doc` POSTs successfully, kick off the same worker fire-and-forget. Editor SSE/poll shows images landing.
- **Chunking for Vercel 300s timeout:** stage handler processes up to 8 rows per invocation, stamps progress on `pipeline_stage_artefacts.metadata_jsonb`, re-enqueues via the dispatcher's requeue path. Cron-sweeper resumes orphaned jobs.
- **Failure cascade:** per-row retry max 2 with exp backoff on 429/5xx. Base failure → mark group `base_failed`, skip variants, surface in editor banner. Don't block pipeline advance.

### Stage 5 — folded into Stage 4

Council said the UX polish (cost preview UI, per-row status, 429 backoff) belongs inside Stage 4, not as a separate stage. Adopted.

## Alternatives rejected

1. **Original 5-stage plan (Stage 1 → 2 → 3 → 4 → 5).** Council unanimous: confounds Bug 3 with Stage 1's prompt trim, missing Stage 0, premature Stage 4. Replaced by the verdict-derived sequence above.
2. **Style marketplace / free tier / animated-explainer product line (Expansionist advisor).** All five peer reviewers rejected. You don't compound a platform on a substrate that doesn't yet reliably ship one style.
3. **Full architectural rewrite of the script-gen/image-gen contract (First Principles advisor).** Directionally correct (the script-gen LLM owning prose image prompts AND variant-group logic is a layering violation), but a six-month timeline. Stage 2 + Stage 3 post-processor are the first step of the same re-layering; revisit deeper rewrite after empirical data from Stages 0-3.
4. **Big-bang single PR.** User direction is staged shipping. Council confirmed.
5. **Separate worker for image gen (instead of auto-pipeline stage).** User direction is auto-pipeline integration. Council didn't relitigate.
6. **Soft warn only, no hard cap.** Council and reviewers all flagged: soft warn doesn't stop a retry storm or regen-spam. Hard cap per job is mandatory.

## Security + safety (global rule 13)

- `variant_edit_prompt` is user-input. Already capped at 400 chars in the editor input. Sanitize newlines + control chars before injecting into the Atlas prompt to prevent prompt-structure escape.
- API keys (`ATLAS_CLOUD_API_KEY`, `KIE_API_KEY`) remain server-side env vars; never exposed to client.
- Cost ceiling is a defense-in-depth measure against runaway cost from prompt injection, retry storms, or runaway jobs.
- Rate limits on `/api/generate/production-doc/image` and `/image/edit` already in place (30/min/IP + 30/min/uid; 20/min/IP for edit). No changes needed.
- Prompt-version stamping enables forensic attribution post-incident — "this bad output came from prompt v3 + style v5 + refs [...]".
- Idempotency cache (Stage 4) prevents double-charging from re-enqueue / cron-sweeper double-execution.
- No PII or credentials in the new telemetry log line.

## Cost analysis (global rule 8)

Per the existing Atlas Cloud catalog (verified 2026-05-25, treat as ~$0.011/Edit call; tokens true-up via telemetry):

- Typical 30-row doc with ~3 variant groups: ~24 i2i base/standalone × $0.04 (NanoBanana 2) = $0.96 + ~9 variant edits × $0.011 = $0.099 → **~$1.06 per video**.
- Worst-case 120-row doc with all variant groups: ~$5.50 — well under the $10 hard cap.

Workspace defaults: soft warn $2 (user direction), hard cap $10 (council requirement).

Golden set storage: ~1MB JSON+PNG fixtures, negligible.

Re-verify Atlas pricing live before Stage 4 lands (rule 8 — don't rely on training-data prices).

## QA checklist (global rule 6 — full pass per stage)

For every stage:

- [ ] `tsc --noEmit` clean
- [ ] `npm test` green (existing test suite)
- [ ] Golden set: every fixture renders, no regression vs prior stage's snapshot
- [ ] One real end-to-end production-doc generation passes manual eyeball QA
- [ ] Existing styles (doodle_explainer v1, cinematic, animation_2d, saved workspace styles) unaffected — generate one row in each, compare to current

Plus stage-specific:

- [ ] Stage 0: every image-gen log line includes prompt_version + ref_count
- [ ] Stage 2: all 10 varied edit types produce on-style output
- [ ] Stage 3: variant groups always have non-empty base ai_image_prompt post-process
- [ ] Stage 1: trimmed-suffix renders match or exceed pre-trim quality on golden set
- [ ] Stage 4: cost ceiling halts at threshold; idempotency cache prevents duplicate Atlas calls; chunking resumes after simulated timeout

## Open questions

1. **Golden-set fixture source.** Does the user have a known-failing doc JSON (Stage 3 reproducer) we can use directly, or do I generate fresh docs to capture as fixtures? — *resolve at Stage 3 entry*.
2. **Auto-pipeline requeue support.** Does the existing dispatcher (`src/lib/auto-pipeline/`) accept a `{kind: 'requeue'}` outcome, or is that infrastructure I need to add as a prerequisite to Stage 4? — *resolve at Stage 4 entry by reading the dispatcher*.
3. **Atlas concurrency cap.** Unpublished; needs empirical test. — *resolve at Stage 4 entry via throwaway script*.
4. **Feature-flag storage v1.** Env vars for Stage 0, migrate to workspace settings if it ships well. — *resolved: env vars for v1*.
5. **Per-style `variant_preservation_hint` defaults.** For non-doodle styles (cinematic, animation_2d, etc.), what's the right hint? — *resolve at Stage 2 by reading each style's character and writing one preservation hint per built-in style*.

## References

- Council verdict transcript (this session, 2026-05-27).
- Atlas Cloud docs: <https://api.atlascloud.ai> — re-verify before Stage 4.
- Plans superseded by this one's execution order: `_plans/2026-05-25-near-static-variants.md` (the original Phase 3 plan).
- Active companion plans not touched by this rebuild: `_plans/2026-05-25-doodle-explainer-2-built-in.md` (Phase 1, shipped), `_plans/2026-05-25-style-aware-overlay-text.md` (Phase 2, shipped).
