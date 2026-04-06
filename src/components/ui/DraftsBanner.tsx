'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getDrafts, deleteDraft, setActiveDraftId, type WorkflowDraft } from '@/lib/drafts';

const STEP_LABELS: Record<string, { label: string; color: string }> = {
  idea: { label: 'Idea', color: '#10b981' },
  script: { label: 'Script', color: '#7c3aed' },
  qa: { label: 'QA', color: '#f59e0b' },
  voiceover: { label: 'Voiceover', color: '#ec4899' },
  done: { label: 'Complete', color: '#10b981' },
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

interface DraftsBannerProps {
  currentStep: WorkflowDraft['step'];
  onResume: (draft: WorkflowDraft) => void;
}

export function DraftsBanner({ currentStep, onResume }: DraftsBannerProps) {
  const [drafts, setDraftsState] = useState<WorkflowDraft[]>(() => getDrafts());
  const [showAll, setShowAll] = useState(false);

  // Only show drafts relevant to the current page's step
  const relevantDrafts = drafts.filter(d => d.step === currentStep ||
    (currentStep === 'script' && d.step === 'qa') ||
    (currentStep === 'qa' && d.step === 'script')
  );

  function handleDelete(id: string) {
    deleteDraft(id);
    setDraftsState(getDrafts());
  }

  function handleResume(draft: WorkflowDraft) {
    setActiveDraftId(draft.id);
    onResume(draft);
    setShowAll(false);
  }

  if (relevantDrafts.length === 0) return null;

  return (
    <div className="mb-4">
      <button
        onClick={() => setShowAll(!showAll)}
        className="flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg w-full transition-all"
        style={{
          background: 'rgba(124,58,237,0.08)',
          border: '1px solid rgba(124,58,237,0.2)',
          color: 'var(--accent-purple-bright)',
        }}
      >
        <span>📋</span>
        <span>{relevantDrafts.length} draft{relevantDrafts.length > 1 ? 's' : ''} in progress</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto"
          style={{ transform: showAll ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <AnimatePresence>
        {showAll && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-1.5">
              {relevantDrafts.map(draft => {
                const step = STEP_LABELS[draft.step] || STEP_LABELS.script;
                return (
                  <div key={draft.id}
                    className="flex items-center gap-3 p-3 rounded-lg cursor-pointer group transition-all"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                    onClick={() => handleResume(draft)}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.4)')}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                  >
                    <span className="text-xs px-2 py-0.5 rounded-full shrink-0"
                      style={{ background: `${step.color}20`, color: step.color }}>
                      {step.label}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {draft.title}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {draft.niche} · {timeAgo(draft.updatedAt)}
                        {draft.qaScore ? ` · QA: ${draft.qaScore}/100` : ''}
                        {draft.wordCount ? ` · ${draft.wordCount} words` : ''}
                      </p>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(draft.id); }}
                      className="text-xs opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      style={{ color: '#ef4444' }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
