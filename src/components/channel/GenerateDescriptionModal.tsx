'use client';

/**
 * GenerateDescriptionModal — shared between the add-channel form on /channel
 * and the per-channel description editor at /channel/[id]/description. Holds
 * its own local brief / style / model state and calls the generation API.
 * Stays "controlled": it doesn't save the description itself; the parent
 * decides what to do with the result when the user clicks "Use this".
 *
 * Two call modes — pick one:
 *   - Connected (existing channel): pass `channelId`. The server pulls the
 *     channel's name, niche, notes, brand_kit from the DB so we never trust
 *     client-supplied channel data on a channel the user claims to own.
 *   - Unconnected (new channel during add): pass `channelName` (required for
 *     the prompt to have anything to anchor to), `channelNiche`,
 *     `channelNotes`. The server uses those directly. No brand kit applies
 *     yet because a brand-new channel has none.
 */

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId, getModelById } from '@/lib/ai-models';

// Styles + types live in a client-safe module because prompts.ts pulls in
// server-only dependencies via channel-brand-kit.
import {
  CHANNEL_DESCRIPTION_STYLES,
  type ChannelDescriptionStyle,
} from '@/lib/channel-description-styles';

const DEFAULT_STYLE: ChannelDescriptionStyle = 'short-bio';

export interface GenerateDescriptionResult {
  description: string;
  brief: string;
  modelId: string;
  style: ChannelDescriptionStyle;
}

interface GenerateDescriptionModalProps {
  open: boolean;
  onClose: () => void;
  /** Connected mode — existing channel. The server resolves name/niche/notes/brand_kit from the DB. */
  channelId?: string;
  /** Unconnected mode — new channel. Provide at least `channelName`. */
  channelName?: string;
  channelNiche?: string;
  channelNotes?: string;
  /** Prefilled brief — typically the one stored on the channel from a prior generation. */
  initialBrief?: string;
  /** Used to indicate "you're regenerating" in the UI copy and to show the
   *  current value alongside the new one so the user can compare. */
  currentDescription?: string;
  /** Called when the user clicks "Use this". Parent decides whether to save
   *  immediately (description page) or stash into form state (add-channel). */
  onApply: (result: GenerateDescriptionResult) => void;
}

export function GenerateDescriptionModal({
  open,
  onClose,
  channelId,
  channelName,
  channelNiche,
  channelNotes,
  initialBrief = '',
  currentDescription,
  onApply,
}: GenerateDescriptionModalProps) {
  const [brief, setBrief] = useState(initialBrief);
  const [style, setStyle] = useState<ChannelDescriptionStyle>(DEFAULT_STYLE);
  const [modelId, setModelId] = useState<string>(() =>
    getFeatureDefaultModelId('channel-description'),
  );
  const [output, setOutput] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed brief when the modal opens with a different initialBrief (e.g.
  // user navigated between channels). Tied to open so reopening always
  // refreshes from the parent's latest state.
  useEffect(() => {
    if (open) {
      setBrief(initialBrief);
      setOutput('');
      setError(null);
    }
  }, [open, initialBrief]);

  // Close on Escape — mirrors the rest of the app's modals.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const styleHint = useMemo(
    () => CHANNEL_DESCRIPTION_STYLES.find((s) => s.value === style)?.hint ?? '',
    [style],
  );

  // Validation that surfaces inline rather than waiting for the server.
  const isConnected = !!channelId;
  const canSubmit = !loading && (isConnected || (channelName && channelName.trim().length > 0));
  const disabledReason = !isConnected && !channelName?.trim()
    ? 'Add a channel name above first — the generator needs at least the channel name to write about.'
    : null;

  async function generate() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setOutput('');
    try {
      const payload: Record<string, unknown> = {
        modelId,
        style,
        brief: brief.trim(),
      };
      if (channelId) {
        payload.channelId = channelId;
      } else {
        payload.name = channelName?.trim();
        if (channelNiche?.trim()) payload.niche = channelNiche.trim();
        if (channelNotes?.trim()) payload.notes = channelNotes.trim();
      }

      const res = await fetch('/api/generate/channel-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Generation failed (${res.status})`);
      }
      setOutput(typeof data.description === 'string' ? data.description : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setLoading(false);
    }
  }

  function apply() {
    if (!output.trim()) return;
    onApply({
      description: output,
      brief: brief.trim(),
      modelId,
      style,
    });
    onClose();
  }

  const modelLabel = getModelById(modelId)?.name ?? modelId;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="glass rounded-2xl p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto"
            style={{ border: '1px solid var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                  Generate channel description
                </h2>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {isConnected
                    ? 'Pulls the channel\'s name, niche, notes, and brand kit automatically.'
                    : 'Using the channel name and niche from the form above.'}
                </p>
              </div>
              <button
                onClick={onClose}
                className="text-lg"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* Brief input */}
            <div className="mb-4">
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Brief
                <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                  What should the description say? Positioning, audience, what makes the channel different.
                </span>
              </label>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="e.g. Weekly explainers on cybersecurity for non-technical viewers. Calm voice, no fearmongering. We dig into real incidents and explain what actually happened, with diagrams."
                rows={5}
                className="w-full px-3 py-2 rounded-lg text-sm"
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  resize: 'vertical',
                }}
              />
            </div>

            {/* Style picker */}
            <div className="mb-4">
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Output style
              </label>
              <div className="flex flex-wrap gap-1.5">
                {CHANNEL_DESCRIPTION_STYLES.map((s) => {
                  const active = style === s.value;
                  return (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => setStyle(s.value)}
                      className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
                      style={{
                        background: active ? 'rgba(124,58,237,0.15)' : 'transparent',
                        color: active ? 'var(--accent-purple-bright)' : 'var(--text-muted)',
                        border: `1px solid ${active ? 'var(--accent-purple-bright)' : 'var(--border)'}`,
                      }}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
              {styleHint && (
                <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>{styleHint}</p>
              )}
            </div>

            {/* Model picker */}
            <div className="mb-4">
              <ModelSelector value={modelId} onChange={setModelId} label="AI model" />
            </div>

            {/* Generate button + status */}
            <div className="flex items-center gap-3 mb-4">
              <button
                type="button"
                onClick={generate}
                disabled={!canSubmit}
                className="btn-primary flex items-center gap-2"
                style={{ opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}
              >
                {loading ? (
                  <>
                    <div className="spinner" style={{ width: 14, height: 14 }} />
                    Generating with {modelLabel}…
                  </>
                ) : (
                  <>✨ Generate</>
                )}
              </button>
              {disabledReason && !loading && (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{disabledReason}</p>
              )}
            </div>

            {error && (
              <div
                className="mb-4 px-3 py-2 rounded-lg text-sm"
                style={{
                  background: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  color: '#fca5a5',
                }}
              >
                {error}
              </div>
            )}

            {/* Side-by-side: current (if any) and generated */}
            {(currentDescription || output) && (
              <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: currentDescription && output ? '1fr 1fr' : '1fr' }}>
                {currentDescription && (
                  <div>
                    <div className="text-xs uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
                      Current
                    </div>
                    <div
                      className="px-3 py-2 rounded-lg text-sm whitespace-pre-wrap"
                      style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                        maxHeight: 280,
                        overflowY: 'auto',
                      }}
                    >
                      {currentDescription}
                    </div>
                  </div>
                )}
                {output && (
                  <div>
                    <div className="text-xs uppercase tracking-wider mb-1.5" style={{ color: 'var(--accent-purple-bright)' }}>
                      Generated
                    </div>
                    <textarea
                      value={output}
                      onChange={(e) => setOutput(e.target.value)}
                      rows={Math.min(14, Math.max(8, output.split('\n').length + 1))}
                      className="w-full px-3 py-2 rounded-lg text-sm whitespace-pre-wrap"
                      style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--accent-purple-bright)',
                        color: 'var(--text-primary)',
                        resize: 'vertical',
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Footer actions */}
            <div className="flex items-center justify-end gap-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm"
                style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={!output.trim()}
                className="btn-primary"
                style={{ opacity: output.trim() ? 1 : 0.5, cursor: output.trim() ? 'pointer' : 'not-allowed' }}
              >
                Use this
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
