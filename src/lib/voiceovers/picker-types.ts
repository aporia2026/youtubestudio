/**
 * Shared types + matching helpers for the voiceover picker.
 *
 * Batch A of `_plans/2026-05-20-editor-prod-doc-parity-batches.md`.
 *
 * Lifted from `app/(app)/production-doc/page.tsx` so both surfaces
 * (production-doc + editor) consume the same logic. The picker
 * component itself lives in `src/components/voiceover/VoiceoverPicker.tsx`
 * and depends on these types.
 *
 * No behavioural change vs the inline definitions — same match
 * precedence (scheduleItem > project > title > most-recent), same
 * source labels, same `VoiceoverItem` shape.
 */

/**
 * Unified voiceover record for the picker. Merges two underlying sources:
 *
 *   - ElevenLabs voiceovers from the per-user history (scoped by uid via
 *     /api/history). Linked to a video by scheduleItemId / videoTitle.
 *   - Workspace media_assets of type='voiceover'. These cover narrator-
 *     approved full uploads and stitched section assemblies (see
 *     /api/voiceovers/library). Linked by projectId + assignmentId, and
 *     by scheduleItemId via the narrator_assignment_id pointer that the
 *     assignment-create flow writes into schedule_items.custom_fields.
 */
export interface VoiceoverItem {
  id: string;
  source: 'elevenlabs' | 'narrator_full' | 'narrator_stitched' | 'media_asset';
  audioUrl: string;
  voiceName: string;
  /** Optional narrator/role for `narrator_*` entries, used as a sublabel. */
  badgeLabel: string | null;
  videoTitle: string | null;
  projectId: string | null;
  assignmentId: string | null;
  scheduleItemId: string | null;
  timestamp: number;
  /** Optional summary line for ElevenLabs entries (char count + text preview). */
  summary: string | null;
}

export function sourceLabel(s: VoiceoverItem['source']): string {
  switch (s) {
    case 'elevenlabs':
      return 'ElevenLabs';
    case 'narrator_full':
      return 'Narrator';
    case 'narrator_stitched':
      return 'Narrator (stitched)';
    case 'media_asset':
      return 'Library';
  }
}

/**
 * Pick the best-matching voiceover for the current project / doc.
 *
 * Precedence:
 *   1. Same schedule item — strongest signal, works for both ElevenLabs
 *      (entry.scheduleItemId) and narrator (resolved server-side from
 *      schedule_items.custom_fields).
 *   2. Same project — narrator audio is project-scoped, so a project
 *      match is almost as strong as a schedule-item match for those rows.
 *   3. videoTitle / projectTitle match against known titles
 *      (case/whitespace insensitive).
 *   4. Most recent — fallback so the field isn't empty for users who skip
 *      schedule items / haven't named their doc yet.
 */
export function pickBestVoiceover(
  list: VoiceoverItem[],
  scheduleItemId: string | null | undefined,
  projectId: string | null | undefined,
  candidates: Array<string | null | undefined>,
): VoiceoverItem | null {
  if (list.length === 0) return null;

  if (scheduleItemId) {
    const byItem = list.find((v) => v.scheduleItemId === scheduleItemId && v.audioUrl);
    if (byItem) return byItem;
  }

  if (projectId) {
    const byProject = list.find((v) => v.projectId === projectId && v.audioUrl);
    if (byProject) return byProject;
  }

  const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const titles = candidates.map(norm).filter(Boolean);
  if (titles.length > 0) {
    const byTitle = list.find((v) => {
      if (!v.audioUrl) return false;
      const vt = norm(v.videoTitle);
      return vt && titles.includes(vt);
    });
    if (byTitle) return byTitle;
  }

  // Final fallback: most recent entry that actually has an audio URL.
  return list.find((v) => v.audioUrl) ?? null;
}

/**
 * Which match signal won (for telemetry / "auto-detected from X" copy).
 * Returns `null` when nothing matched at all (fallback would just be
 * "most recent").
 */
export function describeMatchSignal(
  match: VoiceoverItem,
  scheduleItemId: string | null | undefined,
  projectId: string | null | undefined,
  candidates: Array<string | null | undefined>,
): 'scheduleItem' | 'project' | 'title' | 'recent' {
  if (scheduleItemId && match.scheduleItemId === scheduleItemId) return 'scheduleItem';
  if (projectId && match.projectId === projectId) return 'project';
  const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const titles = candidates.map(norm).filter(Boolean);
  if (titles.length > 0 && titles.includes(norm(match.videoTitle))) return 'title';
  return 'recent';
}

/** Human-readable timestamp ago — used by the picker's row meta. */
export function relativeVoiceoverTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}
