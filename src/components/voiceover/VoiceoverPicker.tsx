'use client';

/**
 * Shared voiceover picker — Batch A of
 * `_plans/2026-05-20-editor-prod-doc-parity-batches.md`.
 *
 * Lifted out of `app/(app)/production-doc/page.tsx` so both the
 * production-doc page and the editor's Audio panel mount the same
 * component. Behaviour matches the inline original verbatim:
 *
 *   - Merges two sources on mount: ElevenLabs history (per-user) and
 *     workspace `/api/voiceovers/library` (narrator stitched / full,
 *     plus other media_assets).
 *   - Auto-picks the best match on first load via `pickBestVoiceover`
 *     (scheduleItem > project > title > most-recent).
 *   - `userTouchedRef` guards the auto-pick so a manual selection is
 *     never silently clobbered.
 *   - Preview audio plays inline on the play-button click; stops on
 *     unmount / select / close.
 *
 * The picker is intentionally framework-aware about the visual chrome —
 * it uses `var(--text-*)` / `var(--border)` tokens that exist in both
 * production-doc and the editor's scoped theme (editor-theme.css
 * aliases `--card-border` and friends to the canonical workspace
 * tokens). Both surfaces get the same look without duplication.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getVoiceoverHistory } from '@/lib/history';
import {
  describeMatchSignal,
  pickBestVoiceover,
  relativeVoiceoverTime,
  sourceLabel,
  type VoiceoverItem,
} from '@/lib/voiceovers/picker-types';
import { Skeleton } from '@/components/editor/Skeleton';

export interface VoiceoverPickerProps {
  /** Current URL (controlled — keeps Remotion player API untouched). */
  value: string;
  /** Setter that also persists "user touched this" intent. */
  onChange: (url: string, source: 'auto' | 'manual' | 'clear') => void;
  /** Schedule item id we're linked to, if any (strongest match signal). */
  scheduleItemId: string | null | undefined;
  /** Project id (projects.id, not user_history.id). Matches narrator audio
   *  and other media_assets. */
  projectId: string | null | undefined;
  /** Title candidates to match against entry.videoTitle (in priority order). */
  titleCandidates: Array<string | null | undefined>;
  /** Optional namespace prefix for the picker's `[voiceover-picker]` logs.
   *  Defaults to `voiceover-picker` so each surface labels its own events
   *  for the observability trail. */
  logNamespace?: string;
  /** Optional. When `projectId` is null and the user clicks Upload / Save
   *  to library, the picker calls this to lazily create (or look up) a
   *  project to scope the new media_assets row against. Returning `null`
   *  aborts the action without an error toast — the caller is expected
   *  to surface its own message in that case. See
   *  `_plans/2026-05-27-voiceover-upload-without-saved-project.md`. */
  onRequireProject?: () => Promise<string | null>;
}

interface LibraryRow {
  id: string;
  audioUrl: string;
  name: string;
  narratorName: string | null;
  projectId: string | null;
  projectTitle: string | null;
  assignmentId: string | null;
  scheduleItemId: string | null;
  timestamp: number;
  source: 'narrator_full' | 'narrator_stitched' | 'other';
}

export function VoiceoverPicker({
  value,
  onChange,
  scheduleItemId,
  projectId,
  titleCandidates,
  logNamespace = 'voiceover-picker',
  onRequireProject,
}: VoiceoverPickerProps) {
  const [items, setItems] = useState<VoiceoverItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [autoMatchedId, setAutoMatchedId] = useState<string | null>(null);
  const userTouchedRef = useRef(false);
  const playingIdRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  // Upload-from-computer state: the file input is hidden, the trigger
  // sits at the top of the popover. `uploadingFile` is the in-flight
  // filename so we can show "Uploading <name>…" instead of just a spinner.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingFile, setUploadingFile] = useState<string | null>(null);
  // "Save to library" in-flight tracking — keyed by the source item id
  // ("el:<historyId>") so the right row shows the spinner instead of
  // freezing the whole picker.
  const [savingToLibraryId, setSavingToLibraryId] = useState<string | null>(null);

  /**
   * Fetch ElevenLabs history + workspace library in parallel and merge into
   * a single deduped, sorted list. Pulled out of the mount effect so the
   * upload + save-to-library handlers can refresh the picker after they
   * insert a new media_assets row without forcing a remount.
   */
  const loadVoiceovers = useCallback(async (): Promise<VoiceoverItem[]> => {
    const elevenlabsPromise = getVoiceoverHistory()
      .then((list) =>
        list.map(
          (e): VoiceoverItem => ({
            id: `el:${e.id}`,
            source: 'elevenlabs',
            audioUrl: e.audioUrl,
            voiceName: e.voiceName,
            badgeLabel: null,
            videoTitle: e.videoTitle ?? null,
            projectId: null,
            assignmentId: null,
            scheduleItemId: e.scheduleItemId ?? null,
            timestamp: e.timestamp,
            summary: e.textPreview
              ? `${e.charCount.toLocaleString()} chars · ${e.textPreview.slice(0, 60)}${
                  e.textPreview.length > 60 ? '…' : ''
                }`
              : null,
          }),
        ),
      )
      .catch(() => [] as VoiceoverItem[]);

    // eslint-disable-next-line no-restricted-syntax -- GET, read
    const libraryPromise = fetch('/api/voiceovers/library', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { voiceovers: [] as LibraryRow[] }))
      .then((data: { voiceovers?: LibraryRow[] }) =>
        (data.voiceovers || []).map(
          (e): VoiceoverItem => ({
            id: `lib:${e.id}`,
            source: e.source === 'other' ? 'media_asset' : e.source,
            audioUrl: e.audioUrl,
            voiceName: e.narratorName || e.name || 'Narrator',
            badgeLabel:
              e.source === 'narrator_stitched'
                ? 'stitched'
                : e.source === 'narrator_full'
                  ? 'full upload'
                  : null,
            videoTitle: e.projectTitle,
            projectId: e.projectId,
            assignmentId: e.assignmentId,
            scheduleItemId: e.scheduleItemId,
            timestamp: e.timestamp,
            summary: null,
          }),
        ),
      )
      .catch(() => [] as VoiceoverItem[]);

    const [a, b] = await Promise.all([elevenlabsPromise, libraryPromise]);
    // Dedupe on audioUrl — if the same blob URL shows up under both sources
    // (rare, but possible if a narrator approval was also logged to history)
    // we keep the first occurrence, which preserves source ordering.
    const seen = new Set<string>();
    const merged: VoiceoverItem[] = [];
    for (const item of [...a, ...b].sort((x, y) => y.timestamp - x.timestamp)) {
      if (!item.audioUrl || seen.has(item.audioUrl)) continue;
      seen.add(item.audioUrl);
      merged.push(item);
    }
    console.info(`[${logNamespace}] loaded`, {
      elCount: a.length,
      libCount: b.length,
      mergedCount: merged.length,
    });
    return merged;
  }, [logNamespace]);

  // Initial load — fetch both sources in parallel and merge. Failures on
  // one source don't block the other; an offline media_assets call still
  // shows the user's ElevenLabs history and vice versa.
  useEffect(() => {
    let cancelled = false;
    loadVoiceovers()
      .then((merged) => {
        if (cancelled) return;
        setItems(merged);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [loadVoiceovers]);

  // Auto-match — re-runs when matching context changes. Skips silently
  // once the user has clicked something to avoid clobbering their choice.
  const titleKey = titleCandidates.filter(Boolean).join('||');
  useEffect(() => {
    if (!loaded || userTouchedRef.current) return;
    const match = pickBestVoiceover(items, scheduleItemId, projectId, titleCandidates);
    if (match?.audioUrl && match.audioUrl !== value) {
      const signal = describeMatchSignal(match, scheduleItemId, projectId, titleCandidates);
      // Don't fire auto-match when nothing actually matched — only the
      // "recent" fallback. The user shouldn't be surprised by a random
      // recent voiceover landing on a fresh project.
      if (signal !== 'recent') {
        console.info(`[${logNamespace}] auto-matched`, {
          source: match.source,
          signal,
          narratorName: match.voiceName,
        });
        onChange(match.audioUrl, 'auto');
        setAutoMatchedId(match.id);
      } else {
        setAutoMatchedId(match.id);
      }
    } else if (match?.id) {
      setAutoMatchedId(match.id);
    }
    // titleCandidates is captured via titleKey; suppress exhaustive-deps for
    // the array identity warning that doesn't reflect a real dependency change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, items, scheduleItemId, projectId, titleKey, value, logNamespace]);

  // Stop preview audio if the picker unmounts or the popover closes.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  function togglePreview(item: VoiceoverItem) {
    if (!item.audioUrl) return;
    if (playingIdRef.current === item.id && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      playingIdRef.current = null;
      setPlayingId(null);
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const audio = new Audio(item.audioUrl);
    audio.onended = () => {
      if (playingIdRef.current === item.id) {
        playingIdRef.current = null;
        setPlayingId(null);
      }
    };
    audio.onerror = () => {
      playingIdRef.current = null;
      setPlayingId(null);
      toast.error('Could not play preview');
    };
    audioRef.current = audio;
    playingIdRef.current = item.id;
    setPlayingId(item.id);
    audio.play().catch(() => {
      playingIdRef.current = null;
      setPlayingId(null);
    });
  }

  /** Stop any in-flight preview before closing the popover. Without
   *  this, clicking an item to select (or "Clear") closes the dropdown
   *  but leaves the preview audio playing in the background — the user
   *  can no longer reach the stop button because it lives inside the
   *  now-hidden popover. */
  function stopPreview() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (playingIdRef.current !== null) {
      playingIdRef.current = null;
      setPlayingId(null);
    }
  }

  function selectItem(item: VoiceoverItem) {
    userTouchedRef.current = true;
    console.info(`[${logNamespace}] manual select`, {
      source: item.source,
      narratorName: item.voiceName,
    });
    stopPreview();
    onChange(item.audioUrl, 'manual');
    setOpen(false);
  }

  function clearSelection() {
    userTouchedRef.current = true;
    stopPreview();
    onChange('', 'clear');
    setOpen(false);
  }

  /**
   * Resolve a project id for the upload / save-to-library flows. Returns
   * the existing prop when present; otherwise asks the caller via
   * `onRequireProject` to lazily create (or look up) one. The callback is
   * responsible for any user-visible "project created" feedback. Returns
   * null when no id can be obtained — the caller surfaces the toast.
   */
  async function ensureProjectId(): Promise<string | null> {
    if (projectId) return projectId;
    if (!onRequireProject) return null;
    try {
      return await onRequireProject();
    } catch (err) {
      console.error(`[${logNamespace}] onRequireProject failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Upload a voiceover audio file from the user's computer straight to R2
   * via the existing presigned-PUT path, then register it as a media_assets
   * row scoped to the current project. On success, refresh the picker list
   * and auto-select the new entry so the user is one click closer to
   * scene-sync. When `projectId` is null and `onRequireProject` is wired,
   * the caller lazily creates a draft project before upload runs.
   */
  async function handleUploadFromComputer(file: File) {
    const resolvedProjectId = await ensureProjectId();
    if (!resolvedProjectId) {
      toast.error('Open this doc from a project to upload voiceovers.');
      return;
    }
    const contentType = file.type || 'audio/mpeg';
    setUploadingFile(file.name);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const presignRes = await fetch(`/api/projects/${resolvedProjectId}/voiceover-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType }),
      });
      if (!presignRes.ok) {
        const data = await presignRes.json().catch(() => ({}));
        throw new Error(data?.error ? String(data.error) : `Presign failed (${presignRes.status})`);
      }
      const { uploadUrl, downloadUrl, r2Key, r2Bucket } = await presignRes.json();

      // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC - awaits and uses response
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`);

      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const registerRes = await fetch(`/api/projects/${resolvedProjectId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'voiceover',
          source: 'upload',
          name: file.name,
          url: downloadUrl,
          r2_bucket: r2Bucket,
          r2_key: r2Key,
          size_bytes: file.size,
        }),
      });
      if (!registerRes.ok) {
        const data = await registerRes.json().catch(() => ({}));
        throw new Error(data?.error ? String(data.error) : `Register failed (${registerRes.status})`);
      }
      const { asset } = await registerRes.json();
      console.info(`[${logNamespace}] uploaded from computer`, {
        assetId: asset?.id,
        sizeBytes: file.size,
      });

      // Refresh + auto-select the freshly-inserted asset so scene-sync can
      // pick it up immediately. The library endpoint serves voiceovers via
      // the `/api/voiceovers/<uuid>/audio` proxy, which is the URL pattern
      // the alignment gate (production-doc/page.tsx) requires.
      const merged = await loadVoiceovers();
      setItems(merged);
      const newAudioUrl = asset?.id ? `/api/voiceovers/${asset.id}/audio` : null;
      if (newAudioUrl) {
        userTouchedRef.current = true;
        onChange(newAudioUrl, 'manual');
      }
      toast.success(`Uploaded ${file.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      console.error(`[${logNamespace}] upload from computer failed`, { error: msg });
      toast.error(msg);
    } finally {
      setUploadingFile(null);
      // Reset the input so picking the same file again re-fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  /**
   * Copy a history-only voiceover into the workspace library. Server
   * downloads the audio (with SSRF guard against non-allowlisted hosts),
   * uploads to R2, inserts a media_assets row, returns its id. Then we
   * refresh + auto-select so the production-doc alignment gate flips from
   * "Alignment unavailable" to "syncing". Requires `projectId` to scope
   * the media_assets insert.
   */
  async function handleSaveToLibrary(item: VoiceoverItem) {
    if (item.source !== 'elevenlabs' || !item.audioUrl) return;
    const resolvedProjectId = await ensureProjectId();
    if (!resolvedProjectId) {
      toast.error('Open this doc from a project to save voiceovers to the library.');
      return;
    }
    // item.id is `el:<historyId>`; strip the prefix to get the raw id.
    const historyId = item.id.startsWith('el:') ? item.id.slice(3) : item.id;
    setSavingToLibraryId(item.id);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/voiceovers/save-from-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: resolvedProjectId,
          historyId,
          audioUrl: item.audioUrl,
          voiceName: item.voiceName,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ? String(data.error) : `Save failed (${res.status})`);
      }
      const { asset } = await res.json();
      console.info(`[${logNamespace}] saved to library`, {
        historyId,
        assetId: asset?.id,
      });

      const merged = await loadVoiceovers();
      setItems(merged);
      const newAudioUrl = asset?.id ? `/api/voiceovers/${asset.id}/audio` : null;
      if (newAudioUrl) {
        userTouchedRef.current = true;
        onChange(newAudioUrl, 'manual');
      }
      toast.success('Saved to library — scene sync will run automatically.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      console.error(`[${logNamespace}] save to library failed`, { error: msg });
      toast.error(msg);
    } finally {
      setSavingToLibraryId(null);
    }
  }

  const selected = items.find((i) => i.audioUrl === value) || null;
  const matchedToCurrent = selected && autoMatchedId === selected.id;

  // ─── Trigger button (collapsed state) ──────────────────────────────────
  const triggerLabel = (() => {
    if (!loaded) return 'Loading voiceovers…';
    if (selected) {
      const title = selected.videoTitle?.trim();
      return title
        ? `${selected.voiceName} · ${title}`
        : `${selected.voiceName} (${relativeVoiceoverTime(selected.timestamp)})`;
    }
    if (value) return 'External URL set';
    if (items.length === 0) return 'No voiceovers in library yet';
    return 'Select a voiceover…';
  })();

  // Top-of-popover "Upload from computer" row. Always rendered when the
  // popover is open (even during loading / empty state) so the affordance
  // is in the same spot every time. Disabled only when there's no way to
  // resolve a project (no `projectId` prop AND no `onRequireProject`
  // callback) — that's the editor-style caller; production-doc passes
  // `onRequireProject` so a fresh, unsaved doc can still upload.
  const canUpload = Boolean(projectId) || Boolean(onRequireProject);
  const uploadRow = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={!canUpload || uploadingFile !== null}
        title={
          !canUpload
            ? 'Open this doc from a project to upload voiceovers'
            : uploadingFile
              ? `Uploading ${uploadingFile}…`
              : !projectId
                ? "Upload a voiceover — we'll create a draft project for this doc on the fly"
                : 'Upload a voiceover audio file from your computer'
        }
        className="text-xs flex items-center gap-1.5 px-2 py-1 rounded"
        style={{
          background: 'rgba(168,85,247,0.14)',
          color: !canUpload || uploadingFile ? 'var(--text-muted)' : '#c084fc',
          border: '1px solid rgba(168,85,247,0.30)',
          cursor: !canUpload || uploadingFile ? 'not-allowed' : 'pointer',
          opacity: !canUpload || uploadingFile ? 0.6 : 1,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {uploadingFile ? `Uploading ${uploadingFile}…` : 'Upload from computer'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/flac,audio/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) void handleUploadFromComputer(f);
        }}
      />
      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        mp3 · wav · m4a · 50 MB max
      </span>
    </div>
  );

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="input-field text-xs"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: selected ? '#a78bfa' : 'var(--text-muted)', flexShrink: 0 }}
          >
            <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
            <path d="M21 19a2 2 0 0 1-2 2h-1v-7h3zM3 19a2 2 0 0 0 2 2h1v-7H3z" />
          </svg>
          <span
            style={{
              color: selected || value ? 'var(--text-primary)' : 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {triggerLabel}
          </span>
          {matchedToCurrent && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap"
              style={{ background: 'rgba(168,85,247,0.18)', color: '#c084fc', flexShrink: 0 }}
              title="Auto-matched to this video"
            >
              auto-matched
            </span>
          )}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{
            color: 'var(--text-muted)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
            flexShrink: 0,
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          {/* Click-outside catcher */}
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 50,
              maxHeight: 380,
              overflowY: 'auto',
              background: 'var(--bg-elevated, #181818)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
              padding: 0,
            }}
          >
            {uploadRow}
            <div style={{ padding: 4 }}>
            {!loaded ? (
              /* Skeleton rows while ElevenLabs history + library
                 fetches are in flight. Three rows match the typical
                 result density; each is sized like a real
                 voiceover entry (play button placeholder + title +
                 subtitle). */
              <div className="flex flex-col gap-1.5 px-2 py-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-start gap-2 px-1 py-1.5">
                    <Skeleton width={26} height={26} radius={13} />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton height={11} width="60%" />
                      <Skeleton height={9} width="40%" />
                    </div>
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="text-xs px-3 py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                No voiceovers yet. Record one in{' '}
                <strong style={{ color: 'var(--text-secondary)' }}>Voiceover Studio</strong> or
                assign a <strong style={{ color: 'var(--text-secondary)' }}>Narrator</strong> to a
                project.
              </div>
            ) : (
              <>
                {value && (
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="text-xs w-full text-left px-3 py-2 rounded"
                    style={{ color: '#f87171', background: 'transparent' }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    ✕ Clear voiceover (silent video)
                  </button>
                )}
                {items.map((item) => {
                  const isSelected = item.audioUrl === value;
                  const isAutoMatch = item.id === autoMatchedId;
                  const srcColor =
                    item.source === 'elevenlabs'
                      ? '#60a5fa'
                      : item.source.startsWith('narrator')
                        ? '#34d399'
                        : 'var(--text-muted)';
                  const srcBg =
                    item.source === 'elevenlabs'
                      ? 'rgba(59,130,246,0.14)'
                      : item.source.startsWith('narrator')
                        ? 'rgba(16,185,129,0.14)'
                        : 'rgba(255,255,255,0.06)';
                  return (
                    <div
                      key={item.id}
                      className="flex items-start gap-2 px-2 py-2 rounded"
                      style={{
                        background: isSelected ? 'rgba(168,85,247,0.14)' : 'transparent',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = 'transparent';
                      }}
                      onClick={() => selectItem(item)}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePreview(item);
                        }}
                        title={playingId === item.id ? 'Stop preview' : 'Play preview'}
                        style={{
                          width: 26,
                          height: 26,
                          flexShrink: 0,
                          marginTop: 2,
                          borderRadius: 13,
                          background:
                            playingId === item.id
                              ? 'rgba(168,85,247,0.25)'
                              : 'rgba(255,255,255,0.08)',
                          border: 'none',
                          color: playingId === item.id ? '#c084fc' : 'var(--text-secondary)',
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {playingId === item.id ? (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="5" width="4" height="14" rx="1" />
                            <rect x="14" y="5" width="4" height="14" rx="1" />
                          </svg>
                        ) : (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="flex items-center gap-1.5" style={{ minWidth: 0 }}>
                          <span
                            className="text-xs font-medium"
                            style={{
                              color: isSelected ? '#c084fc' : 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {item.voiceName}
                          </span>
                          <span
                            className="text-[9px] px-1 py-0.5 rounded whitespace-nowrap"
                            style={{ background: srcBg, color: srcColor }}
                          >
                            {sourceLabel(item.source)}
                          </span>
                          {item.badgeLabel && (
                            <span
                              className="text-[9px] px-1 py-0.5 rounded whitespace-nowrap"
                              style={{
                                background: 'rgba(255,255,255,0.06)',
                                color: 'var(--text-muted)',
                              }}
                            >
                              {item.badgeLabel}
                            </span>
                          )}
                          {isAutoMatch && !isSelected && (
                            <span
                              className="text-[9px] px-1 py-0.5 rounded"
                              style={{
                                background: 'rgba(168,85,247,0.18)',
                                color: '#c084fc',
                              }}
                            >
                              match
                            </span>
                          )}
                          <span
                            className="text-[10px] ml-auto whitespace-nowrap"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {relativeVoiceoverTime(item.timestamp)}
                          </span>
                        </div>
                        {item.videoTitle && (
                          <div
                            className="text-[10px] truncate"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {item.videoTitle}
                          </div>
                        )}
                        {item.summary && (
                          <div
                            className="text-[10px] truncate"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {item.summary}
                          </div>
                        )}
                      </div>
                      {/* "Save to library" — only on history-only entries
                          (source='elevenlabs'), which don't yet have a
                          media_assets row. Required for scene sync because
                          the alignment gate only accepts the
                          /api/voiceovers/<uuid>/audio URL pattern (i.e. a
                          media_assets row served via the proxy). Disabled
                          when projectId is absent (we need it to scope the
                          insert) or while another save is in flight. */}
                      {item.source === 'elevenlabs' && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleSaveToLibrary(item);
                          }}
                          disabled={!canUpload || savingToLibraryId !== null}
                          title={
                            !canUpload
                              ? 'Open this doc from a project to enable scene sync'
                              : savingToLibraryId === item.id
                                ? 'Saving…'
                                : !projectId
                                  ? "Save to workspace library — we'll create a draft project for this doc on the fly"
                                  : 'Save to workspace library (enables scene sync)'
                          }
                          className="text-[10px] px-1.5 py-1 rounded whitespace-nowrap flex-shrink-0"
                          style={{
                            background: 'rgba(52,211,153,0.14)',
                            color:
                              !canUpload || savingToLibraryId !== null
                                ? 'var(--text-muted)'
                                : '#34d399',
                            border: '1px solid rgba(52,211,153,0.30)',
                            cursor:
                              !canUpload || savingToLibraryId !== null
                                ? 'not-allowed'
                                : 'pointer',
                            opacity:
                              !canUpload || savingToLibraryId !== null ? 0.6 : 1,
                            marginTop: 2,
                          }}
                        >
                          {savingToLibraryId === item.id ? 'Saving…' : '↓ Save'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </>
            )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
