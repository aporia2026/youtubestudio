'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { VideoShot } from '@/remotion/types';
import type { PlayerController } from '@/lib/notes/player-controller';
import { frameToScenePin, formatSceneTs, scenePinToFrame } from '@/lib/notes/scene-math';
import { useNotes } from '@/lib/notes/store';
import { NOTE_TAG_COLOR, NOTE_TAG_LABEL, type NoteTag, type ProductionDocNote } from '@/lib/notes/types';
import { NoteInput } from './NoteInput';
import { useNotesHotkeys } from './useNotesHotkeys';
import { ReviewQueue } from './ReviewQueue';

/** Poll cadence (ms) for tracking the playhead in the grid view. Slow
 *  enough to cost essentially nothing (~4 calls/sec), fast enough that
 *  scene transitions feel responsive in the dock. The editor view
 *  bypasses this entirely — it passes `activeRowIndex` down from its
 *  own state and the dock skips the polling effect. */
const PLAYHEAD_POLL_MS = 250;

/**
 * Notes-while-watching dock — mounts under the player on both surfaces
 * (production-doc grid + Editor view). Shared `useNotes(docId)` store
 * means an addition in one is visible in the other.
 *
 * Layout:
 *   - Top header strip: count + tag dots + "Take note (N)" button +
 *     "Review queue (Shift+N)" button. Always visible.
 *   - When the input is open: full note input panel docked here.
 *   - Notes-for-current-scene list: small chips of recent notes pinned
 *     to whatever scene the playhead is in, click to seek+highlight.
 *
 * Currently-active scene resolution:
 *   - If `activeRowIndex` is passed (Editor view), use that. Editor's
 *     Stage already pins the playhead to a specific section.
 *   - Otherwise compute from `controller.getCurrentFrame()` against
 *     the shot timeline. The grid view uses this fallback.
 *
 * Notes are pinned at note-creation time using the current frame; the
 * dock doesn't try to retroactively re-pin if a doc gets re-timed.
 */
interface Props {
  docId: string | null;
  controller: PlayerController | null;
  shots: VideoShot[];
  fps: number;
  /** When known (editor view), the row currently rendered on the Stage.
   *  Drives both the "current scene" filter and the pin label. */
  activeRowIndex?: number | null;
  /** Optional callback the host wires to its own "set active section"
   *  state. Triggered when a user clicks a note pinned to a different
   *  scene so the host can update its UI too. */
  onSelectRow?: (rowIndex: number) => void;
}

export const NotesDock: React.FC<Props> = ({
  docId,
  controller,
  shots,
  fps,
  activeRowIndex = null,
  onSelectRow,
}) => {
  const { notes, loading, create, remove, toggleResolved } = useNotes(docId);
  const [inputOpen, setInputOpen] = useState(false);
  const [reviewQueueOpen, setReviewQueueOpen] = useState(false);
  // Captured pin for the in-flight note input. We snapshot at the moment
  // the input opens so a brief render jitter doesn't move the pin while
  // the user is typing.
  const [draftPin, setDraftPin] = useState<{ rowIndex: number; sceneTsMs: number } | null>(null);
  // Whether the player was playing when the input opened, so we resume
  // on save / cancel for a "didn't interrupt my watch" feel.
  const [wasPlaying, setWasPlaying] = useState(false);

  const openNoteInput = useCallback(() => {
    if (!docId || !controller) return;
    const playing = controller.isPlaying();
    if (playing) controller.pause();
    setWasPlaying(playing);
    if (activeRowIndex != null) {
      // Editor view: the host already declared which row is active. We
      // pin at the absolute playhead frame and translate to ms within
      // THAT row so even an early-scrubbed playhead points at the row
      // the user has on screen.
      const currentFrame = controller.getCurrentFrame();
      const pin = frameToScenePin(shots, fps, currentFrame);
      // Defensive: if the playhead drifted into another scene, prefer
      // the host's stated activeRowIndex but anchor sceneTsMs to 0.
      if (pin && pin.rowIndex === activeRowIndex) {
        setDraftPin(pin);
      } else {
        setDraftPin({ rowIndex: activeRowIndex, sceneTsMs: 0 });
      }
    } else {
      const currentFrame = controller.getCurrentFrame();
      const pin = frameToScenePin(shots, fps, currentFrame);
      setDraftPin(pin ?? { rowIndex: 0, sceneTsMs: 0 });
    }
    setInputOpen(true);
  }, [docId, controller, shots, fps, activeRowIndex]);

  const closeNoteInput = useCallback(() => {
    setInputOpen(false);
    setDraftPin(null);
    if (wasPlaying) controller?.play();
  }, [controller, wasPlaying]);

  const handleSaveNote = useCallback(
    async (text: string, tag: NoteTag | null) => {
      if (!docId || !draftPin) {
        closeNoteInput();
        return;
      }
      const saved = await create({
        docId,
        rowIndex: draftPin.rowIndex,
        sceneTsMs: draftPin.sceneTsMs,
        text,
        tag,
      });
      // Close the input regardless — a failed save leaves a toast on
      // screen so the user knows; we don't want to keep them stuck in
      // input mode while they sort it out.
      closeNoteInput();
      // Resume happens inside closeNoteInput when wasPlaying was true.
      void saved;
    },
    [docId, draftPin, create, closeNoteInput],
  );

  useNotesHotkeys({
    enabled: Boolean(docId) && !inputOpen && !reviewQueueOpen,
    onTakeNote: openNoteInput,
    onOpenReviewQueue: () => setReviewQueueOpen(true),
  });

  // Grid-view path: poll the controller's frame to detect scene
  // boundaries while the user watches. Editor view passes
  // `activeRowIndex` and skips this entirely. 250ms is cheap and the
  // jitter at scene crossings is imperceptible — the dock's list
  // re-keys naturally as the row index changes.
  const [polledRowIndex, setPolledRowIndex] = useState<number | null>(null);
  useEffect(() => {
    if (activeRowIndex != null) return;
    if (!controller) return;
    const tick = () => {
      const pin = frameToScenePin(shots, fps, controller.getCurrentFrame());
      setPolledRowIndex((curr) => {
        const next = pin?.rowIndex ?? null;
        return next === curr ? curr : next;
      });
    };
    tick();
    const handle = window.setInterval(tick, PLAYHEAD_POLL_MS);
    return () => window.clearInterval(handle);
  }, [activeRowIndex, controller, shots, fps]);

  // Filter to the currently-active scene's notes for the visible list.
  // The full doc's notes are still loaded in `notes`; we just don't show
  // off-scene ones in the dock's main panel (the review queue surfaces
  // those).
  const currentRowIndex = activeRowIndex != null ? activeRowIndex : polledRowIndex;

  const visibleNotes = useMemo(() => {
    if (currentRowIndex == null) return [];
    return notes.filter((n) => n.rowIndex === currentRowIndex);
  }, [notes, currentRowIndex]);

  const openCount = notes.filter((n) => !n.resolved).length;
  const tagCounts = useMemo(() => {
    const counts: Record<NoteTag, number> = { R: 0, T: 0, S: 0, I: 0, P: 0, Q: 0 };
    for (const n of notes) {
      if (n.resolved) continue;
      if (n.tag) counts[n.tag]++;
    }
    return counts;
  }, [notes]);

  const handleSeekToNote = useCallback(
    (note: ProductionDocNote) => {
      if (!controller) return;
      const frame = scenePinToFrame(shots, fps, note.rowIndex, note.sceneTsMs);
      if (frame == null) return;
      controller.pause();
      controller.seekToFrame(frame);
      onSelectRow?.(note.rowIndex);
    },
    [controller, shots, fps, onSelectRow],
  );

  if (!docId) return null;

  const pinLabel = draftPin
    ? `Scene ${draftPin.rowIndex + 1} @ ${formatSceneTs(draftPin.sceneTsMs)}`
    : '';

  return (
    <div
      className="rounded-xl"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--border)',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Header strip — always visible. Count + tag dots + actions. */}
      <div className="flex items-center justify-between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="flex items-center" style={{ gap: 10 }}>
          <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
            Notes
          </span>
          {loading ? (
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              loading…
            </span>
          ) : (
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {openCount} open · {notes.length - openCount} resolved
            </span>
          )}
          <div className="flex items-center" style={{ gap: 4 }}>
            {(Object.keys(tagCounts) as NoteTag[]).map((t) =>
              tagCounts[t] > 0 ? (
                <span
                  key={t}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  title={`${tagCounts[t]} ${NOTE_TAG_LABEL[t]}`}
                  style={{
                    background: `${NOTE_TAG_COLOR[t]}22`,
                    color: NOTE_TAG_COLOR[t],
                  }}
                >
                  {t} {tagCounts[t]}
                </span>
              ) : null,
            )}
          </div>
        </div>
        <div className="flex items-center" style={{ gap: 6 }}>
          <button
            type="button"
            onClick={openNoteInput}
            disabled={inputOpen || !controller}
            title="Pause + take a note about this moment (N)"
            className="text-xs px-2 py-1 rounded"
            style={{
              background: 'rgba(168,85,247,0.16)',
              color: inputOpen || !controller ? 'var(--text-muted)' : '#c084fc',
              border: '1px solid rgba(168,85,247,0.32)',
              cursor: inputOpen || !controller ? 'not-allowed' : 'pointer',
              opacity: inputOpen || !controller ? 0.6 : 1,
            }}
          >
            📝 Take note (N)
          </button>
          <button
            type="button"
            onClick={() => setReviewQueueOpen(true)}
            disabled={notes.length === 0}
            title="Open the full-doc review queue (Shift+N)"
            className="text-xs px-2 py-1 rounded"
            style={{
              background: 'rgba(255,255,255,0.04)',
              color: notes.length === 0 ? 'var(--text-muted)' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
              cursor: notes.length === 0 ? 'not-allowed' : 'pointer',
              opacity: notes.length === 0 ? 0.6 : 1,
            }}
          >
            Review queue
          </button>
        </div>
      </div>

      {/* Note input — only mounted when open, focused immediately. */}
      {inputOpen && draftPin && (
        <NoteInput
          pinLabel={pinLabel}
          onCancel={closeNoteInput}
          onSave={handleSaveNote}
        />
      )}

      {/* Notes pinned to the current scene. Compact list (we expect
          0–10 typically) clickable to seek back to that exact moment. */}
      {visibleNotes.length > 0 && (
        <div className="flex flex-col" style={{ gap: 6 }}>
          {visibleNotes.map((note) => {
            const color = note.tag ? NOTE_TAG_COLOR[note.tag] : 'var(--text-muted)';
            const label = note.tag ? NOTE_TAG_LABEL[note.tag] : null;
            return (
              <div
                key={note.id}
                className="flex items-start gap-2 rounded"
                style={{
                  padding: '6px 8px',
                  background: note.resolved
                    ? 'rgba(255,255,255,0.02)'
                    : 'rgba(255,255,255,0.05)',
                  opacity: note.resolved ? 0.55 : 1,
                  border: '1px solid var(--border)',
                }}
              >
                <button
                  type="button"
                  onClick={() => handleSeekToNote(note)}
                  title={`Seek to ${formatSceneTs(note.sceneTsMs)} in scene ${note.rowIndex + 1}`}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'rgba(0,0,0,0.30)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    flexShrink: 0,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  }}
                >
                  {formatSceneTs(note.sceneTsMs)}
                </button>
                {note.tag && (
                  <span
                    className="text-[10px] px-1 py-0.5 rounded"
                    title={label ?? undefined}
                    style={{
                      background: `${color}22`,
                      color,
                      border: `1px solid ${color}66`,
                      flexShrink: 0,
                      fontWeight: 600,
                    }}
                  >
                    {note.tag}
                  </span>
                )}
                <div
                  className="text-xs"
                  style={{
                    color: 'var(--text-primary)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    flex: 1,
                    minWidth: 0,
                    textDecoration: note.resolved ? 'line-through' : 'none',
                  }}
                >
                  {note.text}
                </div>
                <div className="flex items-center" style={{ gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => void toggleResolved(note.id)}
                    title={note.resolved ? 'Re-open this note' : 'Mark resolved'}
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    {note.resolved ? '↺' : '✓'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(note.id)}
                    title="Delete this note"
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {visibleNotes.length === 0 && !inputOpen && (
        <div
          className="text-[11px] text-center"
          style={{
            color: 'var(--text-muted)',
            padding: '4px 0 2px',
          }}
        >
          {currentRowIndex == null
            ? 'Start playing the video to take notes.'
            : `No notes on this scene yet. Press N to take one.`}
        </div>
      )}

      {reviewQueueOpen && (
        <ReviewQueue
          docId={docId}
          shots={shots}
          fps={fps}
          notes={notes}
          onSeekToNote={(note) => {
            handleSeekToNote(note);
            setReviewQueueOpen(false);
          }}
          onClose={() => setReviewQueueOpen(false)}
          onToggleResolved={(id) => void toggleResolved(id)}
          onDelete={(id) => void remove(id)}
        />
      )}
    </div>
  );
};
