# Schedule Item → Production Doc prefill fix

## Goal
When the user opens Production Doc from inside a schedule item (the "🎬 Production Doc" send-to button), the page should arrive pre-filled with everything we already know: title, script, niche, and the voiceover duration that drives speaking-pace computation. The user should not have to retype context that already lives upstream.

## Current state (verified, not assumed)

| Field | Wired? | Source |
|---|---|---|
| Topic (title) | yes | `loadFullContextForItem` → `item.title` → `setTopic(curr \|\| ctx.topic)` |
| Script | partial | only via `item.project_id`; if absent, script never loads even when `script_id` is set |
| Niche | broken | uses `item.pillar` only; channels table has a `niche` column but it's stripped from the `/api/schedule/[id]` response |
| Duration ("12:10 actual") | not wired | `actualDuration` starts `''` and only changes when the user types |

## Decisions (confirmed with user)
- **Niche**: `item.pillar` wins when set, channel niche is the fallback.
- **Duration**: pull from recorded voiceover when one exists for the linked project.
- **Script**: add a direct `script_id` fallback so the rare orphan case (no `project_id`) still loads.

## Changes

### 1. Server: include channel niche in schedule item GET
**File:** `src/app/api/schedule/[id]/route.ts:36`
Add `'niche', c.niche` to the channels `json_build_object` so the niche reaches the client.

### 2. Type: add niche to ScheduleItem.channels
**File:** `src/lib/schedule.ts:38`
Extend the inline channel shape to include `niche: string | null`.

### 3. New endpoint: GET /api/scripts/[id]
**File (new):** `src/app/api/scripts/[id]/route.ts`
Simple authed GET returning `{ id, content, word_count, estimated_duration_seconds, project_id }`. Used as the standalone fallback when a schedule item has a `script_id` but no `project_id`.

### 4. Client: direct-script fallback in script loader
**File:** `src/lib/schedule-link.ts` (`loadActiveScriptForItem`)
Order of preference:
1. If `project_id` set → existing path (`/api/projects/{id}/scripts`).
2. Else if `script_id` set → `/api/scripts/{script_id}`.
3. Else null.

### 5. Client: niche fallback + voiceover duration in context
**File:** `src/lib/schedule-link.ts` (`loadFullContextForItem` + `ScheduleItemContext`)
- Niche resolution: `item.pillar?.trim() || firstChannel?.niche?.trim() || ''`.
- Add `voiceoverDurationSeconds: number | null` to the context. Populate by fetching `/api/projects/{project_id}/media` and picking the most recent `type='voiceover'` row with a non-null `duration_seconds`. Skip the fetch entirely when `project_id` is null.
- Existing fetches stay parallel — the new media fetch joins the same Promise.all wave so we don't add a serial round-trip.

### 6. Client: seed actualDuration in production-doc
**File:** `src/app/(app)/production-doc/page.tsx:611`-ish
Inside the schedule-link preload effect, after `loadFullContextForItem`, if `ctx.voiceoverDurationSeconds` is set and `actualDuration` is empty, format as `mm:ss` and call `setActualDuration(curr => curr || formatted)`.

## Out of scope
- Capturing duration on the basic ElevenLabs voiceover save (`voiceover/page.tsx` → `/api/projects/[id]/media` POST). The narrator-approved flow already saves duration; the ElevenLabs flow does not. Fixing that is a follow-up; not part of this slice because the user asked for "use data we already have."
- Adding a `target_duration` field to schedule items. Confirmed not wanted — we use the recorded voiceover instead.
- Migrating `pillar` → channel-driven niche in the schedule item UI. Pillar stays as a per-item override.

## Security
- The new `/api/scripts/[id]` endpoint must scope to the caller's workspace. Use the same `apiRoute.authed` wrapper the project endpoints use and filter `WHERE workspace_id = session.ws`. Otherwise any authenticated user could fetch any script by guessing UUIDs.
- No other change opens new attack surface — niche and channel name are already client-visible elsewhere.

## QA
- Golden path: open prod-doc from a schedule item that has project + script + voiceover + channel-with-niche → topic, script, niche, actualDuration all pre-filled.
- Pillar override: same item but with `pillar` set → pillar wins, channel niche ignored.
- No channel: schedule item with no linked channel and no pillar → niche empty.
- No voiceover: schedule item without a recorded voiceover → actualDuration stays empty (no false "0:00").
- Orphan script: schedule item with `script_id` but null `project_id` → script still loads via the new endpoint.
- User-typed first: user types in Topic before the prefill fetch resolves → typed value wins (functional setters already guard this).
- Re-open: user opens prod-doc, edits, closes, re-opens from same item → prefill skipped via `schedulePrefilled` guard; no clobber.
