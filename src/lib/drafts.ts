// Workflow draft system — auto-saves progress across pages
// A draft tracks the full pipeline: idea → script → QA → voiceover

export interface WorkflowDraft {
  id: string;
  title: string;           // derived from topic or idea title
  niche: string;
  updatedAt: number;
  step: 'idea' | 'script' | 'qa' | 'seo' | 'thumbnails' | 'voiceover' | 'done';

  // Idea stage
  ideaTitle?: string;
  ideaHook?: string;

  // Script stage
  topic?: string;
  tone?: string;
  style?: string;
  duration?: number;
  script?: string;
  wordCount?: number;
  modelId?: string;

  // QA stage
  qaScore?: number;
  qaVerdict?: string;
  fixedScript?: string;

  // SEO stage
  seoTitle?: string;
  seoDescription?: string;

  // Thumbnails stage
  thumbnailConcept?: string;

  // Voiceover stage
  voiceoverUrl?: string;
  voiceName?: string;

  // Project
  projectId?: string;
}

const DRAFTS_KEY = 'workflow_drafts';
const ACTIVE_DRAFT_KEY = 'active_draft_id';
const MAX_DRAFTS = 20;

function generateId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getDrafts(): WorkflowDraft[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]');
  } catch { return []; }
}

export function getActiveDraftId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACTIVE_DRAFT_KEY);
}

export function getActiveDraft(): WorkflowDraft | null {
  const id = getActiveDraftId();
  if (!id) return null;
  return getDrafts().find(d => d.id === id) || null;
}

export function setActiveDraftId(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) localStorage.setItem(ACTIVE_DRAFT_KEY, id);
  else localStorage.removeItem(ACTIVE_DRAFT_KEY);
}

export function saveDraft(draft: Partial<WorkflowDraft> & { title: string; niche: string; step: WorkflowDraft['step'] }): WorkflowDraft {
  const drafts = getDrafts();
  const existingIdx = draft.id ? drafts.findIndex(d => d.id === draft.id) : -1;

  const full: WorkflowDraft = {
    ...(existingIdx >= 0 ? drafts[existingIdx] : {}),
    ...draft,
    id: draft.id || generateId(),
    updatedAt: Date.now(),
  } as WorkflowDraft;

  // Truncate script in draft storage to prevent quota issues
  if (full.script && full.script.length > 15000) {
    full.script = full.script.slice(0, 15000) + '\n\n[... truncated in draft ...]';
  }
  if (full.fixedScript && full.fixedScript.length > 15000) {
    full.fixedScript = full.fixedScript.slice(0, 15000) + '\n\n[... truncated in draft ...]';
  }

  if (existingIdx >= 0) {
    drafts[existingIdx] = full;
  } else {
    drafts.unshift(full);
  }

  if (drafts.length > MAX_DRAFTS) drafts.length = MAX_DRAFTS;

  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Quota — prune oldest
    drafts.length = Math.floor(drafts.length / 2);
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // Last resort — only save the current draft
      try { localStorage.setItem(DRAFTS_KEY, JSON.stringify([full])); } catch {}
    }
  }

  setActiveDraftId(full.id);
  return full;
}

export function deleteDraft(id: string): void {
  if (typeof window === 'undefined') return;
  const drafts = getDrafts().filter(d => d.id !== id);
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  if (getActiveDraftId() === id) setActiveDraftId(null);
}

export function clearDrafts(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(DRAFTS_KEY);
  localStorage.removeItem(ACTIVE_DRAFT_KEY);
}
