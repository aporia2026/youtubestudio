# 2026-06-07 — Channel-clone mid-run model picker: cross-provider

The mid-run "Stage failed — retry with a different model?" picker
([ChannelClonePanel.tsx:737-741](src/components/channel-clone/ChannelClonePanel.tsx#L737-L741))
currently only lists three Anthropic models (Opus 4.8, Sonnet 4.6,
Haiku 4.5). The backend already accepts any model id the registry
recognises — only the UI is artificially narrowed.

User decision in chat: **"I want much more models, not only Anthropic.
All relevant models from our kie.ai integration and our OpenAI API."**

## Goals

1. **Expose every relevant model** in the mid-run retry picker. The
   AI registry in [src/lib/ai-models.ts](src/lib/ai-models.ts) already
   carries ~60 models across Anthropic, OpenAI, Kie.ai (Gemini +
   Claude-via-Kie + GPT-via-Kie + Codex variants), Google, and
   Perplexity. The picker should mirror that.
2. **Group by provider** so the dropdown stays scannable rather than
   being a flat list of 60 entries.
3. **Smart default selection** — when the picker opens, pre-select
   the model that's NOT the one that just failed. Today it
   pre-selects "Sonnet 4.6" by hardcoded index — which is a stupid
   default for half the operators.
4. **No bias toward any provider** (rule 17). The dropdown shows
   capability + cost honestly; the operator picks based on the
   specifics of the failure.
5. **Apply the same widening to the per-stage Settings → Model
   Defaults picker** for channel-clone if and only if it's currently
   narrowed (audit + decide in this plan).

## Non-goals

- **No new model entries in `AI_MODELS`.** The plan is to expose the
  existing registry to a UI that today hides most of it. No
  registry additions.
- **No default-chain changes.** Per memory
  `feedback_model_defaults_user_owned.md`, `DEFAULT_FALLBACK_CHAINS`
  / `defaultModelId` / `SONNET` / `HAIKU` / `OPUS_48` constants are
  user-owned. This plan does not touch them.
- **No model removal.** Even the unverified Gemini 3 direct entries
  stay in the picker (they show their "(unverified)" suffix from
  the registry).
- **No Ask Studio coupling.** Ask Studio has its own
  `isAskStudioSupportedModel` filter for tool-use protocol support.
  Channel-clone stages just need text generation, so the filter does
  not apply here. The picker uses the full `AI_MODELS` set.

## Constraints

### Cost (rule 8)

This is a pure UI change. Costs are entirely a function of which
model the operator picks at retry time — the registry already
surfaces `formatModelPricing(m)` for every model. The picker will
render that string so the operator sees the true per-MTok rate
before they retry.

No new API spend introduced by this plan itself.

### Backend compatibility (rule 1 — verify before assuming)

The per-stage POST routes (`/api/channel-clone/{analyze,topics,hooks,
script,rowify,publish-pack}`) read `modelId` from the body and pass
it through `getEffectiveModelId(featureSpec, { modelOverride })`.
Verified by reading the RetryWithModel comment at
[ChannelClonePanel.tsx:743-747](src/components/channel-clone/ChannelClonePanel.tsx#L743-L747):
*"The runner reads `modelId` → `modelOverride` → bypasses
`getEffectiveModelId` for this one run."* That accepts any registry
id. No backend change needed.

Failure case to handle: a stage that uses multimodal input (e.g.
analyze sends frames to the model) breaks if the operator picks a
text-only model. The picker tags each model with `multimodal` /
`audio-only` capability and prevents picking incompatible ones for
multimodal stages.

### UX (rule 10, 16)

The picker today is a `<select>` element with 3 entries. With 60+
entries, a flat select is unusable on mobile and noisy on desktop.

Layout: **provider-grouped `<optgroup>` `<select>`**. Native HTML, no
new component library. Order:

1. Anthropic (5 entries)
2. OpenAI (15 entries, family-grouped within)
3. Kie.ai — Gemini (6 entries)
4. Kie.ai — Claude (6 entries)
5. Kie.ai — GPT / Codex (8 entries)
6. Google (direct) (7 entries; Gemini 3.x marked unverified)
7. Perplexity Sonar (5 entries; web-search badge)

Each option label format: `{Display Name} — $X in/$Y out/MTok`.
Long names → CSS `text-overflow: ellipsis` on the closed picker.

The CURRENTLY-CONFIGURED model for the failed stage is shown ABOVE
the picker as "Originally used: {modelName}" so the operator sees
what didn't work without having to remember.

Pre-select logic:
- If the stage's configured default model is the one that just failed
  → pre-select the next-best alternative in a different provider
  (Anthropic → OpenAI mid-tier, OpenAI → Anthropic mid-tier, Kie →
  direct equivalent, etc.). A small `pickRetryAlternative(failedId)`
  helper returns this.
- The pre-select is a HINT, not a commitment — the operator can pick
  anything else. The button stays labelled "Retry with model" so the
  action is explicit.

Empty / pathological state:
- If a model in `AI_MODELS` no longer exists (we removed one between
  the time the operator picked it and the retry), the picker shows
  the missing id with a "(missing — pick another)" suffix and
  disables the Retry button until the operator picks something else.

### Security (rule 13)

- No new attack surface; this is a UI widening of an existing
  per-stage POST endpoint that already validates model ids server-side.
- Re-validate `getModelById(modelId)` server-side in every channel-clone
  stage route (this is already done — audit pass during rollout
  confirms it still is).
- Audit: ensure the `modelId` value never reaches a `dangerouslySetInnerHTML`
  / log-injection sink. Currently it's piped into `console.log`s — fine,
  not a sink.

## Architecture

### Files added

- `src/components/channel-clone/ModelRetryPicker.tsx` — replaces the
  inline `<select>` block at [ChannelClonePanel.tsx:826-829](src/components/channel-clone/ChannelClonePanel.tsx#L826-L829).
  Renders the grouped `<select>` from `AI_MODELS`. Exports a
  `pickRetryAlternative(failedModelId, registry)` helper that returns
  the best cross-provider alternative.
- `src/lib/channel-clone/retry-alternative.ts` — pure helper for the
  picker. Pure function = unit-testable in isolation.
- `tests/retry-alternative.test.ts` — unit tests for the alternative
  picker.

### Files modified

- `src/components/channel-clone/ChannelClonePanel.tsx` — replace
  `MID_RUN_MODEL_CANDIDATES` with `import { AI_MODELS } from
  '@/lib/ai-models'`; mount `<ModelRetryPicker />` instead of inline
  select; thread the failed stage's configured-default model id so
  the picker can label "Originally used".
- `src/lib/channel-clone/types.ts` — add `modelUsed?: string` to
  `productionRows` and `auditHistory` entries (already exists on
  `analysis` and `publishPack`; missing on the other stages). This
  lets the picker display "Originally used" reliably across all
  failure types. **DB migration not required** (JSONB).

### NO files modified (despite seeming relevant)

- `src/lib/ai-models.ts` — UNTOUCHED. Per memory
  `feedback_model_defaults_user_owned.md`, model defaults are
  user-owned. This plan widens an UI dropdown, not the registry.
- The per-stage POST route handlers — already accept any registry id.
- Settings → Model Defaults panel — already renders pickers from
  the full registry (it uses `AI_MODELS` directly). Verified by
  re-reading `APP_FEATURES` comments at
  [src/lib/ai-models.ts:60-62](src/lib/ai-models.ts#L60-L62):
  *"Each gets its own AppFeature so the existing Settings → Model
  Defaults panel renders a per-stage picker automatically."*

So the surface to widen is **just the one mid-run picker**.

### Multimodal-stage capability filter

`channel-clone-analyze` is the only stage that currently feeds frames
(multimodal input) to the model. The picker needs to filter out
text-only models for this stage to prevent the retry from failing
the moment it starts. Implementation:

```ts
// src/lib/channel-clone/retry-alternative.ts
const MULTIMODAL_STAGES = new Set(['analyze']);

const KNOWN_TEXT_ONLY = new Set<string>([
  // Perplexity Sonar models — chat + web search, no image input
  'sonar', 'sonar-pro', 'sonar-reasoning',
  'sonar-reasoning-pro', 'sonar-deep-research',
  // OpenAI o-series — reasoning + text only on chat completions
  'o3', 'o3-mini', 'o4-mini',
  // Kie Codex variants — coding-focused responses endpoint, no img
  'kie-gpt-5-codex', 'kie-gpt-5-1-codex', 'kie-gpt-5-2-codex',
  'kie-gpt-5-3-codex', 'kie-gpt-5-4-codex',
]);

export function isModelCompatibleWithStage(
  modelId: string,
  stage: 'analyze' | 'topics' | 'hooks' | 'script' | 'rowify' | 'publish-pack' | 'intake-summary' | 'voice-profile',
): boolean {
  if (stage === 'voice-profile') {
    // Audio-input stages: only Gemini family is reliably audio-capable
    // in our registry today.
    return modelId.includes('gemini');
  }
  if (!MULTIMODAL_STAGES.has(stage)) return true;
  return !KNOWN_TEXT_ONLY.has(modelId);
}
```

(The `voice-profile` branch is for Plan 1 — included here so the same
helper covers both surfaces.)

### Picker label format examples

```
Anthropic
  ⚪ Claude Opus 4.8 — $5 in / $25 out / MTok
  ⚪ Claude Opus 4.7 — $5 in / $25 out / MTok
  ⚪ Claude Sonnet 4.6 — $3 in / $15 out / MTok
  ⚪ Claude Haiku 4.5 — $1 in / $5 out / MTok

OpenAI
  ⚪ GPT-5.5 — $1.50 in / $12 out / MTok
  ⚪ GPT-5.5 Mini — $0.30 in / $2.40 out / MTok
  ⚪ GPT-5.4 — $1.40 in / $11 out / MTok
  ⚪ GPT-5.4 Mini — $0.28 in / $2.20 out / MTok
  ...

Kie — Gemini
  ⚪ Gemini 3.1 Pro — $1.50 in / $6 out / MTok
  ⚪ Gemini 3 Pro — $1.50 in / $6 out / MTok
  ⚪ Gemini 3 Flash — $0.10 in / $0.40 out / MTok
  ⚪ Gemini 2.5 Pro — $1.25 in / $5 out / MTok
  ⚪ Gemini 2.5 Flash — $0.075 in / $0.30 out / MTok

Kie — Claude
  ⚪ Claude Opus 4.7 (Kie) — $12 in / $60 out / MTok
  ⚪ Claude Sonnet 4.6 (Kie) — $2.40 in / $12 out / MTok
  ...

Kie — GPT / Codex
  ⚪ GPT 5.5 (Kie) — $4 in / $16 out / MTok
  ⚪ GPT-5.4 Codex (Kie) — $4 in / $16 out / MTok
  ...
```

This gives the operator a price-aware lateral move at a glance.

## Settings (rule 15)

**No new settings.** The Settings → Model Defaults panel already
covers the per-stage default-model selection across the full
registry. The widened mid-run picker is just a UI catch-up to match.

Existing setting that gains relevance: the per-stage default in
Settings → Model Defaults → Channel Clone — this is what the picker
shows under "Originally used". No change needed.

## Observability (rule 14)

Logs are already in place for `modelId` passing through the per-stage
routes. Add one new line in the picker UI:

```ts
console.info('[channel-clone retry-picker]', {
  stage,
  originalModelId,
  pickedModelId,
  reason: 'user-selected' | 'pre-selected-alternative',
});
```

So we can debug "the operator says the picker pre-selected something
weird" without guessing.

## Testing (rule 18)

Unit:
- `tests/retry-alternative.test.ts`:
  - Anthropic failure → returns a Kie or OpenAI mid-tier
    (and not another Anthropic model).
  - OpenAI failure → returns an Anthropic mid-tier.
  - Kie failure → returns the direct-provider equivalent.
  - Unknown modelId → returns the registry's first model.
  - `isModelCompatibleWithStage` correctly excludes text-only models
    from analyze + voice-profile stages.
- `tests/model-retry-picker.test.tsx` (RTL):
  - All AI_MODELS render grouped by provider.
  - "Originally used" label is shown when prop is set.
  - Disabled state on stages with no compatible models (defensive).
  - Picking a model fires the onChange with the id.
- Snapshot the rendered option list per stage so a future change to
  `AI_MODELS` surfaces as a deliberate test diff (per rule 6 — catch
  regressions in adjacent code).

Manual QA per rule 6:
- Force-fail a stage (e.g. set an invalid model in the env so the
  primary call 422s), confirm the picker appears with all 60 options.
- Pick an OpenAI model, hit Retry — verify the request reaches the
  OpenAI route and the run advances.
- Pick a Kie model, hit Retry — verify Kie endpoint hit (look for
  the `[ai kie-call]` log line).
- Pick a Perplexity Sonar model on a text stage — verify it works
  (Sonar models output plain text on the chat completions surface).
- Pick a Perplexity Sonar model on analyze — verify the picker
  disables it (multimodal incompatibility).
- Reload the page mid-retry — verify the picker preserves selection
  via URL hash or session storage.

## Alternatives (rule 4)

### A — group by provider in a native `<optgroup>` `<select>` (chosen)

Zero new dependencies, accessible by default, mobile-friendly (native
controls open the system picker on iOS / Android with proper search
on long lists). Each option carries its price so the operator can
make a cost-aware choice. **The path I recommend.**

### B — searchable combobox (Command-K style)

Type to filter "gpt", "haiku", "kie". Better UX on desktop for power
users; requires either a new component dependency (e.g. `cmdk`) or a
hand-rolled keyboard-nav widget. The accessibility + mobile story is
worse than native. **Rejected for now** — can revisit if the operator
asks for it. Native `<select>` is a fine starting point.

### C — two-step picker (provider → model)

Pick provider first, then model. Cleanest visual; two clicks instead
of one. **Rejected** — the optgroup variant gets us the same
clean-grouping benefit in one click. Two-step is overkill at 60
entries.

### D — replace the mid-run picker with the existing Settings → Model
Defaults panel mounted inline

Use the same per-stage picker the Settings page renders. **Rejected**
— Settings changes are permanent; the mid-run picker is a one-shot
override for THIS retry. Conflating the two would lead to operators
accidentally changing their persisted defaults when they meant to
override once. The label "Retry with model" preserves the one-shot
semantics.

## Open questions for the user

1. **Should the picker also surface `formatModelPricing(m)`** as the
   label suffix per the mockup above, or keep labels clean (model
   name only) and show pricing on hover via title attribute?
   Proposal: show inline — operators are making a cost-impacting
   decision and shouldn't need to hover to see it.
2. **Smart default selection** — when an Anthropic model fails, the
   helper pre-selects "the cheapest OpenAI mid-tier" by default. The
   reasoning: most stage failures are rate-limits or content-filter
   refusals on the primary provider; jumping providers usually clears
   it. Is this the right heuristic, or do you prefer "same provider,
   cheaper tier" as default?
3. **Codex Kie variants** (gpt-5-N-codex) — are these even useful for
   the channel-clone stages? They're coding-tuned. We can hide them
   from this picker without removing them from the registry.
   Proposal: hide on channel-clone retries, keep registered.
4. **Hard cap on the dropdown size** — 60 entries scrolls fine on
   desktop, painful on mobile. Native `<select>` on iOS opens a
   wheel-picker that handles this well, but Android varies. Worth
   it to ship a search-filter input ABOVE the select that filters
   the options as the user types? Cheap to add, no new dep.

## Rollout

1. Add `src/lib/channel-clone/retry-alternative.ts` + tests.
2. Add `src/components/channel-clone/ModelRetryPicker.tsx` + RTL test.
3. Swap `RetryWithModel` in `ChannelClonePanel.tsx` to use the new
   picker; remove `MID_RUN_MODEL_CANDIDATES`.
4. QA pass per the manual list above.
5. **Do not change** `AI_MODELS`, `DEFAULT_FALLBACK_CHAINS`, or any
   per-stage `defaultModelId` in this commit — those are the user's
   call (memory: `feedback_model_defaults_user_owned.md`).

## Linkage to the other 2026-06-07 plans

- Plan 1 (narrator voice + ElevenLabs) introduces a new
  `channel-clone-voice-profile` AppFeature. The picker built here
  will automatically pick that stage up once added to the failed
  stages set; the `isModelCompatibleWithStage` helper already gates
  it to Gemini-family (audio-capable) models.
- Plan 2 (preset templates) is independent; templates store the
  config snapshot but do NOT pin a specific model — model choice
  remains the operator's per-run decision via the registry.
