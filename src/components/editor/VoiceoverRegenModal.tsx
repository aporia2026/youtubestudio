'use client';

/**
 * Voiceover regeneration modal — Phase 3+ audio-retiming UI for
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * Lists ElevenLabs voices, lets the user pick one, then triggers
 * `/api/edit/:projectId/voiceover/regenerate`. The endpoint reads
 * the project's current scripts server-side (NOT from the modal),
 * generates a fresh take, mirrors to R2, and JSONB-merges the
 * result into the saved payload. Caller reloads from server on
 * success to pick up the new URL.
 *
 * Honest disclosure (rendered in the modal): the new take will
 * sound different from the original. ElevenLabs has no
 * deterministic "match the previous take" mode.
 */
import { useCallback, useEffect, useState } from 'react';

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
}

interface VoiceoverRegenModalProps {
  projectId: string;
  /** Estimated character count of the current scripts. Surfaced as
   *  a cost hint before the user commits. */
  estimatedChars: number;
  /** Pre-fill the currently-selected voice id from the project's
   *  previous regen, if known. */
  defaultVoiceId?: string;
  onClose: () => void;
  /** Called when the server commits a new voiceoverUrl. The caller
   *  is responsible for `reloadFromServer()` so the editor state
   *  picks up the merge + bumped version. */
  onSuccess: (voiceoverUrl: string) => void;
}

export function VoiceoverRegenModal({
  projectId,
  estimatedChars,
  defaultVoiceId,
  onClose,
  onSuccess,
}: VoiceoverRegenModalProps): React.ReactElement {
  const [voices, setVoices] = useState<
    | { kind: 'loading' }
    | { kind: 'loaded'; list: ElevenLabsVoice[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [selectedVoiceId, setSelectedVoiceId] = useState(defaultVoiceId ?? '');
  const [regenState, setRegenState] = useState<
    | { kind: 'idle' }
    | { kind: 'generating' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // Fetch the voices list on mount. The endpoint is workspace-
  // agnostic — voices belong to the ElevenLabs account, not the
  // workspace — so any signed-in user can list them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch('/api/elevenlabs/voices');
        if (!res.ok) throw new Error(`Voices fetch failed: HTTP ${res.status}`);
        const data = (await res.json()) as { voices?: ElevenLabsVoice[] };
        if (cancelled) return;
        const list = Array.isArray(data.voices) ? data.voices : [];
        setVoices({ kind: 'loaded', list });
        if (!selectedVoiceId && list.length > 0) {
          setSelectedVoiceId(list[0].voice_id);
        }
      } catch (err) {
        if (cancelled) return;
        setVoices({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // selectedVoiceId intentionally NOT a dep — we only want to
    // hydrate the default once; subsequent user picks shouldn't
    // re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!selectedVoiceId) return;
    setRegenState({ kind: 'generating' });
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch(`/api/edit/${encodeURIComponent(projectId)}/voiceover/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: selectedVoiceId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Regen failed: HTTP ${res.status}`);
      }
      const data = (await res.json()) as { voiceoverUrl?: string };
      if (typeof data.voiceoverUrl !== 'string') {
        throw new Error('Server response missing voiceoverUrl');
      }
      onSuccess(data.voiceoverUrl);
    } catch (err) {
      setRegenState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [onSuccess, projectId, selectedVoiceId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0, 0, 0, 0.65)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="rounded-lg border max-w-md w-full flex flex-col overflow-hidden"
        style={{ borderColor: 'var(--card-border)', background: 'var(--card-bg)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Voiceover regeneration"
      >
        <header
          className="px-5 py-4 border-b"
          style={{ borderColor: 'var(--card-border)' }}
        >
          <div className="text-sm font-semibold">Regenerate voiceover</div>
          <div className="text-[11px] mt-1" style={{ color: 'var(--fg-muted)' }}>
            Concatenates every row&apos;s script and runs a fresh ElevenLabs
            take. <strong style={{ color: '#fbbf24' }}>The new take will sound
            different</strong> from the current voiceover — no take-matching mode
            exists.
          </div>
        </header>

        <div className="p-4 space-y-3 text-xs">
          {voices.kind === 'loading' && (
            <div style={{ color: 'var(--fg-muted)' }}>Loading voices…</div>
          )}
          {voices.kind === 'error' && (
            <div style={{ color: '#f87171' }}>{voices.message}</div>
          )}
          {voices.kind === 'loaded' && (
            <label className="block space-y-1">
              <span className="font-medium" style={{ color: 'var(--fg)' }}>
                Voice
              </span>
              <select
                value={selectedVoiceId}
                onChange={(e) => setSelectedVoiceId(e.target.value)}
                className="w-full text-xs rounded border p-2"
                style={{
                  borderColor: 'var(--card-border)',
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                }}
              >
                {voices.list.map((v) => (
                  <option key={v.voice_id} value={v.voice_id}>
                    {v.name}
                    {v.category ? ` · ${v.category}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div
            className="text-[10px] p-2 rounded border"
            style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
          >
            <strong style={{ color: 'var(--fg)' }}>Estimated cost:</strong>{' '}
            ~${(estimatedChars / 1000 * 0.18).toFixed(2)}{' '}
            <span>({estimatedChars.toLocaleString()} chars at ElevenLabs Creator-tier
            pricing).</span>
          </div>

          <div
            className="text-[10px] p-2 rounded border"
            style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
          >
            Existing captions will be cleared — they&apos;re derived from audio.
            Regenerate captions from the new VO once it&apos;s ready.
          </div>

          {regenState.kind === 'error' && (
            <div className="text-[10px]" style={{ color: '#f87171' }}>
              {regenState.message}
            </div>
          )}
        </div>

        <footer
          className="px-5 py-3 border-t flex items-center justify-end gap-2"
          style={{ borderColor: 'var(--card-border)' }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={regenState.kind === 'generating'}
            className="text-xs px-3 py-1.5 rounded border hover:bg-white/5 transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--card-border)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={
              regenState.kind === 'generating' || voices.kind !== 'loaded' || !selectedVoiceId
            }
            className="text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
            style={{
              borderColor: 'var(--accent-purple-bright, #a78bfa)',
              color: 'var(--accent-purple-bright, #a78bfa)',
            }}
          >
            {regenState.kind === 'generating' ? 'Generating…' : 'Generate'}
          </button>
        </footer>
      </div>
    </div>
  );
}
