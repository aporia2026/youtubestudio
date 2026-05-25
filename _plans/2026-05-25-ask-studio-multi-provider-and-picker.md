# Ask Studio — multi-provider tool use + inline model picker

**Date:** 2026-05-25
**Status:** Draft, pending approval
**Owner:** info@flexelent.com (with Claude)

## Goals

1. Stop the 502 "Could not answer the question — try again." that fires regardless of which default model the user picks for the `ask-studio` feature.
2. Let the user pick a model per-question from an inline dropdown on the Ask Studio page, next to the **▶ Ask** button.
3. Make Ask Studio work across providers, not just Anthropic.

## Root cause of the 502

The agent loop in [src/lib/ask-studio.ts:507-577](src/lib/ask-studio.ts#L507-L577) hard-codes the Anthropic SDK:

```ts
const Anthropic = (await import('@anthropic-ai/sdk')).default;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// …
const response = await client.messages.create({ model: modelId, … });
```

`modelId` comes from `getEffectiveModelId(workspaceId, 'ask-studio')` ([src/lib/model-defaults.ts:134](src/lib/model-defaults.ts#L134)), which returns whatever's saved in `workspace_model_defaults` for the `ask-studio` scope — including non-Anthropic IDs like `gpt-5.5`, `kie-gemini-2.5-pro`, `kie-gpt-5-codex`, `sonar-pro`, etc.

When Anthropic's API sees an unknown model string, it rejects the request in ~200-500ms. The error bubbles up, [src/app/api/ask-studio/questions/route.ts:51-58](src/app/api/ask-studio/questions/route.ts#L51-L58) catches it, and `domainErrorResponse` returns the configured fallback: **502 + "Could not answer the question — try again."** The 440ms response time and "no matter which default model I choose" match this hypothesis exactly.

Secondary issue: the QuestionCard UI only renders `error_message` when the card is expanded, and the toast strips the real message. The user has no way to diagnose without server logs.

## Approach

### A. Provider-routed tool-use loop

Refactor `askStudio()` into:

1. **`runAnthropicLoop`** — the current loop, untouched. Used by direct Anthropic models AND `kie-claude-*` models (which hit `/claude/v1/messages` and follow the same wire format — same code, different `baseURL` on the client).
2. **`runOpenAIToolLoop`** — OpenAI-format tool use (`tools: [{ type: 'function', function: { name, description, parameters }}]`, response has `message.tool_calls[]`). Used by direct OpenAI (`gpt-*`, `o*`) AND Kie's OpenAI-compatible chat endpoint (`kie-gemini-*`, `kie-gpt-5-2`).
3. **`runGeminiToolLoop`** — Google `@google/genai` native tool use (`functionDeclarations`, `functionCall` parts). Used by direct `gemini-*`.

A thin dispatcher picks the loop by inspecting the model's `provider` (from `getModelById`) plus the Kie endpoint type (from `KIE_MODEL_MAP`).

**Excluded from the picker** (no tool-use support or incompatible shape):
- `sonar*` (Perplexity — these are search-grounded chat, not tool-use loops)
- `kie-gpt-5-4`, `kie-gpt-5-5`, `kie-gpt-*-codex` (Kie's `/responses` endpoint has its own tool-use shape; can add later)
- `gemini-3-*`, `gemini-3.1-*` direct (already marked "unverified" in the registry — pointless to expose)

This is a deliberate first-pass scope. Adding the excluded set later is purely additive.

### B. Tool catalog → per-provider schema

`TOOL_CATALOG` stays the source of truth. Three pure converters:

- `toAnthropicTools(catalog) → AnthropicTool[]` (no change — already what we send)
- `toOpenAITools(catalog) → OpenAI.ChatCompletionTool[]`
- `toGeminiTools(catalog) → FunctionDeclaration[]`

`runToolCall(ctx, name, input)` stays unchanged — it's already provider-agnostic.

### C. Inline picker on the Ask Studio page

UI:
- A small `<select>` inserted left of the **▶ Ask** button on the same row.
- Options grouped by provider via `<optgroup>` (Anthropic → OpenAI → Google → Kie). Each option shows `Model Name · $in/$out per Mtok`.
- The picker's initial value resolves in this precedence:
  1. last-used model from `localStorage` (`askStudio.lastModelId`)
  2. workspace default for `ask-studio` (fetched once via `/api/model-defaults`)
  3. feature hardcoded default (`claude-haiku-4-5-20251001`)
- A "Reset to workspace default" link appears when 1 differs from 2/3.
- The picker's value is sent in the POST body's `modelId` field (the route already accepts this — see [route.ts:41](src/app/api/ask-studio/questions/route.ts#L41)).

### D. Better error surfacing

- Drop the silent fallback. Change the route's `fallbackMessage` to `Ask Studio failed — open the question card to see the error.`
- The QuestionCard already shows `error_message` when expanded ([page.tsx:228-232](src/app/(app)/ask-studio/page.tsx#L228-L232)); ensure the card auto-opens for the most recent errored question on first render so the user doesn't have to hunt for it.
- Add a "Copy error" button on errored cards for easier bug reporting.

### E. Lazy-user UX walkthrough (per rule 10)

- First visit: picker defaults to Haiku 4.5 (cheap, fast, Anthropic — known to work). User types a question, hits Ask, sees an answer in 3-8s.
- Power user: opens picker, sees `Sonnet 4.6 · $3/$15` and switches. Picks gets persisted; subsequent questions use Sonnet by default.
- User who already had a non-Anthropic default saved: their default is honored if it's in the supported set. If not, picker falls through to feature default and shows a one-time toast: "Your saved default `gpt-5.5` doesn't support tool use yet. Falling back to Claude Haiku 4.5."
- Errored question: card pre-expands with the red error box visible. No "Try again" button (questions are 1-shot; just re-type or copy-paste).

### F. Security (per rule 13)

- Workspace scoping is unchanged — `runToolCall` already takes `workspaceId` server-side and injects it into every SQL `WHERE` clause. The model cannot bypass it.
- API keys for OpenAI, Google, Kie stay in env vars (already present in the existing `ai.ts` paths). No new key surfaces.
- The model picker is purely client-side; the server re-validates `modelId` against the supported-model allowlist before instantiating any SDK. Sending an unsupported model returns 400 with a precise message, not a 502.
- The agent loop's `MAX_TOOL_ITERATIONS` (6) and `ROW_LIMIT_PER_TOOL_CALL` (50) stay as-is; they bound both query cost and the prompt-injection blast radius if a user pastes adversarial text.

### G. Cost implications (per rule 8)

Current default (Haiku 4.5): ~$1/$5 per Mtok. A typical Ask Studio question uses ~2-5k input + ~500-1500 output across iterations, so ~$0.005-0.02 per question.

Adding the picker doesn't change defaults — it just exposes choice. Per-model cost is shown inline in the picker label. No new third-party services; we already pay for Anthropic, OpenAI, Google, and Kie. Pricing is pulled from `AI_MODELS` (the entries already include `inputCostPerMTok` / `outputCostPerMTok`), so the picker stays accurate as the registry is updated.

No cost-implication review needed beyond what `ai-models.ts` already documents.

## Alternatives considered

### Option 1 — Full multi-provider build *(recommended)*

What's described above. ~300-450 LOC across:
- `src/lib/ask-studio.ts` — split agent loop into three provider runners + dispatcher (~+200 LOC)
- `src/lib/ask-studio-tools.ts` *(new)* — schema converters (~+80 LOC)
- `src/app/(app)/ask-studio/page.tsx` — inline picker + error-card auto-expand (~+50 LOC)
- `src/app/api/ask-studio/questions/route.ts` — allowlist validation + better fallback message (~+15 LOC)
- One new helper to expose the supported-model list to the client

**Why this:** The user explicitly asked for "all providers." Bug fix is essentially free once we're touching the file. Excluded subset (Perplexity, Kie Responses-API) is clearly bounded and can be added later in a 50-LOC follow-up each.

**Risk:** Tool-use protocols vary per provider. Need to consult Context7/SDK docs for each before writing (per rule 9). Edge cases: OpenAI parallel `tool_calls`, Gemini's `functionResponse` chaining, Kie's quirks.

### Option 2 — Anthropic ecosystem only

Picker shows only `claude-*` + `kie-claude-*`. ~80 LOC total. Fixes the 502 by enforcing a known-good allowlist; non-Anthropic options simply don't appear.

**Why not:** User explicitly said "all providers" — shipping less than that requires another round trip. Also, Sonnet/Haiku via Anthropic direct is fine for most cases, but the user clearly wants to try other providers.

### Option 3 — Universal tool-use abstraction in `ai.ts`

Build a generic `runToolUseLoop()` in `ai.ts` that every feature can adopt. ~600-800 LOC. Refactors `ai.ts:236-242` which currently *disables* tool use (`tool_choice: { type: 'none' }`).

**Why not:** Premature abstraction. Ask Studio is the only tool-use surface in the codebase today. If a second feature lands, that's the right time to extract. Doing it now means weeks of refactor for one caller.

## Open questions

None blocking. Confirm scope (option 1) and I'll execute.

## Out of scope (defer)

- Polling-based progress UI for long questions. Current 180s ceiling is fine; loops typically finish in 5-30s.
- Per-question cost preview before hitting Ask (could add via `formatModelPricing(model)` in the picker subtitle — easy follow-up).
- Cross-feature picker pattern (only Ask Studio needs it right now per the request).
- Tool catalog expansion (separate ticket; current 9 tools cover the common questions).

## QA plan (per rule 6)

After implementation, walk through each:

**Golden path:**
- [ ] Anthropic default (Haiku) — ask a data question → answer in <10s with tool trace
- [ ] Anthropic Sonnet — same
- [ ] Kie Claude (Sonnet via Kie) — same
- [ ] OpenAI GPT-5-mini — same
- [ ] Kie Gemini 2.5 Flash — same
- [ ] Google Gemini 2.5 Pro direct — same

**Edge cases:**
- [ ] Pre-saved default = `gpt-5.5` (Responses API, not supported) → picker falls back to Haiku with toast, question succeeds
- [ ] Pre-saved default = `sonar-pro` (no tool use) → same fallback
- [ ] Picker shows the workspace default highlighted/marked
- [ ] localStorage pick persists across reload
- [ ] "Reset to workspace default" link appears and works

**Error paths:**
- [ ] Bad API key for picked provider → real error shown in expanded card, not 502 toast soup
- [ ] Model returns malformed tool call → loop breaks gracefully with a useful trace
- [ ] All iterations exhausted → existing "ran out of tool-call budget" message
- [ ] Sending an unsupported `modelId` in the POST body → 400 with the rejected id and the allowlist URL

**Regressions:**
- [ ] Existing history still renders (rows where `ai_model` is the old default)
- [ ] Delete button still works
- [ ] Suggested prompts still work
