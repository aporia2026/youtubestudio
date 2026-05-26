# Cross-Feature Integration: Rollout Plan + Deferred Work

**Status:** Living document. Tracks the remaining work after Wave 1 + Wave 2 + Wave 3 + QA hardening + the Phase A engineering follow-ups.
**Owner:** Yoav.
**Date:** 2026-05-26.

This plan replaces the scattered "we'll do this later" notes from the earlier plans with one place to find what's left and how to do it. Read this before picking up any of the items below.

---

## 1. The integration pattern (re-usable)

Every "untouched" feature that operates on a video concept should integrate with the new Command Center via the same building block:

```tsx
import { MakeVideoButton } from '@/components/video-context/MakeVideoButton';

<MakeVideoButton
  title={someTitle}
  niche={optionalNiche ?? null}
  channelId={optionalChannelId ?? null}
  from="<short label that shows in the toast + console>"
  compact   // for tight surfaces (table rows, card footers)
/>
```

The button:
- Posts to `POST /api/videos` (creates project + optional channel link + optional schedule slot).
- Routes the user to `/generator?videoId=NEW_ID` so the Wave 1 strip greets them.
- Workspace-scoped at the API layer (no cross-tenant leakage possible).

**Where it already lives:**
- [src/app/(app)/insights/niches/[slug]/page.tsx](src/app/(app)/insights/niches/[slug]/page.tsx) — per-niche deep dive.
- [src/app/(app)/competitors/dashboard/page.tsx](src/app/(app)/competitors/dashboard/page.tsx) — BreakoutCard footer.
- [src/app/(app)/analyze/[id]/AnalyzeResultClient.tsx](src/app/(app)/analyze/[id]/AnalyzeResultClient.tsx) — Video Analyzer result header (only when stage === 'done' AND videoTitle is set).
- [src/app/(app)/command-center/CommandCenterClient.tsx](src/app/(app)/command-center/CommandCenterClient.tsx) — top-bar "+ New video" button (via `NewVideoDialog`).

## 2. Untouched features — incremental rollout

Apply the pattern above. Each row is one targeted edit; total surface across all of them is small. The pages are large, so use **read-before-edit** discipline (rule 2) to find the right injection point.

| Feature | Where to inject | Title to seed | Niche to seed | Status |
|---|---|---|---|---|
| `/ideas` (Ideas Generator) | Existing "Make video" button already exists. **No change needed** — but optionally swap its `window.location.href` hack for `MakeVideoButton` for consistency. | — | — | **Done — coexists** |
| `/insights/niches/[slug]` (per-niche deep-dive) | Action bar next to "Generate ideas" | report.name | report.name | **Done** |
| `/insights/niches` (list view, 1415 lines) | Per-niche search-result row → small button. The file is a large discover-style UI; read first, find the result-row component, inject in its action footer. | row.name | row.name | Deferred (size risk) |
| `/insights/niches/watchlist` | Per-watchlist-row → small button | row.name | row.name | Deferred |
| `/competitors/dashboard` (BreakoutCard) | Footer of each breakout card | breakout.video_title | (none) | **Done** |
| `/competitors` (channel list, 2232 lines) | Per-channel row → button on hover | "Competitor of {channel.name}" | (none) | Deferred (size risk) |
| `/analyze` (entry) | **Skip** — `?videoId=` already used for YouTube ids on this page. Param collision. | — | — | **Skipped** |
| `/analyze/[id]` (Video Analyzer detail) | After the analysis renders → "+ Make video inspired by this" | snap.videoTitle | (none) | **Done** |
| `/channel-naming` (1160 lines) | Per-suggested-name row | row.name | (none) | Deferred (size risk) |
| `/insights/catalog` | Per-video row | row.title | row.niche | Deferred |

These are all **`compact` variant** integrations. No layout changes needed beyond dropping the button in.

### Strip pattern via TOOL_PATH_TO_LABEL

The VideoContextStrip auto-mounts on any URL with `?videoId=` (it's in `AppLayout`). The VideoEmptyState component also mounts globally and uses `TOOL_PATH_TO_LABEL` to know which routes are "tool pages" where the strip is relevant. As of this commit, the map covers:

- The 10 canonical stage paths (idea / script / qa / voiceover / production-doc / thumbnail / edit / seo / scheduled / published).
- Ancillary tool paths: `/critics`, `/shorts`, `/dub`, `/retention`, `/ab-tests`, `/fix-the-dip`, `/comments`, `/cannibalization`.

What this gets you:
- A user arriving at any of those pages without a `?videoId=` sees the empty-state hint pointing them at the schedule.
- A link from elsewhere (kanban, strip overflow menu) can route to those pages with `?videoId=` and the strip will greet them.

What's still per-page work:
- Each of those ancillary pages doesn't yet **read** the `?videoId=` and prefill its data with the project's script / metadata. That's a per-page integration. The plan section 4 (next-up after a week of using what's shipped) is where this lands once we know which pages users actually want context on.

### /pipeline/[id] integration

The auto-pipeline batch detail page (`/pipeline/[id]`) was Wave 2's "cross-link only" surface. As of this commit it also surfaces an **"Open in Command Center →"** link at the top so the user can jump from the batch view to the kanban view of every in-flight video. The VideoCard component inside the batch detail (694 lines, complex per-stage UI) was deliberately not modified — it remains the canonical per-batch monitor. If you want each video card in a batch to carry an "Open in tool" button per completed stage, that lives in [src/app/(app)/pipeline/[id]/VideoCard.tsx](src/app/(app)/pipeline/[id]/VideoCard.tsx); insert near the existing stage-detail toggles, using `getStageDef(stage).toolPath + '?videoId=' + video.project_id`.

**Deliberately NOT in this list** (analytical features that don't produce new video ideas):
- `/retention` (Retention Predictor) — analyses an existing script, doesn't seed new ones.
- `/ab-tests`, `/comments`, `/fix-the-dip`, `/cannibalization`, `/spend` — all about already-published videos.
- `/workflows`, `/ask-studio` — automation surfaces, not creation.

## 3. Deferred items from prior plans

### 3a. Real schema unification (Wave 4 candidate, intentionally deferred)

Wave 3 unified READS via `projects.current_stage` cached column. The three legacy state-machine columns still exist and are still written by their domain code:

- `projects.status` (legacy enum)
- `pipeline_run_videos.stage` (auto-pipeline owner)
- `schedule_items.status` (publishing-side state)

A future Wave 4 would:
1. Move the writes to all three through `advanceVideo()`.
2. Drop the legacy columns once nothing reads them.

**Hold this until the cached column has been in production for ~30 days** so we can verify nothing surprising surfaces. The migration is irreversible (column drops) so we want confidence.

### 3b. Real-time presence with a shared store (in-memory v1 is shipped)

Current presence (in `src/lib/presence.ts`) is **process-local**. On Vercel with multi-instance traffic, a heartbeat on instance A is invisible to a snapshot on instance B. For a single user or small team this is fine. For larger teams, swap the in-memory `Map` for Upstash Redis with the same API surface:

```ts
// Same exports, same signatures:
recordPresence({ ... });
snapshotWorkspacePresence(workspaceId);
presenceForVideo(workspaceId, videoId);
```

**Cost check first (rule 8):** the free Upstash tier covers ~10k commands/day. At a 20s heartbeat × 5 active users × 8 hours, that's ~57k commands/day → would need the $10/mo tier. Verify current pricing on upstash.com before adopting.

### 3c. Multi-user concurrency / conflict resolution

The presence badge tells you when a teammate has a video open, but two teammates editing the same script simultaneously is last-write-wins. No CRDT, no operational transform. Future work — non-trivial — and only worth it if the team grows past 2-3 collaborators on the same video.

### 3d. Format-archetype as a first-class axis

The Expansionist's idea from the original council debate: "you're not making 20 unique videos, you're making 4 archetypes × 5 variations." Currently archetype lives implicitly in style + tone + niche. Making it explicit would unlock template-driven batch creation.

**Trigger to start this:** Yoav saying "I make N archetypes per channel" in conversation. Until then, defer.

### 3e. Public-facing status pages

Expose the Command Center's per-channel-week summary as a read-only public page (one per channel, gated by a share token). Useful for client transparency on agencies that handle multiple channels for paying clients.

**Trigger:** a real client asks for it. Until then, defer.

### 3f. Rubric V2 as workspace-scoped (currently env-only)

`QA_RUBRIC_V2_ENABLED` is read at module init in `skills/load.ts` to choose which `.md` file to load. To make it workspace-scoped, we'd need to load BOTH the V1 and V2 critic specs at init and pick per-call inside the runner. Not impossible, just bigger than the V2 → V1 fallback already in place.

**Hold until:** users actually need to A/B V1 vs V2 per workspace. Today the env-level flag is enough.

## 4. Concrete next-up after a week of using what's shipped

Once Yoav has a week of real use with everything in production, the highest-leverage next items will likely be:

1. **Whichever stages the WIP limit gets tripped on.** That tells us where to invest engineering: more critics, more narrators, faster editor handoff, etc.
2. **Whichever QA hardening lever moves the `/qa-stats` numbers most.** Double down on it. If none of them move the numbers, the next move is Lever D (model upgrade), which has cost implications and needs a council pass.
3. **The first feature that feels missing.** This is where the integration pattern from §1 above gets applied next.

## 5. Open questions

1. **Should `MakeVideoButton` accept a `scheduledFor` prop?** Right now it doesn't; the user can schedule from the kanban after creation. If we see users always wanting "next week" we should add it.
2. **Should the presence badge show on the strip on a 1-user workspace?** It currently hides when there's ≤1 user. Probably keep it that way (signal vs noise).
3. **Should the legacy Dashboard route eventually 404 or just hide from nav?** Today it's reachable from Settings → About. Decide after a month of use.

## 6. What this plan deliberately does NOT include

- Reimagining of the production-doc editor, narrator portal, or editor portal. These are user-stated hard preservation surfaces.
- Replacement of `/pipeline/[id]` — the auto-pipeline batch monitor stays as-is.
- Any breaking change to the schedule.
- Any non-additive change to existing tool pages beyond inserting the strip / Make-video button.
